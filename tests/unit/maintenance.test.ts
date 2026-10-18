import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { runMaintenance } from '../../src/maintenance.js';
import { getRun } from '../../src/store/runs.js';

describe('maintenance', () => {
  it('writes a readable backup, keeps the newest 7 and prunes old cache and history', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'metu-mcp-'));
    const db = openDb(path.join(dir, 'metu.db'));
    const backups = path.join(dir, 'backups');
    // Ten older backups exist already.
    await runMaintenance({ db, log: () => {} }, backups);
    for (let d = 10; d < 20; d++) writeFileSync(path.join(backups, `metu-2026-01-${d}.db`), '');
    db.prepare(`INSERT INTO http_cache (url, status, body, fetched_at) VALUES ('https://x.metu.edu.tr/', 200, 'x', '2020-01-01T00:00:00Z')`).run();
    db.prepare(`INSERT INTO record_versions (record_id, kind, source, title, url, change_type, summary, new_hash, changed_at)
      VALUES ('r', 'page', 's', 't', 'u', 'changed', '{}', 'h', '2020-01-01T00:00:00Z')`).run();

    await runMaintenance({ db, log: () => {} }, backups);
    const files = readdirSync(backups).sort();
    expect(files.length).toBe(7);
    const today = files.at(-1)!;
    expect(today).toMatch(/^metu-\d{4}-\d{2}-\d{2}\.db$/);
    expect(existsSync(path.join(backups, 'metu-2026-01-10.db'))).toBe(false);
    // The copy is a real SQLite database with the schema.
    const copy = new DatabaseSync(path.join(backups, today), { readOnly: true });
    expect(copy.prepare(`SELECT count(*) AS n FROM sqlite_master WHERE name = 'records'`).get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT count(*) AS n FROM http_cache').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT count(*) AS n FROM record_versions').get()).toEqual({ n: 0 });
    expect(getRun(db, 'backup')?.consecutive_failures).toBe(0);
  });
});
