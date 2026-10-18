import type { DatabaseSync } from 'node:sqlite';
import { now } from '../lib/time.js';

export interface CollectorRun {
  collector: string;
  last_run_at: string | null;
  last_success_at: string | null;
  consecutive_failures: number;
  last_error: string | null;
  last_items: number | null;
}

export function recordRunSuccess(db: DatabaseSync, collector: string, items: number): void {
  const ts = now().toISOString();
  db.prepare(
    `INSERT INTO collector_runs (collector, last_run_at, last_success_at, consecutive_failures, last_error, last_items)
     VALUES (?, ?, ?, 0, NULL, ?)
     ON CONFLICT(collector) DO UPDATE SET last_run_at = excluded.last_run_at, last_success_at = excluded.last_success_at,
       consecutive_failures = 0, last_error = NULL, last_items = excluded.last_items`,
  ).run(collector, ts, ts, items);
}

export function recordRunFailure(db: DatabaseSync, collector: string, error: string): CollectorRun {
  const ts = now().toISOString();
  db.prepare(
    `INSERT INTO collector_runs (collector, last_run_at, consecutive_failures, last_error)
     VALUES (?, ?, 1, ?)
     ON CONFLICT(collector) DO UPDATE SET last_run_at = excluded.last_run_at,
       consecutive_failures = collector_runs.consecutive_failures + 1, last_error = excluded.last_error`,
  ).run(collector, ts, error.slice(0, 500));
  return getRun(db, collector)!;
}

export function getRun(db: DatabaseSync, collector: string): CollectorRun | undefined {
  return db.prepare('SELECT * FROM collector_runs WHERE collector = ?').get(collector) as CollectorRun | undefined;
}

export function listRuns(db: DatabaseSync): CollectorRun[] {
  return db.prepare('SELECT * FROM collector_runs ORDER BY collector').all() as unknown as CollectorRun[];
}
