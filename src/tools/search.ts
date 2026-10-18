import type { DatabaseSync } from 'node:sqlite';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { ANNOUNCEMENT_SOURCES, PAGE_SOURCES, type Lang, type RecordKind } from '../config.js';
import { t } from '../i18n.js';
import { findLinks, getLinkChecks, loadLinks } from '../links.js';
import { correctQuery } from '../lib/fuzzy.js';
import { truncate } from '../lib/text.js';
import { formatDateOnly } from '../lib/time.js';
import { computeFreshness, type Freshness } from '../store/freshness.js';
import { searchRecords, type StoredRecord } from '../store/records.js';
import { answer, COMMON_OUTPUT, formatLinkLine, LangSchema, linkOut, READ_ONLY, recordFreshness } from './common.js';

const HitOut = z.object({
  kind: z.string(),
  title: z.string(),
  url: z.string(),
  lang: z.enum(['tr', 'en']),
  date: z.string().nullable(),
  snippet: z.string(),
});

function collectorFor(r: StoredRecord): string {
  switch (r.kind) {
    case 'announcement':
      return `announcements:${r.source}:${r.lang}`;
    case 'page':
      return `page:${r.source}`;
    case 'calendar':
      return `calendar:${r.lang}`;
    case 'menu':
      return 'dining';
    case 'faq':
      return 'faq-answers';
    default:
      return r.source;
  }
}

/** Short snippet around the first query token in the text. */
function snippet(body: string, query: string): string {
  const flat = body.replace(/\s+/g, ' ');
  const token = query.split(/\s+/).find((w) => w.length >= 3);
  const idx = token ? flat.toLocaleLowerCase('tr-TR').indexOf(token.toLocaleLowerCase('tr-TR')) : -1;
  const start = Math.max(0, idx - 80);
  return (start > 0 ? '…' : '') + truncate(flat.slice(start), 280);
}

export function registerSearchTools(server: McpServer, db: DatabaseSync): void {
  server.registerTool(
    'metu_search',
    {
      title: 'Search everything about METU',
      description:
        'One-shot search across everything this server knows: announcements, stored rule/info pages (parking, vehicle ' +
        'permits, tuition, registration, student certificate, meal hours, ring timetables), academic calendars, the BİDB ' +
        'IT help FAQ (Wi-Fi, VPN, e-mail, passwords, licensed software, smart card) and the official link catalog. Use it when unsure which specific tool fits. Accent-insensitive Turkish/English search.',
      inputSchema: z.object({
        query: z.string().min(2).max(200),
        limit: z.number().int().min(1).max(15).default(8),
        lang: LangSchema,
      }),
      outputSchema: z.object({
        hits: z.array(HitOut),
        links: z.array(z.object({ id: z.string(), title: z.string(), url: z.string(), requires_login: z.string().nullable(), note: z.string() })),
        corrected_query: z.string().nullable().describe('Set when the query had no results and a spelling-corrected one was searched'),
        ...COMMON_OUTPUT,
      }),
      annotations: { ...READ_ONLY, title: 'Search everything about METU' },
    },
    async ({ query: asked, limit, lang }) => {
      const other: Lang = lang === 'tr' ? 'en' : 'tr';
      const kinds: RecordKind[] = ['announcement', 'page', 'calendar', 'faq'];
      let query = asked;
      let records = searchRecords(db, query, kinds, limit, lang);
      // Nothing found: retry once with misspelled words corrected against the index ("kütüpane" → "kutuphane").
      let corrected: string | undefined;
      if (records.length === 0 && searchRecords(db, query, kinds, 1, other).length === 0) {
        corrected = correctQuery(db, query);
        if (corrected) {
          query = corrected;
          records = searchRecords(db, query, kinds, limit, lang);
        }
      }
      if (records.length < limit) {
        // Top up with the other language (e.g. a Turkish-only rule page for an English question).
        const extra = searchRecords(db, query, kinds, limit - records.length, other);
        // Pages and calendars exist once per language: skip the other-language copy of something already found.
        const key = (r: StoredRecord) => (r.kind === 'announcement' ? r.id : `${r.kind}:${r.source}`);
        const seen = new Set(records.map(key));
        records = records.concat(extra.filter((r) => !seen.has(key(r))));
      }
      const hits = records.map((r) => ({
        kind: r.kind,
        title: r.title,
        url: r.url,
        lang: r.lang,
        date: r.published_at ?? r.source_updated_at,
        snippet: snippet(r.body, query),
      }));
      const links = findLinks(loadLinks(), { query, limit: 3 }, getLinkChecks(db)).map((l) => linkOut(l, lang));

      const freshness: Freshness[] = [];
      for (const r of records.slice(0, 5)) {
        const f =
          r.kind === 'announcement'
            ? computeFreshness(db, { kind: 'announcement', collector: collectorFor(r), source_url: r.url }, lang)
            : recordFreshness(db, r, collectorFor(r), lang);
        if (f.status !== 'fresh' || r.kind !== 'announcement') freshness.push(f);
      }

      const sourceName = (r: { kind: string; url: string }) => {
        const a = ANNOUNCEMENT_SOURCES.find((s) => Object.values(s.urls).some((u) => u && new URL(u).host === new URL(r.url).host));
        const p = PAGE_SOURCES.find((s) => s.url === r.url || s.url_en === r.url);
        return p?.title[lang] ?? a?.name[lang] ?? new URL(r.url).host;
      };
      const lines = hits.map(
        (h, i) =>
          `${i + 1}. [${h.kind}${h.date ? ` · ${formatDateOnly(h.date)}` : ''}] ${h.title} — ${sourceName(h)}${h.lang !== lang ? ` ${t(lang, 'fallback_lang')}` : ''}\n   ${h.url}\n   ${h.snippet}`,
      );
      const text = [
        corrected && hits.length
          ? lang === 'tr'
            ? `"${asked}" için sonuç yoktu; "${corrected}" arandı.`
            : `No results for "${asked}"; searched for "${corrected}" instead.`
          : '',
        hits.length ? lines.join('\n') : t(lang, 'no_results'),
        links.length ? `${t(lang, 'see_also')}:\n${links.map((l) => formatLinkLine(l, lang)).join('\n')}` : '',
      ]
        .filter(Boolean)
        .join('\n\n');
      return answer({ lang, text, data: { hits, links, corrected_query: corrected ?? null }, freshness });
    },
  );
}
