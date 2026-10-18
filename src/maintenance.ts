import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { BACKUP_KEEP, DB_PATH } from './config.js';
import { runUnit, type CollectorContext } from './collectors/runner.js';
import { now, todayIstanbul } from './lib/time.js';

/** Where daily copies of the database go (next to the database unless METU_MCP_BACKUP_DIR is set). */
export function backupDir(dbPath: string = process.env.METU_MCP_DB ?? DB_PATH): string {
  return process.env.METU_MCP_BACKUP_DIR ?? path.join(path.dirname(dbPath), 'backups');
}

/**
 * Daily housekeeping run by the worker:
 * - `backup`: a consistent copy via `VACUUM INTO` (safe while the worker writes), keeping the newest BACKUP_KEEP files
 * - `cleanup`: drops HTTP cache bodies unused for 30 days, change history older than a year and events that ended
 *   more than a year ago
 */
export async function runMaintenance(ctx: CollectorContext, dir = backupDir()): Promise<void> {
  await runUnit(ctx, 'backup', async () => {
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `metu-${todayIstanbul()}.db`);
    rmSync(file, { force: true });
    ctx.db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    const old = readdirSync(dir)
      .filter((f) => /^metu-\d{4}-\d{2}-\d{2}\.db$/.test(f))
      .sort()
      .reverse()
      .slice(BACKUP_KEEP);
    for (const f of old) rmSync(path.join(dir, f), { force: true });
    return 1;
  });

  await runUnit(ctx, 'cleanup', async () => {
    const day = 86_400_000;
    const at = (days: number) => new Date(now().getTime() - days * day).toISOString();
    const cache = ctx.db.prepare('DELETE FROM http_cache WHERE fetched_at < ?').run(at(30)).changes;
    const versions = ctx.db.prepare('DELETE FROM record_versions WHERE changed_at < ?').run(at(365)).changes;
    const events = ctx.db.prepare('DELETE FROM events WHERE COALESCE(end, start) < ?').run(at(365).slice(0, 10)).changes;
    return Number(cache) + Number(versions) + Number(events);
  });
}
