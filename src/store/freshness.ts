import type { DatabaseSync } from 'node:sqlite';
import * as z from 'zod/v4';
import { STALE_AFTER_MS, UNREACHABLE_AFTER_FAILURES, type Lang, type RecordKind } from '../config.js';
import { t } from '../i18n.js';
import { formatDateOnly, formatDateTime, now } from '../lib/time.js';
import { getRun } from './runs.js';

/** Freshness block returned with every tool answer. */
export const FreshnessSchema = z.object({
  source_url: z.string().describe('Official page the information comes from'),
  fetched_at: z.string().nullable().describe('When we last verified the source (ISO 8601)'),
  source_updated_at: z.string().nullable().describe('The source page\'s own "last updated" date, if it shows one'),
  last_changed_at: z.string().nullable().describe('When we last observed the content change'),
  valid_for: z.string().nullable().describe('Period the data is valid for (e.g. 2026-2027, 2026-10-01)'),
  status: z.enum(['fresh', 'stale', 'source_unreachable', 'no_data']),
  warning: z.string().nullable(),
});
export type Freshness = z.infer<typeof FreshnessSchema>;

export interface FreshnessInput {
  kind: RecordKind;
  collector: string;
  source_url: string;
  fetched_at?: string | null;
  source_updated_at?: string | null;
  last_changed_at?: string | null;
  valid_for?: string | null;
}

export function computeFreshness(db: DatabaseSync, input: FreshnessInput, lang: Lang = 'en'): Freshness {
  const run = getRun(db, input.collector);
  const fetchedAt = input.fetched_at ?? run?.last_success_at ?? null;
  const base = {
    source_url: input.source_url,
    fetched_at: fetchedAt,
    source_updated_at: input.source_updated_at ?? null,
    last_changed_at: input.last_changed_at ?? null,
    valid_for: input.valid_for ?? null,
  };
  if (!fetchedAt) {
    return {
      ...base,
      status: 'no_data',
      warning: t(lang, 'never_fetched', { url: input.source_url }),
    };
  }
  const ageMs = now().getTime() - new Date(fetchedAt).getTime();
  if (run && run.consecutive_failures >= UNREACHABLE_AFTER_FAILURES) {
    return {
      ...base,
      status: 'source_unreachable',
      warning: t(lang, 'unreachable', { at: formatDateTime(fetchedAt), n: run.consecutive_failures, url: input.source_url }),
    };
  }
  if (ageMs > STALE_AFTER_MS[input.kind]) {
    const days = Math.floor(ageMs / 86_400_000);
    const age = days >= 1 ? t(lang, 'age_days', { n: days }) : t(lang, 'age_hours', { n: Math.floor(ageMs / 3_600_000) });
    return {
      ...base,
      status: 'stale',
      warning: t(lang, 'stale', { age, url: input.source_url }),
    };
  }
  return { ...base, status: 'fresh', warning: null };
}

/** One-line freshness note appended to text output (plus the warning, if any). */
export function freshnessLine(f: Freshness, lang: Lang = 'en'): string {
  let host = f.source_url;
  try {
    host = new URL(f.source_url).host;
  } catch {
    /* not a URL: keep as-is */
  }
  const parts = [`${t(lang, 'source')}: ${host}`, t(lang, 'last_checked', { at: formatDateTime(f.fetched_at) })];
  if (f.source_updated_at) parts.push(t(lang, 'page_updated', { at: formatDateOnly(f.source_updated_at) }));
  if (f.valid_for) parts.push(t(lang, 'valid_for', { v: f.valid_for }));
  const line = `— ${parts.join(' · ')}`;
  return f.warning ? `${line}\n⚠️ ${f.warning}` : line;
}

/** Picks the worst freshness among several sources (for summaries). */
export function worstFreshness(list: Freshness[]): Freshness | undefined {
  const rank = { fresh: 0, stale: 1, no_data: 2, source_unreachable: 3 } as const;
  return [...list].sort((a, b) => rank[b.status] - rank[a.status])[0];
}
