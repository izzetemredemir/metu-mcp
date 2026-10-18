import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DB_PATH } from '../config.js';

/**
 * One SQLite file (WAL). `worker` is the single writer, `serve` reads.
 * node:sqlite (built into Node 24) ships with FTS5, so no native dependency is needed.
 */

const MIGRATIONS: string[] = [
  `
  CREATE TABLE records (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    source TEXT NOT NULL,
    lang TEXT NOT NULL DEFAULT 'tr',
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL,
    data TEXT,
    published_at TEXT,
    source_updated_at TEXT,
    fetched_at TEXT NOT NULL,
    first_seen_at TEXT NOT NULL,
    last_changed_at TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    valid_for TEXT,
    search_text TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX records_kind_source ON records(kind, source, lang);
  CREATE INDEX records_published ON records(published_at);

  CREATE VIRTUAL TABLE records_fts USING fts5(
    title, search_text, content='records', content_rowid='rowid',
    tokenize = 'unicode61 remove_diacritics 2'
  );
  CREATE TRIGGER records_ai AFTER INSERT ON records BEGIN
    INSERT INTO records_fts(rowid, title, search_text) VALUES (new.rowid, new.title, new.search_text);
  END;
  CREATE TRIGGER records_ad AFTER DELETE ON records BEGIN
    INSERT INTO records_fts(records_fts, rowid, title, search_text) VALUES ('delete', old.rowid, old.title, old.search_text);
  END;
  CREATE TRIGGER records_au AFTER UPDATE OF title, search_text ON records BEGIN
    INSERT INTO records_fts(records_fts, rowid, title, search_text) VALUES ('delete', old.rowid, old.title, old.search_text);
    INSERT INTO records_fts(rowid, title, search_text) VALUES (new.rowid, new.title, new.search_text);
  END;

  CREATE TABLE record_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    record_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    source TEXT NOT NULL,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    change_type TEXT NOT NULL,
    summary TEXT NOT NULL,
    old_hash TEXT,
    new_hash TEXT NOT NULL,
    old_body TEXT,
    old_data TEXT,
    changed_at TEXT NOT NULL
  );
  CREATE INDEX record_versions_changed ON record_versions(changed_at);

  CREATE TABLE calendar_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    academic_year TEXT NOT NULL,
    lang TEXT NOT NULL,
    term TEXT NOT NULL,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    precision TEXT NOT NULL,
    date_text TEXT NOT NULL,
    title TEXT NOT NULL,
    detail TEXT NOT NULL,
    tags TEXT NOT NULL,
    search_text TEXT NOT NULL
  );
  CREATE INDEX calendar_events_dates ON calendar_events(lang, start_date, end_date);

  CREATE TABLE places (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category_id INTEGER NOT NULL,
    category TEXT NOT NULL,
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL,
    search_text TEXT NOT NULL
  );
  CREATE INDEX places_category ON places(category_id);

  CREATE TABLE collector_runs (
    collector TEXT PRIMARY KEY,
    last_run_at TEXT,
    last_success_at TEXT,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    last_items INTEGER
  );

  CREATE TABLE http_cache (
    url TEXT PRIMARY KEY,
    etag TEXT,
    last_modified TEXT,
    status INTEGER,
    body TEXT,
    fetched_at TEXT NOT NULL
  );

  CREATE TABLE link_checks (
    link_id TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    status TEXT NOT NULL,
    http_status INTEGER,
    final_url TEXT,
    checked_at TEXT NOT NULL
  );
  `,
  `
  CREATE TABLE catalog_programs (
    prog INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    degree TEXT NOT NULL DEFAULT '',
    faculty_id INTEGER NOT NULL,
    faculty TEXT NOT NULL,
    fetched_at TEXT NOT NULL
  );

  CREATE TABLE courses (
    code TEXT PRIMARY KEY,
    short_code TEXT NOT NULL,
    name TEXT NOT NULL,
    prog INTEGER NOT NULL,
    department TEXT NOT NULL,
    metu_credit REAL,
    contact_hours REAL,
    lab_hours REAL,
    ects REAL,
    credit_text TEXT,
    language TEXT,
    level TEXT,
    coordinator TEXT,
    offered_semester TEXT,
    prerequisites TEXT,
    prerequisite_note TEXT,
    content TEXT,
    url TEXT NOT NULL,
    search_text TEXT NOT NULL,
    listed_at TEXT NOT NULL,
    detail_fetched_at TEXT
  );
  CREATE INDEX courses_short_code ON courses(short_code);
  CREATE INDEX courses_prog ON courses(prog);
  CREATE INDEX courses_detail ON courses(detail_fetched_at);
  `,
  `
  CREATE TABLE events (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    title TEXT NOT NULL,
    organizer TEXT NOT NULL DEFAULT '',
    start TEXT,
    end TEXT,
    venue TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL,
    search_text TEXT NOT NULL,
    fetched_at TEXT NOT NULL
  );
  CREATE INDEX events_start ON events(start);
  `,
  `
  CREATE TABLE faq_queue (
    url TEXT PRIMARY KEY,
    question TEXT NOT NULL,
    grp TEXT NOT NULL,
    listed_at TEXT NOT NULL,
    fetched_at TEXT
  );
  `,
  `
  CREATE TABLE trainings (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT '',
    language TEXT,
    format TEXT,
    price TEXT,
    duration TEXT,
    start_text TEXT,
    start_date TEXT,
    end_date TEXT,
    registration TEXT,
    registration_status TEXT,
    enroll_url TEXT,
    url TEXT NOT NULL,
    search_text TEXT NOT NULL,
    listed_at TEXT NOT NULL,
    detail_fetched_at TEXT,
    fetched_at TEXT NOT NULL
  );
  CREATE INDEX trainings_start ON trainings(start_date);
  CREATE INDEX trainings_detail ON trainings(detail_fetched_at);
  `,
  `
  ALTER TABLE courses ADD COLUMN syllabus_urls TEXT;
  ALTER TABLE courses ADD COLUMN syllabus TEXT;
  ALTER TABLE courses ADD COLUMN syllabus_fetched_at TEXT;
  `,
  `
  -- OpenMETU theses harvested over OAI-PMH. The handle suffix (11511/<id>) is the rowid, so the FTS index survives VACUUM.
  CREATE TABLE theses (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    title_alt TEXT,
    author TEXT NOT NULL DEFAULT '',
    advisors TEXT NOT NULL DEFAULT '',
    department TEXT NOT NULL DEFAULT '',
    year INTEGER,
    degree TEXT NOT NULL,
    language TEXT,
    abstract TEXT NOT NULL DEFAULT '',
    subjects TEXT NOT NULL DEFAULT '',
    pdf_url TEXT,
    url TEXT NOT NULL,
    datestamp TEXT NOT NULL,
    search_text TEXT NOT NULL,
    fetched_at TEXT NOT NULL
  );
  CREATE INDEX theses_year ON theses(year);
  CREATE VIRTUAL TABLE theses_fts USING fts5(
    title, search_text, content='theses', content_rowid='id',
    tokenize = 'unicode61 remove_diacritics 2'
  );
  CREATE TRIGGER theses_ai AFTER INSERT ON theses BEGIN
    INSERT INTO theses_fts(rowid, title, search_text) VALUES (new.id, new.title, new.search_text);
  END;
  CREATE TRIGGER theses_ad AFTER DELETE ON theses BEGIN
    INSERT INTO theses_fts(theses_fts, rowid, title, search_text) VALUES ('delete', old.id, old.title, old.search_text);
  END;
  CREATE TRIGGER theses_au AFTER UPDATE OF title, search_text ON theses BEGIN
    INSERT INTO theses_fts(theses_fts, rowid, title, search_text) VALUES ('delete', old.id, old.title, old.search_text);
    INSERT INTO theses_fts(rowid, title, search_text) VALUES (new.id, new.title, new.search_text);
  END;

  -- Incremental OAI-PMH harvesting per set: an unfinished pass keeps its resumption token; a finished pass sets
  -- from_date, so the next pass only asks for records changed since.
  CREATE TABLE oai_state (
    set_spec TEXT PRIMARY KEY,
    from_date TEXT,
    token TEXT,
    pass_started TEXT
  );
  `,
  `
  -- Announcements stored twice, under /index.php/ (or index%2ephp) and the plain path: keep the plain one.
  DELETE FROM records
  WHERE kind = 'announcement' AND (instr(url, '/index.php/') > 0 OR instr(url, '/index%2ephp/') > 0)
    AND EXISTS (SELECT 1 FROM records r2 WHERE r2.url = replace(replace(records.url, '/index%2ephp', ''), '/index.php', ''));
  DELETE FROM record_versions WHERE record_id NOT IN (SELECT id FROM records);
  UPDATE records SET url = replace(replace(url, '/index%2ephp', ''), '/index.php', ''),
    id = 'announcement:' || replace(replace(url, '/index%2ephp', ''), '/index.php', '')
  WHERE kind = 'announcement' AND (instr(url, '/index.php/') > 0 OR instr(url, '/index%2ephp/') > 0);
  `,
  `
  -- OpenStreetMap features on campus (monthly), linked to the map.metu.edu.tr place inside their outline.
  CREATE TABLE osm_features (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    name_en TEXT,
    other_names TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL,
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    outline TEXT,
    place_id TEXT,
    search_text TEXT NOT NULL,
    fetched_at TEXT NOT NULL
  );
  CREATE INDEX osm_features_place ON osm_features(place_id);
  `,
  `
  -- LibGuides is no longer collected: its robots.txt bars AI agents. Drop what an earlier version stored.
  DELETE FROM records WHERE source = 'libguides';
  DELETE FROM record_versions WHERE record_id NOT IN (SELECT id FROM records);
  DELETE FROM collector_runs WHERE collector = 'page:libguides';
  DELETE FROM http_cache WHERE url LIKE 'https://libguides.lib.metu.edu.tr/%';
  `,
];

let instance: DatabaseSync | undefined;

export function openDb(file: string = DB_PATH): DatabaseSync {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let v = row.user_version; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

/** One connection per process. Tests can inject an in-memory database via `setDb`. */
export function getDb(): DatabaseSync {
  instance ??= openDb();
  return instance;
}

export function setDb(db: DatabaseSync): void {
  instance = db;
}

export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
