import type { DatabaseSync } from 'node:sqlite';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { ANNOUNCEMENT_SOURCES, type Lang } from '../config.js';
import { t } from '../i18n.js';
import { truncate } from '../lib/text.js';
import { formatDateOnly } from '../lib/time.js';
import { computeFreshness } from '../store/freshness.js';
import { listRecords, type StoredRecord } from '../store/records.js';
import { answer, COMMON_OUTPUT, IsoDate, LangSchema, READ_ONLY, seeAlso } from './common.js';

const SOURCE_IDS = ANNOUNCEMENT_SOURCES.map((s) => s.id) as [string, ...string[]];
const CATEGORIES = [...new Set(ANNOUNCEMENT_SOURCES.map((s) => s.category))] as [string, ...string[]];

const AnnouncementOut = z.object({
  title: z.string(),
  url: z.string(),
  source: z.string(),
  source_name: z.string(),
  lang: z.enum(['tr', 'en']),
  published_at: z.string().nullable(),
  summary: z.string(),
});

/**
 * Which stored language to use per source: the requested one when the source has announcements in it, otherwise the
 * one it has (the main-site RSS is Turkish only; some departments post English-only items in their Turkish list).
 */
function langFor(db: DatabaseSync, sourceId: string, lang: Lang): Lang {
  const has = (l: Lang) => db.prepare(`SELECT 1 FROM records WHERE kind = 'announcement' AND source = ? AND lang = ? LIMIT 1`).get(sourceId, l) !== undefined;
  if (has(lang)) return lang;
  const other: Lang = lang === 'tr' ? 'en' : 'tr';
  if (has(other)) return other;
  const src = ANNOUNCEMENT_SOURCES.find((s) => s.id === sourceId);
  return src?.urls[lang] ? lang : src?.urls.tr ? 'tr' : 'en';
}

export function registerAnnouncementTools(server: McpServer, db: DatabaseSync): void {
  server.registerTool(
    'metu_announcements',
    {
      title: 'METU announcements',
      description:
        'Lists and searches recent announcements from METU units: main site (metu), Registrar ÖİDB (oidb), departments ' +
        '(source = the course prefix in lower case: ceit = Computer Education & Instructional Technology/BÖTE, ceng, math, ' +
        'phys, biol, stat, hist, phil, psy, soc, econ, ba, ir, crp, id, eds, fle, ee, me, ce, ie, che, enve, fde, geoe, mine, ' +
        'pete, mete, pes, es, mus = Music and Fine Arts, arch = Faculty of Architecture), language units (mld = Modern ' +
        'Languages, ydyo = School of Foreign Languages, dbe = Basic English prep school), graduate schools and ' +
        'institutes (fbe, sbe, ii, iam = Applied Mathematics, ims = Marine Sciences), International ' +
        'Cooperations/Erasmus (ico), Computer Center (bidb), Internal Services / vehicle permits (ihm), Dormitories (yurtlar), ' +
        'Library (library), Sports directorate (sports: courses, tournaments, facility hours), Swimming pools (pools), Health ' +
        'center SRM/Medico (health), Cafeteria service notices (cafeteria), Career Planning Center job/internship/event ' +
        'postings (career), the fortnightly "Bu Hafta" bulletin split into news/events/notices (bulletin) and the Alumni ' +
        'Office (alumni). Newest first. Use `query` for topics like "af", "bütünleme", "tez teslim", "burs", "staj", "yoga"; ' +
        'departments publish their midterm, final and resit exam schedules here too (source = department, query = ' +
        '"sınav programı" or "exam schedule"); ' +
        'the search is accent-insensitive.',
      inputSchema: z.object({
        query: z.string().max(200).optional().describe('Full-text search over titles and texts (Turkish or English)'),
        source: z.enum(SOURCE_IDS).optional().describe('Only this unit'),
        category: z.enum(CATEGORIES).optional().describe('Only this kind of unit'),
        since: IsoDate.optional().describe('Only announcements published on/after this date (YYYY-MM-DD)'),
        limit: z.number().int().min(1).max(20).default(8),
        offset: z.number().int().min(0).default(0),
        response_format: z
          .enum(['concise', 'detailed'])
          .default('concise')
          .describe('"detailed" includes up to ~1500 characters of each announcement text'),
        lang: LangSchema,
      }),
      outputSchema: z.object({ announcements: z.array(AnnouncementOut), total: z.number(), ...COMMON_OUTPUT }),
      annotations: { ...READ_ONLY, title: 'METU announcements' },
    },
    async ({ query, source, category, since, limit, offset, response_format, lang }) => {
      let sources = ANNOUNCEMENT_SOURCES.filter((s) => (!source || s.id === source) && (!category || s.category === category));
      if (sources.length === 0) sources = ANNOUNCEMENT_SOURCES;
      // Query each source in its best available language, then merge by date.
      const byLang = new Map<Lang, string[]>();
      for (const s of sources) {
        const l = langFor(db, s.id, lang);
        byLang.set(l, [...(byLang.get(l) ?? []), s.id]);
      }
      let rows: StoredRecord[] = [];
      let total = 0;
      for (const [l, ids] of byLang) {
        const res = listRecords(db, {
          kind: 'announcement',
          lang: l,
          sources: ids,
          since: since ? `${since}T00:00:00+03:00` : undefined,
          query,
          limit: limit + offset,
        });
        rows = rows.concat(res.rows);
        total += res.total;
      }
      rows.sort((a, b) => (b.published_at ?? b.first_seen_at).localeCompare(a.published_at ?? a.first_seen_at));
      rows = rows.slice(offset, offset + limit);

      const items = rows.map((r) => {
        const src = ANNOUNCEMENT_SOURCES.find((s) => s.id === r.source);
        return {
          title: r.title,
          url: r.url,
          source: r.source,
          source_name: src?.name[lang] ?? r.source,
          lang: r.lang,
          published_at: r.published_at,
          summary: truncate(r.body.replace(/\s+/g, ' '), response_format === 'detailed' ? 1500 : 220),
        };
      });

      const usedSources = [...new Set((items.length ? items : sources.map((s) => ({ source: s.id }))).map((i) => i.source))];
      const freshness = usedSources.slice(0, 6).map((id) => {
        const src = ANNOUNCEMENT_SOURCES.find((s) => s.id === id)!;
        const l = src.urls[langFor(db, id, lang)] ? langFor(db, id, lang) : src.urls.tr ? 'tr' : 'en';
        return computeFreshness(db, { kind: 'announcement', collector: `announcements:${id}:${l}`, source_url: src.urls[l]! }, lang);
      });

      const lines = items.map((i, n) => {
        const date = i.published_at ? formatDateOnly(i.published_at) : '—';
        const fallback = i.lang !== lang ? ` ${t(lang, 'fallback_lang')}` : '';
        return `${offset + n + 1}. [${date}] ${i.title} — ${i.source_name}${fallback}\n   ${i.url}${i.summary ? `\n   ${i.summary}` : ''}`;
      });
      if (total > offset + items.length) lines.push(t(lang, 'more_results', { n: total - offset - items.length, offset: offset + items.length }));

      return answer({
        lang,
        text: items.length ? lines.join('\n') : t(lang, 'no_results'),
        data: { announcements: items, total },
        freshness,
        see_also: items.length ? undefined : seeAlso(db, { query: query ?? 'duyuru announcements' }, lang),
      });
    },
  );
}
