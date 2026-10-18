import type { DatabaseSync } from 'node:sqlite';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { Lang } from '../config.js';
import { academicYearOf, tagEvent } from '../collectors/calendar.js';
import { t } from '../i18n.js';
import { foldTr } from '../lib/text.js';
import { addDaysIso, now, todayIstanbul } from '../lib/time.js';
import { formatRange } from '../lib/trdate.js';
import { getRecord } from '../store/records.js';
import { answer, COMMON_OUTPUT, IsoDate, LangSchema, READ_ONLY, recordFreshness, seeAlso } from './common.js';
import type { Freshness } from '../store/freshness.js';

export const CALENDAR_TAGS = [
  'add-drop', 'registration', 'classes-start', 'classes-end', 'final-exams', 'grades', 'withdrawal', 'holiday',
  'tuition', 'graduate', 'english-exam', 'exchange', 'transfer', 'graduation', 'special-student',
] as const;

const EventOut = z.object({
  start: z.string(),
  end: z.string(),
  date_precision: z.enum(['day', 'month']).describe('"month" = METU has not announced the exact day yet'),
  when: z.string().describe('Human-readable date range'),
  date_text: z.string().describe('Date exactly as printed in the official calendar'),
  title: z.string(),
  detail: z.string(),
  term: z.enum(['fall', 'spring-summer']),
  tags: z.array(z.string()),
  academic_year: z.string(),
  lang: z.enum(['tr', 'en']),
});
type EventOutT = z.infer<typeof EventOut>;

interface EventRow {
  academic_year: string;
  lang: Lang;
  term: 'fall' | 'spring-summer';
  start_date: string;
  end_date: string;
  precision: 'day' | 'month';
  date_text: string;
  title: string;
  detail: string;
  tags: string;
}

export interface EventQuery {
  query?: string;
  tag?: string;
  from?: string;
  to?: string;
  academic_year?: string;
  limit: number;
}

/** Queries stored calendar events; falls back to the other language when the requested one has no data. */
export function queryEvents(db: DatabaseSync, q: EventQuery, lang: Lang): { rows: EventRow[]; usedLang: Lang; total: number } {
  for (const l of lang === 'en' ? (['en', 'tr'] as Lang[]) : (['tr', 'en'] as Lang[])) {
    const where = ['lang = ?'];
    const params: (string | number)[] = [l];
    if (q.academic_year) {
      where.push('academic_year = ?');
      params.push(q.academic_year);
    }
    if (q.from) {
      where.push('end_date >= ?');
      params.push(q.from);
    }
    if (q.to) {
      where.push('start_date <= ?');
      params.push(q.to);
    }
    if (q.tag) {
      where.push("(',' || tags || ',') LIKE ?");
      params.push(`%,${q.tag},%`);
    }
    for (const tok of foldTr(q.query ?? '').split(/[^\p{L}\p{N}]+/u).filter((x) => x.length >= 2).slice(0, 8)) {
      where.push('search_text LIKE ?');
      params.push(`%${tok}%`);
    }
    const hasAny = db.prepare('SELECT 1 FROM calendar_events WHERE lang = ? LIMIT 1').get(l);
    if (!hasAny) continue;
    const sql = `FROM calendar_events WHERE ${where.join(' AND ')}`;
    const total = (db.prepare(`SELECT COUNT(*) AS n ${sql}`).get(...params) as { n: number }).n;
    const rows = db
      .prepare(`SELECT academic_year, lang, term, start_date, end_date, precision, date_text, title, detail, tags ${sql} ORDER BY start_date, id LIMIT ?`)
      .all(...params, q.limit) as unknown as EventRow[];
    return { rows, usedLang: l, total };
  }
  return { rows: [], usedLang: lang, total: 0 };
}

export function toOut(r: EventRow, lang: Lang): EventOutT {
  return {
    start: r.start_date,
    end: r.end_date,
    date_precision: r.precision,
    when: formatRange(r.start_date, r.end_date, r.precision, lang),
    date_text: r.date_text,
    title: r.title,
    detail: r.detail,
    term: r.term,
    tags: r.tags ? r.tags.split(',') : [],
    academic_year: r.academic_year,
    lang: r.lang ?? lang,
  };
}

export function calendarFreshness(db: DatabaseSync, years: string[], lang: Lang): Freshness[] {
  const out: Freshness[] = [];
  for (const y of years) {
    const rec = getRecord(db, `calendar:${y}:${lang}`) ?? getRecord(db, `calendar:${y}:tr`);
    if (rec) out.push(recordFreshness(db, rec, `calendar:${rec.lang}`, lang));
  }
  return out;
}

