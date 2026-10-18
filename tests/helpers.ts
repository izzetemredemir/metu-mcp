import { readFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { openDb, setDb } from '../src/store/db.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export function fixture(name: string): string {
  return readFileSync(path.join(here, 'fixtures', name), 'utf8');
}

/** Binary fixture (spreadsheets, images); `.gz` files are decompressed. */
export function fixtureBytes(name: string): Uint8Array {
  const raw = readFileSync(path.join(here, 'fixtures', name));
  return new Uint8Array(name.endsWith('.gz') ? gunzipSync(raw) : raw);
}

/** Fresh in-memory database, also installed as the process-wide instance. */
export function memoryDb() {
  const db = openDb(':memory:');
  setDb(db);
  return db;
}
