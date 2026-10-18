import type { DatabaseSync } from 'node:sqlite';
import pLimit, { type LimitFunction } from 'p-limit';
import {
  ALLOWED_EXTRA_HOSTS,
  ALLOWED_HOST_SUFFIXES,
  DEFAULT_HOST_INTERVAL_MS,
  USER_AGENT,
} from '../config.js';
import { now } from '../lib/time.js';

/**
 * Polite HTTP client:
 * - allowlisted domains only (SSRF protection; redirect targets are checked too)
 * - honours robots.txt (Disallow / Allow / Crawl-delay)
 * - one request per host at a time, at least `max(DEFAULT_HOST_INTERVAL_MS, Crawl-delay)` apart
 * - conditional GET via ETag / Last-Modified; on 304 the cached body is returned
 * - backs off and retries on 429/503/network errors
 */

export class FetchError extends Error {
  constructor(
    message: string,
    readonly url: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'FetchError';
  }
}

export class RobotsDisallowedError extends FetchError {
  constructor(url: string) {
    super(`robots.txt disallows fetching ${url}`, url);
    this.name = 'RobotsDisallowedError';
  }
}

export interface FetchResult {
  url: string;
  status: number;
  body: string;
  notModified: boolean;
  lastModified: string | null;
  contentType: string | null;
  /** Raw response bytes, only with `binary: true` (`body` is then empty). */
  bytes?: Uint8Array;
}

export interface FetchOptions {
  method?: 'GET' | 'POST';
  form?: Record<string, string>;
  /** Use a conditional GET (default: yes for GET). */
  conditional?: boolean;
  timeoutMs?: number;
  /** Skip the robots.txt check — only for fetching robots.txt itself. */
  skipRobots?: boolean;
  /** Return the raw bytes (spreadsheets, images) instead of decoded text; never cached. */
  binary?: boolean;
}

type FetchImpl = typeof fetch;
let fetchImpl: FetchImpl = (...args) => fetch(...args);
let sleepImpl = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** For tests: fake fetch instead of the network and no-op sleeps. */
export function setFetchImpl(impl: FetchImpl, opts: { noDelay?: boolean } = {}): void {
  fetchImpl = impl;
  if (opts.noDelay) sleepImpl = async () => {};
  hostState.clear();
  robotsCache.clear();
}

export function assertAllowedUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new FetchError(`Invalid URL: ${raw}`, raw);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new FetchError(`Unsupported protocol: ${raw}`, raw);
  const host = u.hostname.toLowerCase();
  const ok = ALLOWED_HOST_SUFFIXES.some((s) => host.endsWith(s) || host === s.replace(/^\./, '')) || ALLOWED_EXTRA_HOSTS.includes(host);
  if (!ok) throw new FetchError(`Host not allowed: ${host}`, raw);
  return u;
}

// ---------- robots.txt ----------

interface RobotsRules {
  allow: string[];
  disallow: string[];
  crawlDelayMs: number;
  fetchedAt: number;
}
const robotsCache = new Map<string, RobotsRules>();
const ROBOTS_TTL_MS = 24 * 3_600_000;

export function parseRobots(txt: string, agent = 'metu-mcp'): Omit<RobotsRules, 'fetchedAt'> {
  const groups: { agents: string[]; allow: string[]; disallow: string[]; delay?: number }[] = [];
  let current: (typeof groups)[number] | undefined;
  let lastWasAgent = false;
  for (const rawLine of txt.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], allow: [], disallow: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (key === 'disallow' && value) current.disallow.push(value);
    else if (key === 'allow' && value) current.allow.push(value);
    else if (key === 'crawl-delay') {
      const n = Number(value);
      if (Number.isFinite(n)) current.delay = n;
    }
  }
  // RFC 9309 §2.2.1: every group naming this agent is combined (open.metu.edu.tr has two `*` groups); the `*` groups
  // apply only when no group names it.
  const specific = groups.filter((g) => g.agents.some((a) => a !== '*' && agent.toLowerCase().includes(a)));
  const matched = specific.length > 0 ? specific : groups.filter((g) => g.agents.includes('*'));
  const delays = matched.flatMap((g) => (g.delay === undefined ? [] : [g.delay]));
  return {
    allow: matched.flatMap((g) => g.allow),
    disallow: matched.flatMap((g) => g.disallow),
    crawlDelayMs: Math.min(Math.max(0, ...delays) * 1000, 60_000),
  };
}

