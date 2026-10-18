import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Lang, RecordKind } from '../config.js';
import { foldTr, toFtsQuery } from '../lib/text.js';
import { now } from '../lib/time.js';

export interface RecordInput {
  id: string;
  kind: RecordKind;
  source: string;
  lang: Lang;
  title: string;
  body?: string;
  url: string;
  data?: unknown;
  published_at?: string | null;
  source_updated_at?: string | null;
  valid_for?: string | null;
  /** Extra text indexed for search (e.g. tags). */
  search_extra?: string;
}

export interface StoredRecord {
  id: string;
  kind: RecordKind;
  source: string;
  lang: Lang;
  title: string;
  body: string;
  url: string;
  data: string | null;
  published_at: string | null;
  source_updated_at: string | null;
  fetched_at: string;
  first_seen_at: string;
  last_changed_at: string;
  content_hash: string;
  valid_for: string | null;
}

export type UpsertResult = 'new' | 'changed' | 'unchanged';

/** Change summary in both languages; stored as JSON in `record_versions.summary`. */
export type LocalizedSummary = Record<Lang, string>;

/** Optional change-summary builder (e.g. which calendar date moved). */
export type ChangeSummarizer = (oldRec: StoredRecord, next: RecordInput) => LocalizedSummary | undefined;

export function contentHash(title: string, body: string, data: unknown): string {
  return createHash('sha256')
    .update(title)
    .update('\u0000')
    .update(body)
    .update('\u0000')
    .update(data === undefined ? '' : JSON.stringify(data))
    .digest('hex');
}

const COLUMNS =
  'id, kind, source, lang, title, body, url, data, published_at, source_updated_at, fetched_at, first_seen_at, last_changed_at, content_hash, valid_for';

export function getRecord(db: DatabaseSync, id: string): StoredRecord | undefined {
  return db.prepare(`SELECT ${COLUMNS} FROM records WHERE id = ?`).get(id) as StoredRecord | undefined;
}

/** Whether any record of this kind/source/language exists — call before a collector run to decide `trackNew`. */
export function hasRecords(db: DatabaseSync, kind: RecordKind, source: string, lang: Lang): boolean {
  return db.prepare('SELECT 1 FROM records WHERE kind = ? AND source = ? AND lang = ? LIMIT 1').get(kind, source, lang) !== undefined;
}

/**
 * Inserts or updates a record. If the content hash changed, the old version goes to `record_versions`
 * and `last_changed_at` moves; otherwise only `fetched_at` (last verified) advances.
 * New records are reported as changes only with `trackNew` (i.e. not during a source's first load).
 * `noHistory` skips the version history for fast-moving status data (doctors on duty) that would flood recent changes.
 */
