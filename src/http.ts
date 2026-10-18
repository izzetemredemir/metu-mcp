import type { DatabaseSync } from 'node:sqlite';
import { serve } from '@hono/node-server';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { Hono, type Context } from 'hono';
import { APP_NAME, APP_VERSION } from './config.js';
import { createServer } from './server.js';
import { listRuns } from './store/runs.js';

/** Simple per-IP token bucket (the spec requires servers to rate-limit tool calls). */
function rateLimiter(perMinute: number) {
  const buckets = new Map<string, { tokens: number; at: number }>();
  return (ip: string): boolean => {
    const t = Date.now();
    const b = buckets.get(ip) ?? { tokens: perMinute, at: t };
    b.tokens = Math.min(perMinute, b.tokens + ((t - b.at) / 60_000) * perMinute);
    b.at = t;
    if (b.tokens < 1) {
      buckets.set(ip, b);
      return false;
    }
    b.tokens -= 1;
    buckets.set(ip, b);
    if (buckets.size > 50_000) buckets.clear();
    return true;
  };
}

function clientIp(c: Context): string {
  // Behind Caddy on the VPS; only trust X-Forwarded-For when explicitly enabled.
  if (process.env.METU_MCP_TRUST_PROXY === '1') {
    const xff = c.req.header('x-forwarded-for');
    if (xff) return xff.split(',')[0]!.trim();
  }
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming;
  return incoming?.socket?.remoteAddress ?? 'unknown';
}

export function createHttpApp(db: DatabaseSync): Hono {
  const handler = createMcpHandler(() => createServer(db), {
    onerror: (err) => console.error(`[mcp] ${err.message}`),
  });
  const allowedHosts = (process.env.METU_MCP_ALLOWED_HOSTS ?? 'localhost,127.0.0.1')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  const allow = rateLimiter(Number(process.env.METU_MCP_RATE_PER_MIN ?? 60));

  const app = new Hono();
  app.get('/healthz', (c) => {
    const runs = listRuns(db);
    const failing = runs.filter((r) => r.consecutive_failures >= 3).map((r) => r.collector);
    return c.json({ ok: failing.length === 0, name: APP_NAME, version: APP_VERSION, failing, collectors: runs.length });
  });
  app.all('/mcp', async (c) => {
    // DNS-rebinding protection: only answer for configured host names.
    const host = (c.req.header('host') ?? '').split(':')[0]!.toLowerCase();
    if (!allowedHosts.includes(host)) return c.json({ error: 'host not allowed' }, 403);
    if (!allow(clientIp(c))) return c.json({ error: 'rate limit exceeded, try again in a minute' }, 429);
    return handler.fetch(c.req.raw);
  });
  return app;
}

export function startHttp(db: DatabaseSync, port: number, hostname = '127.0.0.1'): void {
  const app = createHttpApp(db);
  serve({ fetch: app.fetch, port, hostname }, (info) => {
    console.error(`${APP_NAME} listening on http://${hostname}:${info.port}/mcp`);
  });
}
