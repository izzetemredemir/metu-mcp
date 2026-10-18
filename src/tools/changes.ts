import type { DatabaseSync } from 'node:sqlite';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { formatDateTime, now } from '../lib/time.js';
import { recentChanges } from '../store/records.js';
import { answer, COMMON_OUTPUT, LangSchema, READ_ONLY } from './common.js';

const ChangeOut = z.object({
  changed_at: z.string(),
  change_type: z.enum(['new', 'changed']),
  kind: z.string(),
  source: z.string(),
  title: z.string(),
  url: z.string(),
  summary: z.string(),
});

export function registerChangeTools(server: McpServer, db: DatabaseSync): void {
  server.registerTool(
    'metu_recent_changes',
    {
      title: 'What changed recently at METU',
      description:
        'Reports what changed in the sources this server watches: new announcements, moved academic-calendar dates ' +
        '(e.g. "add-drop moved from 5-9 Oct to 6-10 Oct"), and edited rule pages (parking, vehicle permits, fees, meal ' +
        'hours, ring timetables). Use for "anything new this week?" or before relying on older information.',
      inputSchema: z.object({
        days: z.number().int().min(1).max(90).default(7).describe('Look back this many days'),
        kind: z.enum(['announcement', 'calendar', 'page', 'menu']).optional().describe('Only this kind of source'),
        include_announcements: z
          .boolean()
          .default(true)
          .describe('Set false to see only rule/calendar changes, which are rarer and usually more important'),
        limit: z.number().int().min(1).max(50).default(20),
        lang: LangSchema,
      }),
      outputSchema: z.object({ changes: z.array(ChangeOut), ...COMMON_OUTPUT }),
      annotations: { ...READ_ONLY, title: 'What changed recently at METU' },
    },
    async ({ days, kind, include_announcements, limit, lang }) => {
      const since = new Date(now().getTime() - days * 86_400_000).toISOString();
      const kinds = kind ? [kind] : include_announcements ? undefined : ['calendar', 'page', 'menu'];
      const rows = recentChanges(db, { since, kinds, limit: limit * 2 })
        // Prefer entries in the requested language; keep the other language only when no counterpart exists.
        .filter((r, _, all) => r.lang === lang || !all.some((o) => o.lang === lang && o.source === r.source && o.kind === r.kind && o.changed_at.slice(0, 13) === r.changed_at.slice(0, 13)))
        .slice(0, limit);
      const changes = rows.map((r) => ({
        changed_at: r.changed_at,
        change_type: r.change_type,
        kind: r.kind,
        source: r.source,
        title: r.title,
        url: r.url,
        summary: r.summary[lang],
      }));
      const header =
        lang === 'tr'
          ? `Son ${days} gündeki değişiklikler (${changes.length}):`
          : `Changes in the last ${days} day(s) (${changes.length}):`;
      const lines = changes.map((c) => `• ${formatDateTime(c.changed_at)} — [${c.kind}/${c.source}] ${c.summary}\n  ${c.url}`);
      const empty =
        lang === 'tr'
          ? `Son ${days} günde izlenen kaynaklarda değişiklik görülmedi.`
          : `No changes observed in the watched sources in the last ${days} day(s).`;
      return answer({
        lang,
        text: changes.length ? [header, ...lines].join('\n') : empty,
        data: { changes },
        freshness: [],
      });
    },
  );
}