export function upsertRecord(
  db: DatabaseSync,
  input: RecordInput,
  summarize?: ChangeSummarizer,
  opts: { trackNew?: boolean; noHistory?: boolean } = {},
): UpsertResult {
  const ts = now().toISOString();
  const body = input.body ?? '';
  const hash = contentHash(input.title, body, input.data);
  const dataJson = input.data === undefined ? null : JSON.stringify(input.data);
  const searchText = foldTr([input.title, body, input.search_extra ?? ''].join('\n'));
  const existing = getRecord(db, input.id);

  if (!existing) {
    db.prepare(
      `INSERT INTO records (${COLUMNS}, search_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.id, input.kind, input.source, input.lang, input.title, body, input.url, dataJson,
      input.published_at ?? null, input.source_updated_at ?? null, ts, ts, ts, hash, input.valid_for ?? null, searchText,
    );
    if (opts.trackNew) {
      insertVersion(db, {
        record_id: input.id, kind: input.kind, source: input.source, title: input.title, url: input.url,
        change_type: 'new', summary: JSON.stringify({ en: `New: ${input.title}`, tr: `Yeni: ${input.title}` }), old_hash: null, new_hash: hash,
        old_body: null, old_data: null, changed_at: ts,
      });
    }
    return 'new';
  }

  if (existing.content_hash === hash) {
    db.prepare('UPDATE records SET lang = ?, fetched_at = ?, source_updated_at = COALESCE(?, source_updated_at) WHERE id = ?').run(
      input.lang, ts, input.source_updated_at ?? null, input.id,
    );
    return 'unchanged';
  }

  if (!opts.noHistory) {
    const summary = summarize?.(existing, input) ?? defaultSummary(existing, input);
    insertVersion(db, {
      record_id: input.id, kind: input.kind, source: input.source, title: input.title, url: input.url,
      change_type: 'changed', summary: JSON.stringify(summary), old_hash: existing.content_hash, new_hash: hash,
      old_body: existing.body, old_data: existing.data, changed_at: ts,
    });
  }
  db.prepare(
    `UPDATE records SET lang = ?, title = ?, body = ?, url = ?, data = ?, published_at = COALESCE(?, published_at),
       source_updated_at = COALESCE(?, source_updated_at), fetched_at = ?, last_changed_at = ?, content_hash = ?,
       valid_for = ?, search_text = ? WHERE id = ?`,
  ).run(
    input.lang, input.title, body, input.url, dataJson, input.published_at ?? null, input.source_updated_at ?? null,
    ts, ts, hash, input.valid_for ?? null, searchText, input.id,
  );
  return 'changed';
}

function defaultSummary(oldRec: StoredRecord, next: RecordInput): LocalizedSummary {
  if (oldRec.title !== next.title) {
    return {
      en: `Title changed: "${oldRec.title}" → "${next.title}"`,
      tr: `Başlık değişti: "${oldRec.title}" → "${next.title}"`,
    };
  }
  const oldLines = new Set(oldRec.body.split('\n').map((l) => l.trim()).filter(Boolean));
  const added = (next.body ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !oldLines.has(l));
  if (added.length > 0) {
    const sample = added
      .slice(0, 3)
      .map((l) => `"${l.length > 160 ? l.slice(0, 159) + '…' : l}"`)
      .join('; ');
    const more = added.length > 3 ? added.length - 3 : 0;
    return {
      en: `Content updated. New/changed lines: ${sample}${more ? ` (+${more} more)` : ''}`,
      tr: `İçerik güncellendi. Yeni/değişen satırlar: ${sample}${more ? ` (+${more} satır daha)` : ''}`,
    };
  }
  return { en: 'Content updated (some lines were removed).', tr: 'İçerik güncellendi (bazı satırlar kaldırıldı).' };
}

interface VersionRow {
  record_id: string;
  kind: string;
  source: string;
  title: string;
  url: string;
  change_type: 'new' | 'changed';
  summary: string;
  old_hash: string | null;
  new_hash: string;
  old_body: string | null;
  old_data: string | null;
  changed_at: string;
}

function insertVersion(db: DatabaseSync, v: VersionRow): void {
  db.prepare(
    `INSERT INTO record_versions (record_id, kind, source, title, url, change_type, summary, old_hash, new_hash, old_body, old_data, changed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(v.record_id, v.kind, v.source, v.title, v.url, v.change_type, v.summary, v.old_hash, v.new_hash, v.old_body, v.old_data, v.changed_at);
}

export interface ListOptions {
  kind: RecordKind;
  lang?: Lang;
  sources?: string[];
  since?: string;
  query?: string;
  limit?: number;
  offset?: number;
}

/** Lists records, FTS5-filtered when `query` is given. Newest publication first. */
export function listRecords(db: DatabaseSync, opts: ListOptions): { rows: StoredRecord[]; total: number } {
  const where: string[] = ['r.kind = ?'];
  const params: (string | number)[] = [opts.kind];
  let from = 'records r';
  if (opts.lang) {
    where.push('r.lang = ?');
    params.push(opts.lang);
  }
  if (opts.sources?.length) {
    where.push(`r.source IN (${opts.sources.map(() => '?').join(',')})`);
    params.push(...opts.sources);
  }
  if (opts.since) {
    where.push('COALESCE(r.published_at, r.first_seen_at) >= ?');
    params.push(opts.since);
  }
  const fts = opts.query ? toFtsQuery(opts.query) : undefined;
  if (opts.query && !fts) return { rows: [], total: 0 };
  if (fts) {
    from = 'records r JOIN records_fts f ON f.rowid = r.rowid';
    where.push('records_fts MATCH ?');
    params.push(fts);
  }
  const whereSql = where.join(' AND ');
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM ${from} WHERE ${whereSql}`).get(...params) as { n: number }).n;
  const rows = db
    .prepare(
      `SELECT ${COLUMNS.split(', ').map((c) => `r.${c}`).join(', ')} FROM ${from} WHERE ${whereSql}
       ORDER BY COALESCE(r.published_at, r.first_seen_at) DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, opts.limit ?? 10, opts.offset ?? 0) as unknown as StoredRecord[];
  return { rows, total };
}

/** Full-text search across record kinds, ranked by BM25. */
export function searchRecords(
  db: DatabaseSync,
  query: string,
  kinds?: RecordKind[],
  limit = 10,
  lang?: Lang,
): StoredRecord[] {
  const fts = toFtsQuery(query);
  if (!fts) return [];
  const params: (string | number)[] = [fts];
  let kindSql = '';
  if (kinds?.length) {
    kindSql = `AND r.kind IN (${kinds.map(() => '?').join(',')})`;
    params.push(...kinds);
  }
  if (lang) {
    kindSql += ' AND r.lang = ?';
    params.push(lang);
  }
  return db
    .prepare(
      `SELECT ${COLUMNS.split(', ').map((c) => `r.${c}`).join(', ')}
       FROM records_fts f JOIN records r ON r.rowid = f.rowid
       WHERE records_fts MATCH ? ${kindSql}
       ORDER BY bm25(records_fts, 5.0, 1.0) LIMIT ?`,
    )
    .all(...params, limit) as unknown as StoredRecord[];
}

export interface ChangeRow {
  record_id: string;
  kind: string;
  source: string;
  lang: Lang;
  title: string;
  url: string;
  change_type: 'new' | 'changed';
  summary: LocalizedSummary;
  changed_at: string;
}

export function recentChanges(
  db: DatabaseSync,
  opts: { since: string; sources?: string[]; kinds?: string[]; lang?: Lang; limit?: number },
): ChangeRow[] {
  const where = ['v.changed_at >= ?'];
  const params: (string | number)[] = [opts.since];
  if (opts.sources?.length) {
    where.push(`v.source IN (${opts.sources.map(() => '?').join(',')})`);
    params.push(...opts.sources);
  }
  if (opts.kinds?.length) {
    where.push(`v.kind IN (${opts.kinds.map(() => '?').join(',')})`);
    params.push(...opts.kinds);
  }
  if (opts.lang) {
    where.push('r.lang = ?');
    params.push(opts.lang);
  }
  const rows = db
    .prepare(
      `SELECT v.record_id, v.kind, v.source, COALESCE(r.lang, 'tr') AS lang, v.title, v.url, v.change_type, v.summary, v.changed_at
       FROM record_versions v LEFT JOIN records r ON r.id = v.record_id
       WHERE ${where.join(' AND ')} ORDER BY v.changed_at DESC LIMIT ?`,
    )
    .all(...params, opts.limit ?? 30) as unknown as (Omit<ChangeRow, 'summary'> & { summary: string })[];
  return rows.map((r) => ({ ...r, summary: parseSummary(r.summary) }));
}

function parseSummary(raw: string): LocalizedSummary {
  try {
    const v = JSON.parse(raw) as Partial<LocalizedSummary>;
    if (v.en && v.tr) return { en: v.en, tr: v.tr };
  } catch {
    /* plain-text summary from an older row */
  }
  return { en: raw, tr: raw };
}
