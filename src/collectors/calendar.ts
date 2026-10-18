import * as cheerio from 'cheerio';
import type { DatabaseSync } from 'node:sqlite';
import { CALENDAR_INDEX_URLS, LANGS, type Lang } from '../config.js';
import { cleanText, safeUrl } from '../lib/sanitize.js';
import { foldTr } from '../lib/text.js';
import { now, todayIstanbul } from '../lib/time.js';
import { parseTrDateRange } from '../lib/trdate.js';
import { transaction } from '../store/db.js';
import { upsertRecord, type LocalizedSummary, type RecordInput, type StoredRecord } from '../store/records.js';
import { extractPage } from './extract.js';
import { politeFetch } from './http.js';
import { runUnit, type CollectorContext } from './runner.js';

export const CALENDAR_SOURCE = 'oidb-calendar';

export interface CalendarEvent {
  term: 'fall' | 'spring-summer';
  start: string;
  end: string;
  precision: 'day' | 'month';
  date_text: string;
  title: string;
  detail: string;
  tags: string[];
}

/** Keyword rules (folded Turkish) → event tags used for filtering ("when is add-drop?"). */
const TAG_RULES: [string, RegExp][] = [
  ['add-drop', /ders ekleme|ekle\s*-?\s*sil|ekleme\s*-\s*birakma|add\s*[-/]?\s*drop/],
  ['registration', /kayit(lar)?\b|kayit yenileme|etkilesimli kayit|registration/],
  ['classes-start', /derslerin baslamasi|(classes|courses) (begin|start)|beginning of classes/],
  ['classes-end', /derslerin son gunu|last day of classes/],
  ['final-exams', /donem sonu sinavlari|yaz okulu sonu sinavlari|final exam/],
  ['grades', /not(larinin)? (giris|ilan|verilmesi)|notlarinin|not girisi|incomplete|butunleme|grade|resit/],
  ['withdrawal', /dersten cekilme|withdraw/],
  ['holiday', /bayram|tatil|anma gunu|egemenlik|demokrasi ve milli birlik|emek ve dayanisma|yeni yil|holiday|commemoration|sovereignty|victory day|republic day|new year|labou?r and solidarity|democracy and national unity/],
  ['tuition', /katki payi|ogrenim ucreti|tuition|fee/],
  ['graduate', /lisansustu|doktora|\btez\b|tezli|(?<!under)graduate|thesis|phd|doctoral|qualifying/],
  ['english-exam', /ingilizce yeterlik|seviye tespit|temel ingilizce|english proficiency|placement exam|preparatory|basic english/],
  ['exchange', /erasmus|degisim|hareketlilik|exchange|mobility/],
  ['transfer', /yatay gecis|cift anadal|yandal|transfer|double major|minor/],
  ['graduation', /diploma toreni|mezun|graduation|diploma|alumni/],
  ['special-student', /ozel ogrenci|special student/],
];

export function tagEvent(text: string): string[] {
  const f = foldTr(text);
  return TAG_RULES.filter(([, re]) => re.test(f)).map(([tag]) => tag);
}

/** Parses the single calendar table of an academic-year page. */
export function parseCalendarTable(html: string, academicYear: string): CalendarEvent[] {
  const $ = cheerio.load(html);
  const table = $('table').first();
  const fallbackYear = Number(academicYear.slice(0, 4));
  const events: CalendarEvent[] = [];
  let term: CalendarEvent['term'] = 'fall';
  table.find('tr').each((_, tr) => {
    const cells = $(tr).children('td, th');
    if (cells.length === 1) {
      const heading = foldTr(cleanText(cells.first().text()));
      if (/bahar|yaz okulu|spring|summer/.test(heading)) term = 'spring-summer';
      else if (/guz|fall|autumn/.test(heading)) term = 'fall';
      return;
    }
    if (cells.length < 2) return;
    const dateText = cleanText(cells.eq(0).text(), 120);
    const detailCell = cells.eq(1);
    const paragraphs = detailCell
      .find('p')
      .map((__, p) => cleanText($(p).text(), 600))
      .get()
      .filter((t) => t.length > 0);
    const lines = paragraphs.length > 0 ? paragraphs : [cleanText(detailCell.text(), 1200)];
    const title = lines[0] ?? '';
    if (!dateText || !title) return;
    const range = parseTrDateRange(dateText, fallbackYear);
    if (!range) return;
    events.push({
      term,
      start: range.start,
      end: range.end,
      precision: range.precision,
      date_text: dateText,
      title,
      detail: lines.slice(1).join('\n'),
      // Tag by the title; the detail text often mentions unrelated groups ("yeni kayıt …").
      tags: tagEvent(title).length ? tagEvent(title) : tagEvent(lines.join(' ')),
    });
  });
  return events;
}

/** Finds academic-year calendar pages linked from an index, e.g. …-2026-2027-akademik-takvim / …-2026-2027-academic-year-calendar. */
export function findYearPages(indexHtml: string, indexUrl: string): { year: string; url: string }[] {
  const $ = cheerio.load(indexHtml);
  const found = new Map<string, string>();
  $('a[href]').each((_, a) => {
    const href = $(a).attr('href') ?? '';
    const m = /(\d{4})-(\d{4})-(akademik-takvim|academic-year-calendar)/.exec(href);
    if (!m || Number(m[2]) !== Number(m[1]) + 1) return;
    const url = safeUrl(href, indexUrl);
    if (url) found.set(`${m[1]}-${m[2]}`, url.replace(/^http:/, 'https:'));
  });
  return [...found.entries()].map(([year, url]) => ({ year, url })).sort((a, b) => a.year.localeCompare(b.year));
}