function ruleMatches(rule: string, pathAndQuery: string): { match: boolean; length: number } {
  const anchored = rule.endsWith('$');
  const pattern = rule
    .replace(/\$$/, '')
    .split('*')
    .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  const re = new RegExp(`^${pattern}${anchored ? '$' : ''}`);
  return { match: re.test(pathAndQuery), length: rule.length };
}

export function isPathAllowed(rules: Pick<RobotsRules, 'allow' | 'disallow'>, pathAndQuery: string): boolean {
  let best: { allow: boolean; length: number } | undefined;
  for (const r of rules.disallow) {
    const m = ruleMatches(r, pathAndQuery);
    if (m.match && (!best || m.length > best.length)) best = { allow: false, length: m.length };
  }
  for (const r of rules.allow) {
    const m = ruleMatches(r, pathAndQuery);
    if (m.match && (!best || m.length >= best.length)) best = { allow: true, length: m.length };
  }
  return best?.allow ?? true;
}

async function getRobots(origin: string): Promise<RobotsRules> {
  const cached = robotsCache.get(origin);
  if (cached && Date.now() - cached.fetchedAt < ROBOTS_TTL_MS) return cached;
  // Server errors, 429 and an unreachable robots.txt mean complete disallow (RFC 9309 §2.3.1.4); retry in 10 minutes.
  const disallowAll: RobotsRules = { allow: [], disallow: ['/'], crawlDelayMs: 0, fetchedAt: Date.now() - ROBOTS_TTL_MS + 600_000 };
  let rules: RobotsRules = { allow: [], disallow: [], crawlDelayMs: 0, fetchedAt: Date.now() };
  try {
    const res = await rawFetch(`${origin}/robots.txt`, { method: 'GET' }, 15_000);
    if (res.status >= 200 && res.status < 300) {
      rules = { ...parseRobots(await res.text()), fetchedAt: Date.now() };
    } else if (res.status >= 500 || res.status === 429) {
      rules = disallowAll;
    }
  } catch {
    rules = disallowAll;
  }
  robotsCache.set(origin, rules);
  return rules;
}

// ---------- per-host queue ----------

interface HostState {
  limit: LimitFunction;
  nextAt: number;
}
const hostState = new Map<string, HostState>();

function hostQueue(host: string): HostState {
  let s = hostState.get(host);
  if (!s) {
    s = { limit: pLimit(1), nextAt: 0 };
    hostState.set(host, s);
  }
  return s;
}

