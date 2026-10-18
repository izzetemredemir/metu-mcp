import type { DatabaseSync } from 'node:sqlite';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { Lang } from '../config.js';
import { t } from '../i18n.js';
import { findLinks, getLinkChecks, loadLinks, type Link, type LinkQuery } from '../links.js';
import { computeFreshness, freshnessLine, FreshnessSchema, type Freshness } from '../store/freshness.js';
import type { StoredRecord } from '../store/records.js';

export const LangSchema = z
  .enum(['tr', 'en'])
  .default('tr')
  .describe(
    'Language of the answer. METU publishes in Turkish and English: use "tr" for Turkish-speaking users, "en" otherwise. ' +
      'Content that only exists in one language is returned in that language with a note.',
  );

export const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

export const LinkOutSchema = z.object({
  id: z.string(),
  title: z.string(),
  url: z.string(),
  requires_login: z.string().nullable().describe('System the student must log into, or null if public'),
  note: z.string(),
});
export type LinkOut = z.infer<typeof LinkOutSchema>;

export function linkOut(l: Link, lang: Lang): LinkOut {
  return {
    id: l.id,
    title: l.title[lang],
    url: l.url,
    requires_login: l.requires_auth === false ? null : l.requires_auth,
    note: l.note[lang],
  };
}

export function formatLinkLine(l: LinkOut, lang: Lang): string {
  const auth = l.requires_login ? ` (${t(lang, 'login_required', { system: l.requires_login })})` : '';
  return `• ${l.title}${auth}: ${l.url}\n  ${l.note}`;
}

/** Related official links for a tool answer (the "see also" fallback). */
export function seeAlso(db: DatabaseSync, q: LinkQuery, lang: Lang): LinkOut[] {
  return findLinks(loadLinks(), { limit: 3, ...q }, getLinkChecks(db)).map((l) => linkOut(l, lang));
}

export interface Answer<T extends Record<string, unknown>> {
  text: string;
  data: T;
  freshness: Freshness[];
  see_also?: LinkOut[];
  lang: Lang;
}

/**
 * Builds a tool result: readable text (with freshness lines and official links appended, so a
 * model that ignores structured output still sees them) plus the same data as structuredContent.
 */
export function answer<T extends Record<string, unknown>>(a: Answer<T>): CallToolResult {
  const parts = [a.text.trim()];
  if (a.see_also?.length) {
    parts.push(`${t(a.lang, 'see_also')}:\n${a.see_also.map((l) => formatLinkLine(l, a.lang)).join('\n')}`);
  }
  const seen = new Set<string>();
  const lines = a.freshness
    .map((f) => freshnessLine(f, a.lang))
    .filter((l) => (seen.has(l) ? false : (seen.add(l), true)));
  if (lines.length) parts.push(lines.join('\n'));
  return {
    content: [{ type: 'text', text: parts.join('\n\n') }],
    structuredContent: { ...a.data, freshness: a.freshness, see_also: a.see_also ?? [] },
  };
}

/** Tool error the model can act on (isError: true, never a protocol error). */
export function toolError(message: string, lang: Lang, hints: LinkOut[] = []): CallToolResult {
  const text = hints.length
    ? `${message}\n\n${t(lang, 'see_also')}:\n${hints.map((l) => formatLinkLine(l, lang)).join('\n')}`
    : message;
  return { content: [{ type: 'text', text }], isError: true };
}

/** Common output-schema fields every tool returns. */
export const COMMON_OUTPUT = {
  freshness: z.array(FreshnessSchema).describe('How current each underlying source is'),
  see_also: z.array(LinkOutSchema).describe('Official METU pages for details or login-only information'),
};

export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD');

/** Freshness for a stored record, tied to the collector unit that maintains it. */
export function recordFreshness(db: DatabaseSync, rec: StoredRecord, collector: string, lang: Lang): Freshness {
  return computeFreshness(
    db,
    {
      kind: rec.kind,
      collector,
      source_url: rec.url,
      fetched_at: rec.fetched_at,
      source_updated_at: rec.source_updated_at,
      last_changed_at: rec.last_changed_at,
      valid_for: rec.valid_for,
    },
    lang,
  );
}
