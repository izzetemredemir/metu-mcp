import type { DatabaseSync } from 'node:sqlite';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { EVENTS_70YIL_LIST_URL, KIM_EVENTS_URL, KKM_EVENTS_URL, type Lang } from '../config.js';
import { t } from '../i18n.js';
import { foldTr } from '../lib/text.js';
import { addDaysIso, todayIstanbul } from '../lib/time.js';
import { formatDate } from '../lib/trdate.js';
import { computeFreshness } from '../store/freshness.js';
import { answer, COMMON_OUTPUT, IsoDate, LangSchema, READ_ONLY, seeAlso } from './common.js';

interface EventRow {
  id: string;
  source: EventSource;
  title: string;
  organizer: string;
  start: string | null;
  end: string | null;
  venue: string;
  description: string;
  url: string;
}

const EVENT_SOURCES = ['kim', '70yil', 'kkm'] as const;
type EventSource = (typeof EVENT_SOURCES)[number];

const EventOut = z.object({
  title: z.string(),
  organizer: z.string(),
  start: z.string().nullable().describe('ISO 8601 (date-time with offset, or YYYY-MM-DD); null = date not announced'),
  end: z.string().nullable(),
  venue: z.string(),
  source: z
    .enum(EVENT_SOURCES)
    .describe('kim = student club events (Culture Office); 70yil = university events calendar; kkm = Culture and Convention Center'),
  url: z.string(),
  description: z.string(),
});

const SOURCE_URL: Record<EventSource, string> = { kim: KIM_EVENTS_URL, '70yil': EVENTS_70YIL_LIST_URL, kkm: KKM_EVENTS_URL };

function formatWhen(e: EventRow, lang: Lang): string {
  if (!e.start) return lang === 'tr' ? 'tarih açıklanmadı' : 'date not announced';
  const day = (iso: string) => formatDate(iso.slice(0, 10), lang);
  const time = (iso: string) => (iso.length > 10 ? iso.slice(11, 16) : '');
  const startDay = day(e.start);
  const endDay = e.end && e.end.slice(0, 10) !== e.start.slice(0, 10) ? day(e.end) : '';
  const span = [time(e.start), e.end ? time(e.end) : ''].filter(Boolean).join('–');
  return endDay ? `${startDay} ${time(e.start)} – ${endDay} ${e.end ? time(e.end) : ''}`.trim() : `${startDay}${span ? ` ${span}` : ''}`;
}

export function registerEventTools(server: McpServer, db: DatabaseSync): void {
  server.registerTool(
    'metu_events',
    {
      title: 'METU events',
      description:
        'Upcoming events on the METU campus: student club events published by the Culture Office (KİM: concerts, ' +
        'conferences, festivals, trips) and the university events calendar (talks, fairs such as the career fair, alumni ' +
        'meetings, hackathons) and the Culture and Convention Center (KKM) venue calendar (concerts, choirs, conferences ' +
        'in the Kemal Kurdaş hall). Defaults to the next 30 days; filter by words ("konser", "kariyer fuarı", a club name) or ' +
        'date range. Each event has date/time, venue, organizer and the official link.',
      inputSchema: z.object({
        query: z.string().max(100).optional().describe('Words in title, club/organizer, venue or description'),
        from: IsoDate.optional().describe('First day (YYYY-MM-DD, default today)'),
        to: IsoDate.optional().describe('Last day (YYYY-MM-DD, default from + 30 days)'),
        source: z.enum(EVENT_SOURCES).optional(),
        include_undated: z.boolean().default(false).describe('Also list announced events whose date is not set yet'),
        limit: z.number().int().min(1).max(30).default(15),
        lang: LangSchema,
      }),
      outputSchema: z.object({ events: z.array(EventOut), ...COMMON_OUTPUT }),
      annotations: { ...READ_ONLY, title: 'METU events' },
    },
    async ({ query, from, to, source, include_undated, limit, lang }) => {
      const start = from ?? todayIstanbul();
      const end = to ?? addDaysIso(start, 30);
      const where = [`((substr(start, 1, 10) <= ? AND substr(COALESCE(end, start), 1, 10) >= ?)${include_undated ? ' OR start IS NULL' : ''})`];
      const params: (string | number)[] = [end, start];
      if (source) {
        where.push('source = ?');
        params.push(source);
      }
      for (const w of foldTr(query ?? '').split(/\s+/).filter((x) => x.length >= 2).slice(0, 5)) {
        where.push('search_text LIKE ?');
        params.push(`%${w}%`);
      }
      const rows = db
        .prepare(
          `SELECT id, source, title, organizer, start, end, venue, description, url FROM events WHERE ${where.join(' AND ')}
           ORDER BY start IS NULL,
             -- Season-long umbrella events (e.g. "70th-anniversary sports events", Feb–Dec) go after dated ones.
             julianday(substr(COALESCE(end, start), 1, 10)) - julianday(substr(start, 1, 10)) > 14,
             start LIMIT ?`,
        )
        .all(...params, limit) as unknown as EventRow[];

      const sources = source ? [source] : EVENT_SOURCES;
      const freshness = sources.map((s) => computeFreshness(db, { kind: 'event', collector: `events:${s}`, source_url: SOURCE_URL[s] }, lang));
      const events = rows.map(({ id: _id, ...e }) => ({
        ...e,
        description: e.description.length > 500 ? `${e.description.slice(0, 499)}…` : e.description,
      }));
      const text = rows.length
        ? rows
            .map((e) => {
              const who = e.organizer ? ` — ${e.organizer}` : '';
              const where = e.venue ? ` · ${e.venue}` : '';
              return `• ${formatWhen(e, lang)}: ${e.title}${who}${where}\n  ${e.url}`;
            })
            .join('\n')
        : `${t(lang, 'no_results')} ${lang === 'tr' ? `(${start} – ${end})` : `(${start} – ${end})`}`;
      return answer({
        lang,
        text,
        data: { events },
        freshness,
        see_also: rows.length ? undefined : seeAlso(db, { query: 'etkinlik event topluluk club', limit: 2 }, lang),
      });
    },
  );
}
