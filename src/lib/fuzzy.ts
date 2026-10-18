import type { DatabaseSync } from 'node:sqlite';
import { foldTr } from './text.js';

/**
 * Spelling correction for search queries ("kütüpane" → "kutuphane") against the full-text index's own vocabulary, so
 * only words that occur in collected data are suggested. Terms are folded the way the index folds them.
 */

/** Vocabulary cache: the index changes a few times an hour at most. */
const CACHE_MS = 30 * 60_000;
const caches = new WeakMap<DatabaseSync, { at: number; terms: Map<string, number> }>();

function vocabulary(db: DatabaseSync): Map<string, number> {
  const cached = caches.get(db);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.terms;
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS temp.records_vocab USING fts5vocab(main, records_fts, 'row')`);
  const rows = db.prepare('SELECT term, doc FROM temp.records_vocab WHERE length(term) >= 3').all() as { term: string; doc: number }[];
  const terms = new Map(rows.map((r) => [r.term, r.doc]));
  caches.set(db, { at: Date.now(), terms });
  return terms;
}

/** Levenshtein distance, stopping early once it exceeds `max`. */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, cur[j]!);
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length]!;
}

/**
 * The query with each unknown word (not a term, nor the prefix of one) replaced by the most frequent indexed term at the
 * smallest edit distance (1 for words up to 6 letters, 2 for longer ones). `undefined` when nothing needs correcting.
 */
export function correctQuery(db: DatabaseSync, query: string): string | undefined {
  const terms = vocabulary(db);
  const words = foldTr(query).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  let changed = false;
  const out = words.map((w) => {
    if (w.length < 4 || /\d/.test(w) || terms.has(w)) return w;
    for (const t of terms.keys()) if (t.startsWith(w)) return w;
    const max = w.length <= 6 ? 1 : 2;
    let best: { term: string; d: number; doc: number } | undefined;
    for (const [term, doc] of terms) {
      if (term[0] !== w[0]) continue;
      const d = editDistance(w, term, max);
      if (d > max) continue;
      if (!best || d < best.d || (d === best.d && doc > best.doc)) best = { term, d, doc };
    }
    if (!best) return w;
    changed = true;
    return best.term;
  });
  return changed ? out.join(' ') : undefined;
}
