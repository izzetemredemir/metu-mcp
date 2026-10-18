import type { DatabaseSync } from 'node:sqlite';
import { UNREACHABLE_AFTER_FAILURES } from '../config.js';
import { recordRunFailure, recordRunSuccess } from '../store/runs.js';

export interface CollectorContext {
  db: DatabaseSync;
  log: (msg: string) => void;
}

/**
 * Runs one unit of collection (e.g. one announcement source) and records the outcome in
 * `collector_runs`, which drives the freshness status shown to users.
 */
export async function runUnit(
  ctx: CollectorContext,
  key: string,
  fn: () => Promise<number>,
): Promise<{ ok: boolean; items: number; error?: string }> {
  try {
    const items = await fn();
    recordRunSuccess(ctx.db, key, items);
    ctx.log(`[${key}] ok (${items} items)`);
    return { ok: true, items };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const run = recordRunFailure(ctx.db, key, message);
    const level = run.consecutive_failures >= UNREACHABLE_AFTER_FAILURES ? 'ERROR' : 'WARN';
    ctx.log(`[${key}] ${level} failure #${run.consecutive_failures}: ${message}`);
    return { ok: false, items: 0, error: message };
  }
}

export const consoleLog = (msg: string) => console.error(`${new Date().toISOString()} ${msg}`);
