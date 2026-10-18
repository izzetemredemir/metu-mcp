import * as cheerio from 'cheerio';
import {
  EVENTS_70YIL_LIST_URL,
  EVENTS_70YIL_MAX_NEW,
  EVENTS_70YIL_MAX_PAGES,
  EVENTS_70YIL_RECHECKS,
  KIM_EVENTS_URL,
  KKM_YEAR_URL,
} from '../config.js';
import { cleanText, htmlToText, safeUrl } from '../lib/sanitize.js';
import { foldTr } from '../lib/text.js';
import { now, todayIstanbul } from '../lib/time.js';
import { parseTrDateRange } from '../lib/trdate.js';
import { transaction } from '../store/db.js';
import { politeFetch } from './http.js';
import { runUnit, type CollectorContext } from './runner.js';

/** One campus event. Times are ISO 8601 with offset; date-only events use `YYYY-MM-DD`. */
export interface CampusEvent {
  id: string;
  source: 'kim' | '70yil' | 'kkm';
  title: string;
  organizer: string;
  start: string | null;
  end: string | null;
  venue: string;
  description: string;
  url: string;
}

const hm = (s: string) => s.replace('.', ':').padStart(5, '0');

/**
 * kim.metu.edu.tr/tr/etkinlikler is one hand-edited body: a bold paragraph per club, then lines like
 * `2-3 EKİM 2026 20:00-22:00 / ETKİNLİK: "OYUN NASIL OYNANMALI?" / YER: MİMARLIK AMFİSİ`.
 */