function render(events: EventOutT[], lang: Lang, usedLang: Lang, total: number): string {
  if (events.length === 0) return t(lang, 'no_results');
  const lines = events.map((e) => `• ${e.when} — ${e.title}${e.detail ? `\n  ${e.detail.split('\n').slice(0, 2).join(' ')}` : ''}`);
  if (usedLang !== lang) lines.unshift(t(lang, 'fallback_lang'));
  if (total > events.length) lines.push(t(lang, 'more_results', { n: total - events.length, offset: events.length }).replace(/;.*$/, '.'));
  return lines.join('\n');
}

export function registerCalendarTools(server: McpServer, db: DatabaseSync): void {
  server.registerTool(
    'metu_calendar_events',
    {
      title: 'METU academic calendar',
      description:
        'Searches the official METU academic calendar (Ankara & Erdemli campuses): registration, add-drop ("ekle-sil"), ' +
        'course withdrawal, start/end of classes, final exams, grade deadlines, holidays, tuition payment, graduate ' +
        'application periods, English proficiency exams. Filter by free text, tag and/or date range. Without any filter ' +
        'it returns events of the next 60 days. Dates marked precision "month" are not fixed yet by METU.',
      inputSchema: z.object({
        query: z.string().max(200).optional().describe('Free text, e.g. "ekle-sil", "final", "bayram", "lisansüstü başvuru"'),
        tag: z.enum(CALENDAR_TAGS).optional().describe('Event category'),
        from: IsoDate.optional().describe('Events ending on/after this date'),
        to: IsoDate.optional().describe('Events starting on/before this date'),
        academic_year: z.string().regex(/^\d{4}-\d{4}$/).optional().describe('e.g. "2026-2027"'),
        limit: z.number().int().min(1).max(60).default(20),
        lang: LangSchema,
      }),
      outputSchema: z.object({ events: z.array(EventOut), total: z.number(), ...COMMON_OUTPUT }),
      annotations: { ...READ_ONLY, title: 'METU academic calendar' },
    },
    async ({ query, tag, from, to, academic_year, limit, lang }) => {
      const today = todayIstanbul(now());
      const noFilter = !query && !tag && !from && !to && !academic_year;
      const q: EventQuery = noFilter ? { from: today, to: addDaysIso(today, 60), limit } : { query, tag, from, to, academic_year, limit };
      // "ekle-sil", "final", "bayram" … are phrased differently in the calendar: prefer the matching tag,
      // fall back to plain text search when the tag finds nothing.
      const inferred = query && !tag ? tagEvent(query) : [];
      const attempts: EventQuery[] = inferred.length
        ? [{ ...q, tag: inferred[0] }, { ...q, query: undefined, tag: inferred[0] }, q]
        : [q];
      let result = queryEvents(db, attempts[0]!, lang);
      for (const a of attempts.slice(1)) {
        if (result.rows.length > 0) break;
        result = queryEvents(db, a, lang);
      }
      const { rows, usedLang, total } = result;
      const events = rows.map((r) => toOut(r, lang));
      const years = [...new Set(events.map((e) => e.academic_year))];
      if (years.length === 0) years.push(academicYearOf(today));
      return answer({
        lang,
        text: render(events, lang, usedLang, total),
        data: { events, total },
        freshness: calendarFreshness(db, years, usedLang),
        see_also: events.length ? undefined : seeAlso(db, { query: 'akademik takvim academic calendar', category: 'calendar' }, lang),
      });
    },
  );

  server.registerTool(
    'metu_calendar_next',
    {
      title: 'Upcoming METU deadlines',
      description:
        'Upcoming academic-calendar events from today, e.g. "what deadlines are coming up?", "when is the next holiday?". ' +
        'Optionally restricted to one tag (add-drop, final-exams, holiday, tuition, registration, withdrawal, ...).',
      inputSchema: z.object({
        tag: z.enum(CALENDAR_TAGS).optional(),
        days: z.number().int().min(1).max(365).default(30).describe('Look-ahead window in days'),
        limit: z.number().int().min(1).max(30).default(10),
        lang: LangSchema,
      }),
      outputSchema: z.object({ events: z.array(EventOut), total: z.number(), ...COMMON_OUTPUT }),
      annotations: { ...READ_ONLY, title: 'Upcoming METU deadlines' },
    },
    async ({ tag, days, limit, lang }) => {
      const today = todayIstanbul(now());
      const { rows, usedLang, total } = queryEvents(db, { tag, from: today, to: addDaysIso(today, days), limit }, lang);
      const events = rows.map((r) => toOut(r, lang));
      const years = [...new Set(events.map((e) => e.academic_year))];
      if (years.length === 0) years.push(academicYearOf(today));
      return answer({
        lang,
        text: render(events, lang, usedLang, total),
        data: { events, total },
        freshness: calendarFreshness(db, years, usedLang),
      });
    },
  );
}