async function rawFetch(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  return fetchImpl(url, {
    ...init,
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      'User-Agent': USER_AGENT,
      'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.6',
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

interface CacheRow {
  etag: string | null;
  last_modified: string | null;
  body: string | null;
}

/** Allowlisted, robots-aware, per-host serialized, conditional HTTP request. */
export async function politeFetch(db: DatabaseSync | undefined, url: string, opts: FetchOptions = {}): Promise<FetchResult> {
  const u = assertAllowedUrl(url);
  const method = opts.method ?? 'GET';
  const pathAndQuery = u.pathname + u.search;
  const robots = opts.skipRobots ? undefined : await getRobots(u.origin);
  if (robots && !isPathAllowed(robots, pathAndQuery)) throw new RobotsDisallowedError(url);

  const q = hostQueue(u.host);
  const minInterval = Math.max(DEFAULT_HOST_INTERVAL_MS, robots?.crawlDelayMs ?? 0);

  return q.limit(async () => {
    const conditional = (opts.conditional ?? method === 'GET') && db !== undefined && !opts.binary;
    const cache = conditional
      ? (db!.prepare('SELECT etag, last_modified, body FROM http_cache WHERE url = ?').get(url) as CacheRow | undefined)
      : undefined;

    let attempt = 0;
    for (;;) {
      const wait = q.nextAt - Date.now();
      if (wait > 0) await sleepImpl(wait);
      q.nextAt = Date.now() + minInterval;

      const headers: Record<string, string> = {};
      let body: string | undefined;
      if (opts.form) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
        body = new URLSearchParams(opts.form).toString();
      }
      if (cache?.body) {
        if (cache.etag) headers['If-None-Match'] = cache.etag;
        if (cache.last_modified) headers['If-Modified-Since'] = cache.last_modified;
      }

      let res: Response;
      try {
        res = await rawFetch(url, { method, headers, body }, opts.timeoutMs ?? 30_000);
      } catch (err) {
        if (attempt++ < 2) {
          await sleepImpl(2_000 * attempt ** 2);
          continue;
        }
        throw new FetchError(`Network error (${(err as Error).message}): ${url}`, url);
      }

      if ((res.status === 429 || res.status === 503) && attempt++ < 2) {
        const retryAfter = Number(res.headers.get('retry-after'));
        await sleepImpl(Math.min(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 5_000 * attempt, 60_000));
        continue;
      }

      const finalUrl = res.url || url;
      assertAllowedUrl(finalUrl);

      if (res.status === 304 && cache?.body) {
        db!.prepare('UPDATE http_cache SET fetched_at = ? WHERE url = ?').run(now().toISOString(), url);
        return {
          url: finalUrl,
          status: 304,
          body: cache.body,
          notModified: true,
          lastModified: cache.last_modified,
          contentType: res.headers.get('content-type'),
        };
      }
      if (res.status < 200 || res.status >= 300) {
        throw new FetchError(`HTTP ${res.status}: ${url}`, url, res.status);
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (opts.binary) {
        const lastModified = res.headers.get('last-modified');
        return { url: finalUrl, status: res.status, body: '', bytes, notModified: false, lastModified, contentType: res.headers.get('content-type') };
      }
      const text = decodeBody(bytes, res.headers.get('content-type'));
      const etag = res.headers.get('etag');
      const lastModified = res.headers.get('last-modified');
      if (conditional && (etag || lastModified)) {
        db!.prepare(
          `INSERT INTO http_cache (url, etag, last_modified, status, body, fetched_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(url) DO UPDATE SET etag = excluded.etag, last_modified = excluded.last_modified,
             status = excluded.status, body = excluded.body, fetched_at = excluded.fetched_at`,
        ).run(url, etag, lastModified, res.status, text, now().toISOString());
      }
      return {
        url: finalUrl,
        status: res.status,
        body: text,
        notModified: false,
        lastModified,
        contentType: res.headers.get('content-type'),
      };
    }
  });
}

/**
 * Decodes a response body using the charset from the Content-Type header, else from a `<meta charset>` in the
 * first bytes, else UTF-8. Some METU sites (catalog.metu.edu.tr) still serve ISO-8859-9 without a header charset.
 */
export function decodeBody(bytes: Uint8Array, contentType: string | null): string {
  const fromHeader = /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType ?? '')?.[1];
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 2048));
  const fromMeta = /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(head)?.[1];
  for (const label of [fromHeader, fromMeta]) {
    if (!label) continue;
    try {
      return new TextDecoder(label).decode(bytes);
    } catch {
      /* unknown label: try the next source */
    }
  }
  return new TextDecoder('utf-8').decode(bytes);
}

/** Converts the HTTP Last-Modified header to ISO 8601. */
export function lastModifiedIso(res: FetchResult): string | null {
  if (!res.lastModified) return null;
  const d = new Date(res.lastModified);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