/** Academic year that contains `date` (a year starts in August: registrations begin then). */
export function academicYearOf(date: string): string {
  const [y, m] = date.split('-').map(Number) as [number, number];
  const start = m >= 8 ? y : y - 1;
  return `${start}-${start + 1}`;
}

const eventKey = (e: CalendarEvent, idx: number) => `${e.term}|${e.title}|${idx}`;

function keyed(events: CalendarEvent[]): Map<string, CalendarEvent> {
  const counts = new Map<string, number>();
  const out = new Map<string, CalendarEvent>();
  for (const e of events) {
    const base = `${e.term}|${e.title}`;
    const n = counts.get(base) ?? 0;
    counts.set(base, n + 1);
    out.set(eventKey(e, n), e);
  }
  return out;
}

/** Human-readable diff between two calendar versions (both languages): moved dates, added and removed events. */
export function summarizeCalendarChange(oldRec: StoredRecord, next: RecordInput): LocalizedSummary {
  const oldEvents = keyed((JSON.parse(oldRec.data ?? '{"events":[]}') as { events: CalendarEvent[] }).events);
  const newEvents = keyed((next.data as { events: CalendarEvent[] }).events);
  const en: string[] = [];
  const tr: string[] = [];
  for (const [k, e] of newEvents) {
    const o = oldEvents.get(k);
    if (!o) {
      en.push(`Added: "${e.title}" (${e.date_text})`);
      tr.push(`Eklendi: "${e.title}" (${e.date_text})`);
    } else if (o.date_text !== e.date_text) {
      en.push(`Date changed: "${e.title}": ${o.date_text} → ${e.date_text}`);
      tr.push(`Tarih değişti: "${e.title}": ${o.date_text} → ${e.date_text}`);
    }
  }
  for (const [k, o] of oldEvents) {
    if (!newEvents.has(k)) {
      en.push(`Removed: "${o.title}" (${o.date_text})`);
      tr.push(`Kaldırıldı: "${o.title}" (${o.date_text})`);
    }
  }
  if (en.length === 0) {
    return { en: 'Calendar text updated (no date changes detected).', tr: 'Takvim metni güncellendi (tarih değişikliği yok).' };
  }
  const join = (l: string[], more: string) => l.slice(0, 8).join('; ') + (l.length > 8 ? ` (+${l.length - 8} ${more})` : '');
  return { en: join(en, 'more'), tr: join(tr, 'değişiklik daha') };
}

function storeEvents(db: DatabaseSync, year: string, lang: Lang, events: CalendarEvent[]): void {
  transaction(db, () => {
    db.prepare('DELETE FROM calendar_events WHERE academic_year = ? AND lang = ?').run(year, lang);
    const ins = db.prepare(
      `INSERT INTO calendar_events (academic_year, lang, term, start_date, end_date, precision, date_text, title, detail, tags, search_text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const e of events) {
      ins.run(year, lang, e.term, e.start, e.end, e.precision, e.date_text, e.title, e.detail, e.tags.join(','),
        foldTr(`${e.title} ${e.detail} ${e.tags.join(' ')}`));
    }
  });
}

const CALENDAR_TITLES: Record<Lang, (y: string) => string> = {
  tr: (y) => `ODTÜ Ankara ve Erdemli kampüsleri ${y} akademik takvimi`,
  en: (y) => `METU Ankara & Erdemli campuses ${y} academic calendar`,
};

async function collectCalendarLang(ctx: CollectorContext, lang: Lang): Promise<number> {
  const indexUrl = CALENDAR_INDEX_URLS[lang];
  const index = await politeFetch(ctx.db, indexUrl);
  const years = findYearPages(index.body, indexUrl);
  if (years.length === 0) throw new Error(`no academic-year calendar links found on ${indexUrl}`);
  const current = academicYearOf(todayIstanbul(now()));
  const wanted = years.filter((y) => y.year >= current);
  const targets = wanted.length > 0 ? wanted : years.slice(-1);
  let total = 0;
  for (const { year, url } of targets) {
    const res = await politeFetch(ctx.db, url);
    const events = parseCalendarTable(res.body, year);
    if (events.length < 10) throw new Error(`calendar ${year} (${lang}): only ${events.length} events parsed (layout change?)`);
    const page = extractPage(res.body, 1000);
    upsertRecord(
      ctx.db,
      {
        id: `calendar:${year}:${lang}`,
        kind: 'calendar',
        source: CALENDAR_SOURCE,
        lang,
        title: CALENDAR_TITLES[lang](year),
        body: events.map((e) => `${e.date_text} | ${e.title}`).join('\n'),
        url,
        data: { academic_year: year, events },
        source_updated_at: page.updatedAt,
        valid_for: year,
      },
      summarizeCalendarChange,
    );
    storeEvents(ctx.db, year, lang, events);
    total += events.length;
  }
  return total;
}

export async function collectCalendar(ctx: CollectorContext): Promise<void> {
  for (const lang of LANGS) {
    await runUnit(ctx, `calendar:${lang}`, () => collectCalendarLang(ctx, lang));
  }
}
