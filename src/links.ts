import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { parse } from 'yaml';
import * as z from 'zod/v4';
import { politeFetch } from './collectors/http.js';
import { runUnit, type CollectorContext } from './collectors/runner.js';
import { matchScore } from './lib/text.js';
import { now } from './lib/time.js';

/** Curated official link catalog (data/links.yaml) — the fallback when live data is unavailable. */

const Localized = z.object({ en: z.string().min(1), tr: z.string().min(1) });

export const LinkSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  title: Localized,
  url: z.url().refine((u) => u.startsWith('https://'), 'must be https'),
  category: z.enum([
    'calendar', 'registration', 'fees', 'regulations', 'systems', 'amnesty', 'graduate-school', 'department',
    'courses', 'dining', 'parking', 'transport', 'dormitory', 'health', 'sports', 'library', 'it',
    'international', 'campus', 'contact',
  ]),
  audience: z.array(z.string()).min(1),
  requires_auth: z.union([z.literal(false), z.string()]),
  served_by: z.string().optional(),
  /** Only online during an application window (404 outside it is expected): never hidden by the checker. */
  seasonal: z.boolean().default(false),
  keywords: z.array(z.union([z.string(), z.number()]).transform(String)).default([]),
  note: Localized,
  last_verified: z.union([z.string(), z.date()]).transform((v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v)),
});
export type Link = z.infer<typeof LinkSchema>;
export type LinkCategory = Link['category'];

const DEFAULT_LINKS_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data/links.yaml');

let cache: Link[] | undefined;

export function loadLinks(file = process.env.METU_MCP_LINKS ?? DEFAULT_LINKS_FILE): Link[] {
  if (cache) return cache;
  const raw = parse(readFileSync(file, 'utf8')) as unknown;
  const links = z.array(LinkSchema).parse(raw);
  const ids = new Set<string>();
  for (const l of links) {
    if (ids.has(l.id)) throw new Error(`duplicate link id in links.yaml: ${l.id}`);
    ids.add(l.id);
  }
  cache = links;
  return links;
}

export interface LinkCheck {
  link_id: string;
  url: string;
  /** `broken` = 404/410 (hidden from answers); `unreachable` = timeout/5xx (still shown, may be temporary). */
  status: 'ok' | 'redirect' | 'broken' | 'unreachable';
  http_status: number | null;
  final_url: string | null;
  checked_at: string;
}

export function getLinkChecks(db: DatabaseSync): Map<string, LinkCheck> {
  const rows = db.prepare('SELECT * FROM link_checks').all() as unknown as LinkCheck[];
  return new Map(rows.map((r) => [r.link_id, r]));
}

export interface LinkQuery {
  query?: string;
  category?: LinkCategory;
  audience?: string;
  limit?: number;
}

/**
 * Ranks catalog entries against a free-text query (Turkish or English, accent-insensitive).
 * Links whose last automated check found them broken are dropped.
 */
export function findLinks(links: Link[], q: LinkQuery, checks?: Map<string, LinkCheck>): Link[] {
  const scored = links
    .filter((l) => !q.category || l.category === q.category)
    .filter((l) => !q.audience || l.audience.includes('all') || l.audience.includes(q.audience))
    .filter((l) => checks?.get(l.id)?.status !== 'broken')
    .map((l) => {
      if (!q.query) return { l, score: 1 };
      const titleScore = Math.max(matchScore(l.title.en, q.query), matchScore(l.title.tr, q.query));
      const kwScore = matchScore(l.keywords.join(' '), q.query);
      const noteScore = Math.max(matchScore(l.note.en, q.query), matchScore(l.note.tr, q.query));
      const catScore = matchScore(l.category, q.query);
      return { l, score: titleScore * 3 + kwScore * 3 + noteScore + catScore };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, q.limit ?? 5).map((x) => x.l);
}

/** Weekly check: every catalog URL is fetched (robots-aware) and its status stored. */
export async function checkLinks(ctx: CollectorContext): Promise<void> {
  await runUnit(ctx, 'links', async () => {
    const links = loadLinks();
    let broken = 0;
    for (const l of links) {
      let status: LinkCheck['status'] = 'ok';
      let httpStatus: number | null = null;
      let finalUrl: string | null = null;
      try {
        const res = await politeFetch(ctx.db, l.url, { conditional: false, timeoutMs: 20_000 });
        httpStatus = res.status;
        finalUrl = res.url;
        if (new URL(res.url).pathname.replace(/\/$/, '') !== new URL(l.url).pathname.replace(/\/$/, '')) status = 'redirect';
      } catch (err) {
        const e = err as { status?: number; name?: string };
        httpStatus = e.status ?? null;
        // A robots-disallowed or login-walled system is still a valid link to hand to a student.
        if (e.name === 'RobotsDisallowedError' || l.requires_auth) status = 'ok';
        else if ((httpStatus === 404 || httpStatus === 410) && !l.seasonal) {
          status = 'broken';
          broken++;
        } else status = 'unreachable';
      }
      ctx.db.prepare(
        `INSERT INTO link_checks (link_id, url, status, http_status, final_url, checked_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(link_id) DO UPDATE SET url = excluded.url, status = excluded.status, http_status = excluded.http_status,
           final_url = excluded.final_url, checked_at = excluded.checked_at`,
      ).run(l.id, l.url, status, httpStatus, finalUrl, now().toISOString());
      if (status !== 'ok') ctx.log(`[links] ${l.id}: ${status} (${httpStatus ?? 'no response'}) ${finalUrl ?? l.url}`);
    }
    if (broken > 0) ctx.log(`[links] ${broken} broken link(s) — update data/links.yaml`);
    return links.length;
  });
}