export function parseKimEvents(html: string, pageUrl: string): CampusEvent[] {
  const $ = cheerio.load(html);
  const out: CampusEvent[] = [];
  let club = '';
  $('.field--name-body p').each((_, p) => {
    const text = cleanText($(p).text().replace(/\s+/g, ' '), 600);
    if (!text) return;
    const m = /^(.*?)\s*\/\s*ETK[İI]NL[İI]K\s*:\s*(.*?)\s*\/\s*YER\s*:\s*(.*)$/i.exec(text);
    if (!m) {
      // A bold-only paragraph names the club for the following lines.
      if ($(p).find('strong').text().trim() === $(p).text().trim()) club = text;
      return;
    }
    const [, when, rawTitle, venue] = m as unknown as [string, string, string, string];
    const time = /(\d{1,2}[:.]\d{2})\s*(?:-\s*(\d{1,2}[:.]\d{2}))?/.exec(when);
    const range = parseTrDateRange(time ? when.replace(time[0], ' ') : when, now().getFullYear());
    const title = rawTitle.replace(/^["“”']+|["“”']+$/g, '').trim();
    const start = range ? (time ? `${range.start}T${hm(time[1]!)}:00+03:00` : range.start) : null;
    const end = range ? (time?.[2] ? `${range.end}T${hm(time[2])}:00+03:00` : range.end) : null;
    out.push({
      id: `kim:${foldTr(`${club} ${title} ${range?.start ?? when}`).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`,
      source: 'kim',
      title,
      organizer: club,
      start,
      end,
      venue: cleanText(venue, 200),
      description: text,
      url: pageUrl,
    });
  });
  return out;
}

/**
 * Year view of the KKM venue calendar: one `.views-row` per event with `span[content]` (ISO start with offset), the
 * title link to `/etkinlik/<slug>` and the hall after the map-marker icon.
 */
export function parseKkmYear(html: string, baseUrl: string): CampusEvent[] {
  const $ = cheerio.load(html);
  const out: CampusEvent[] = [];
  $('.view-event-calendar .view-content .views-row').each((_, row) => {
    const r = $(row);
    const a = r.find('.event-detail a[href]').first();
    const url = safeUrl(a.attr('href'), baseUrl);
    const title = cleanText(a.text(), 300);
    const iso = r.find('.data-box [content]').first().attr('content');
    if (!url || !title || !iso) return;
    const start = Number.isNaN(new Date(iso).getTime()) ? null : iso;
    out.push({
      id: `kkm:${new URL(url).pathname.split('/').filter(Boolean).pop()}:${iso.slice(0, 10)}`,
      source: 'kkm',
      title,
      organizer: '',
      start,
      end: null,
      venue: cleanText(r.find('.fa-map-marker').parent().text(), 200),
      description: '',
      url,
    });
  });
  return out;
}

/** Event links on a 70yil.metu.edu.tr list page (`.views-row h5.card-title a`). */
export function parse70yilList(html: string, baseUrl: string): { url: string; title: string; teaser: string }[] {
  const $ = cheerio.load(html);
  const out: { url: string; title: string; teaser: string }[] = [];
  $('.view-content .views-row').each((_, row) => {
    const a = $(row).find('.card-title a').first();
    const url = safeUrl(a.attr('href'), baseUrl);
    const title = cleanText(a.text(), 300);
    if (url && title) out.push({ url, title, teaser: cleanText($(row).find('.card-text').text(), 600) });
  });
  return out;
}

/** The contact field holds "Unit name e-mail phone website"; keep the name only. */
export function organizerName(contact: string): string {
  const cut = contact.search(/\s(\S+@\S+|\+?\(?\d[\d\s()]{6,}|(https?:\/\/)?[\w.-]+\.(edu|com|org|gov)(\.tr)?\b)/i);
  return (cut >= 0 ? contact.slice(0, cut) : contact).trim();
}

/** A 70yil event page: Drupal 7 date fields carry machine-readable `content="…T…+03:00"` start/end. */
export function parse70yilEvent(html: string, url: string, fallbackTitle: string): CampusEvent {
  const $ = cheerio.load(html);
  const dates = $('.field-name-field-start-and-end-dates [content]')
    .map((_, el) => $(el).attr('content'))
    .get()
    .filter((d): d is string => /^\d{4}-\d{2}-\d{2}T/.test(d));
  const field = (name: string) => cleanText($(`.field-name-${name} .field-items`).first().text().replace(/\s+/g, ' '), 300);
  const venue = [field('field-address'), field('field-lokasyon').replace(/Latlong:.*$/i, '').trim()].find(Boolean) ?? '';
  const body = $('.field-name-body .field-items').first().html() ?? '';
  const slug = new URL(url).pathname.replace(/^\/(tr|en)\//, '');
  return {
    id: `70yil:${slug}`,
    source: '70yil',
    title: cleanText($('h1').first().text(), 300) || fallbackTitle,
    organizer: organizerName(field('field-etkinlik-iletisim')),
    start: dates[0] ?? null,
    end: dates[1] ?? dates[0] ?? null,
    venue,
    description: cleanText(htmlToText(body, 3000), 3000),
    url,
  };
}

function save(ctx: CollectorContext, events: CampusEvent[], replaceSource?: CampusEvent['source']): void {
  const ts = now().toISOString();
  transaction(ctx.db, () => {
    if (replaceSource) ctx.db.prepare('DELETE FROM events WHERE source = ?').run(replaceSource);
    const ins = ctx.db.prepare(
      `INSERT INTO events (id, source, title, organizer, start, end, venue, description, url, search_text, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET title = excluded.title, organizer = excluded.organizer, start = excluded.start,
         end = excluded.end, venue = excluded.venue, description = excluded.description, url = excluded.url,
         search_text = excluded.search_text, fetched_at = excluded.fetched_at`,
    );
    for (const e of events) {
      ins.run(e.id, e.source, e.title, e.organizer, e.start, e.end, e.venue, e.description, e.url,
        foldTr(`${e.title} ${e.organizer} ${e.venue} ${e.description}`), ts);
    }
  });
}

/** Daily: club events (KİM), the 70th-anniversary university events calendar and the KKM venue calendar. */
export async function collectEvents(ctx: CollectorContext): Promise<void> {
  await runUnit(ctx, 'events:kim', async () => {
    const res = await politeFetch(ctx.db, KIM_EVENTS_URL);
    const events = parseKimEvents(res.body, KIM_EVENTS_URL);
    // An empty list is valid between terms; only a missing body means the layout changed.
    if (events.length === 0 && cheerio.load(res.body)('.field--name-body').length === 0) {
      throw new Error('KİM events body not found (layout change?)');
    }
    save(ctx, events, 'kim');
    return events.length;
  });

  await runUnit(ctx, 'events:70yil', async () => {
    const listed: ReturnType<typeof parse70yilList> = [];
    for (let page = 0; page < EVENTS_70YIL_MAX_PAGES; page++) {
      const url = page === 0 ? EVENTS_70YIL_LIST_URL : `${EVENTS_70YIL_LIST_URL}?page=${page}`;
      let body: string;
      try {
        body = (await politeFetch(ctx.db, url)).body;
      } catch (err) {
        // Only the first list page is required; later pages are a bonus.
        if (page === 0) throw err;
        ctx.log(`[events:70yil] ${url} skipped: ${(err as Error).message}`);
        break;
      }
      const items = parse70yilList(body, EVENTS_70YIL_LIST_URL);
      if (items.length === 0) break;
      listed.push(...items);
    }
    if (listed.length === 0) throw new Error('no events parsed from the 70yil list (layout change?)');
    // Detail pages (crawl-delay 10 s): the list is not chronological, so every unseen event is fetched (new ones may be
    // next week's), plus the least recently checked known ones to pick up date or venue changes.
    const seen = new Map(
      (ctx.db.prepare(`SELECT url, fetched_at FROM events WHERE source = '70yil'`).all() as { url: string; fetched_at: string }[]).map(
        (r) => [r.url, r.fetched_at],
      ),
    );
    const unseen = listed.filter((i) => !seen.has(i.url)).slice(0, EVENTS_70YIL_MAX_NEW);
    const recheck = listed
      .filter((i) => seen.has(i.url))
      .sort((a, b) => seen.get(a.url)!.localeCompare(seen.get(b.url)!))
      .slice(0, EVENTS_70YIL_RECHECKS);
    const queue = [...unseen, ...recheck];
    const events: CampusEvent[] = [];
    for (const item of queue) {
      try {
        const ev = parse70yilEvent((await politeFetch(ctx.db, item.url)).body, item.url, item.title);
        events.push({ ...ev, description: ev.description || item.teaser });
      } catch (err) {
        ctx.log(`[events:70yil] ${item.url}: ${(err as Error).message}`);
      }
    }
    save(ctx, events);
    return events.length;
  });

  await runUnit(ctx, 'events:kkm', async () => {
    const year = Number(todayIstanbul().slice(0, 4));
    const events: CampusEvent[] = [];
    for (const y of [year, year + 1]) {
      const url = `${KKM_YEAR_URL}${y}`;
      const body = (await politeFetch(ctx.db, url)).body;
      // A year without events is valid; a missing calendar view means the layout changed.
      if (cheerio.load(body)('.view-event-calendar').length === 0) throw new Error(`KKM calendar view not found on ${url}`);
      events.push(...parseKkmYear(body, url));
    }
    save(ctx, events, 'kkm');
    return events.length;
  });
}
