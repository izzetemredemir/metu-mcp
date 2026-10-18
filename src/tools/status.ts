import type { DatabaseSync } from 'node:sqlite';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { formatDateTime } from '../lib/time.js';
import { listRuns } from '../store/runs.js';
import { answer, COMMON_OUTPUT, LangSchema, READ_ONLY } from './common.js';

const AreaOut = z.object({
  area: z.string().describe('Collector family, e.g. "announcements", "page", "events"'),
  units: z.number().int(),
  failing: z.number().int(),
  oldest_success_at: z.string().nullable(),
  newest_success_at: z.string().nullable(),
});
const ProblemOut = z.object({
  collector: z.string(),
  consecutive_failures: z.number().int(),
  last_success_at: z.string().nullable(),
  last_error: z.string().nullable(),
});

export function registerStatusTools(server: McpServer, db: DatabaseSync): void {
  server.registerTool(
    'metu_status',
    {
      title: 'METU data freshness',
      description:
        'How fresh this server\'s data is: per source family (announcements, info pages, calendar, menus, events, ' +
        'catalog, theses …) the number of collected units, the oldest and newest successful fetch, and every source that ' +
        'is currently failing with its last error. Use it when a student doubts an answer or a source looks outdated.',
      inputSchema: z.object({
        area: z.string().max(40).optional().describe('Only this family, e.g. "announcements" or "page"'),
        lang: LangSchema,
      }),
      outputSchema: z.object({ areas: z.array(AreaOut), problems: z.array(ProblemOut), ...COMMON_OUTPUT }),
      annotations: { ...READ_ONLY, title: 'METU data freshness' },
    },
    async ({ area, lang }) => {
      const runs = listRuns(db).filter((r) => !area || r.collector.split(':')[0] === area);
      const groups = new Map<string, typeof runs>();
      for (const r of runs) {
        const key = r.collector.split(':')[0]!;
        groups.set(key, [...(groups.get(key) ?? []), r]);
      }
      const areas = [...groups].map(([name, list]) => {
        const ok = list.map((r) => r.last_success_at).filter((x): x is string => x !== null).sort();
        return {
          area: name,
          units: list.length,
          failing: list.filter((r) => r.consecutive_failures > 0).length,
          oldest_success_at: ok[0] ?? null,
          newest_success_at: ok.at(-1) ?? null,
        };
      });
      const problems = runs
        .filter((r) => r.consecutive_failures > 0)
        .sort((a, b) => b.consecutive_failures - a.consecutive_failures)
        .map((r) => ({ collector: r.collector, consecutive_failures: r.consecutive_failures, last_success_at: r.last_success_at, last_error: r.last_error }));
      const tr = lang === 'tr';
      const when = (iso: string | null) => (iso ? formatDateTime(iso) : tr ? 'hiç' : 'never');
      const lines = areas.map(
        (a) =>
          `• ${a.area}: ${a.units} ${tr ? 'kaynak' : 'units'}, ${tr ? 'en eski' : 'oldest'} ${when(a.oldest_success_at)}, ` +
          `${tr ? 'en yeni' : 'newest'} ${when(a.newest_success_at)}${a.failing ? ` — ⚠️ ${a.failing} ${tr ? 'hatalı' : 'failing'}` : ''}`,
      );
      const problemLines = problems
        .slice(0, 25)
        .map((p) => `• ${p.collector}: ${p.consecutive_failures}× ${tr ? 'hata' : 'failed'}, ${tr ? 'son başarı' : 'last success'} ${when(p.last_success_at)} — ${p.last_error ?? ''}`);
      const text = [
        lines.length ? lines.join('\n') : tr ? 'Henüz hiçbir kaynak toplanmadı.' : 'Nothing has been collected yet.',
        problemLines.length
          ? `${tr ? 'Şu an hata veren kaynaklar' : 'Currently failing sources'}:\n${problemLines.join('\n')}`
          : tr
            ? 'Hata veren kaynak yok.'
            : 'No source is failing.',
      ].join('\n\n');
      return answer({ lang, text, data: { areas, problems }, freshness: [] });
    },
  );
}
