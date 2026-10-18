#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { Cron } from 'croner';
import { ANNOUNCEMENT_SOURCES, SCHEDULES, TIMEZONE } from './config.js';
import { COLLECTORS } from './collectors/index.js';
import { consoleLog, type CollectorContext } from './collectors/runner.js';
import { startHttp } from './http.js';
import { createServer } from './server.js';
import { getDb } from './store/db.js';
import { listRuns } from './store/runs.js';

const USAGE = `Usage: metu-mcp <command>

  serve [--port 8787] [--host 127.0.0.1]   Streamable HTTP MCP endpoint at /mcp
  serve --stdio                            MCP over stdio (Claude Desktop / Claude Code local use)
  worker                                   Run collectors on their schedules (single writer)
  refresh [collector ...] [--only id,...]  Run collectors once now: ${Object.keys(COLLECTORS).join(', ')}
  check-links                              Verify every URL in data/links.yaml
  status                                   Print collector status`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function runCollectors(names: string[], only?: string[]): Promise<void> {
  const ctx: CollectorContext = { db: getDb(), log: consoleLog };
  for (const name of names) {
    const fn = COLLECTORS[name];
    if (!fn) throw new Error(`unknown collector "${name}". Known: ${Object.keys(COLLECTORS).join(', ')}`);
    consoleLog(`running ${name}`);
    await fn(ctx, only);
  }
}

async function worker(): Promise<void> {
  const db = getDb();
  const runKeys = listRuns(db).map((r) => r.collector);
  const ran = new Set(runKeys.map((k) => k.split(':')[0]));
  const hourlyIds = new Set(ANNOUNCEMENT_SOURCES.filter((s) => s.hourly).map((s) => s.id));
  const hasRun = (name: string) =>
    name === 'pages'
      ? runKeys.some((k) => k.startsWith('page:'))
      : name === 'announcements-hourly'
        ? runKeys.some((k) => hourlyIds.has(k.split(':')[1] ?? ''))
        : name === 'maintenance'
          ? true // housekeeping only on its schedule, never as a bootstrap
          : ran.has(name);
  // Bootstrap: collect anything that has never run, so a fresh deployment answers right away.
  const missing = Object.keys(COLLECTORS).filter((n) => !hasRun(n));
  if (missing.length) await runCollectors(missing).catch((e) => consoleLog(`bootstrap error: ${(e as Error).message}`));

  let busy = Promise.resolve();
  const queued = new Set<string>();
  for (const [name, pattern] of Object.entries(SCHEDULES)) {
    new Cron(pattern, { timezone: TIMEZONE, protect: true }, () => {
      // Serialize collectors so hosts shared between them are never hit in parallel. A collector already waiting
      // behind a long run (e.g. catalog-details) is not queued twice.
      if (queued.has(name)) {
        consoleLog(`[${name}] skipped: previous run still queued`);
        return busy;
      }
      queued.add(name);
      busy = busy
        .then(() => {
          queued.delete(name);
          return runCollectors([name]);
        })
        .catch((e) => consoleLog(`[${name}] error: ${(e as Error).message}`));
      return busy;
    });
    consoleLog(`scheduled ${name}: ${pattern}`);
  }
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case 'serve': {
      const db = getDb();
      if (args.includes('--stdio')) {
        serveStdio(() => createServer(db), { onerror: (e) => console.error(`[mcp] ${e.message}`) });
      } else {
        startHttp(db, Number(flag(args, '--port') ?? process.env.PORT ?? 8787), flag(args, '--host') ?? '127.0.0.1');
      }
      return;
    }
    case 'worker':
      return worker();
    case 'refresh': {
      const names = args.filter((a) => !a.startsWith('--') && a !== flag(args, '--only'));
      const only = flag(args, '--only')?.split(',');
      await runCollectors(names.length ? names : Object.keys(COLLECTORS), only);
      return;
    }
    case 'check-links':
      return runCollectors(['links']);
    case 'status':
      console.log(JSON.stringify(listRuns(getDb()), null, 2));
      return;
    default:
      console.error(USAGE);
      process.exitCode = cmd ? 1 : 0;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
