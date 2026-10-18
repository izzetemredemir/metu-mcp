import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { parse } from 'yaml';
import { distanceMeters } from './lib/geo.js';
import { escapeRegex, foldTr, matchScore } from './lib/text.js';

export interface PlaceRow {
  id: string;
  name: string;
  category_id: number;
  category: string;
  lat: number;
  lng: number;
  description: string;
}

export const PARKING_CATEGORY_ID = 7;
export const TRANSPORT_CATEGORY_ID = 23;
/** Parking lots, ATMs, banks and bus stops named after a building rank just below the building itself. */
const DEPRIORITIZED_CATEGORIES = new Set([PARKING_CATEGORY_ID, 5, 13, TRANSPORT_CATEGORY_ID]);

const ALIASES_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data/places_aliases.yaml');
let aliases: [RegExp, string[]][] | undefined;

function loadAliases(): [RegExp, string[]][] {
  if (aliases) return aliases;
  const raw = parse(readFileSync(ALIASES_FILE, 'utf8')) as Record<string, string[]>;
  aliases = Object.entries(raw)
    .map(([k, v]) => [new RegExp(`(^|[^a-z0-9])${escapeRegex(foldTr(k))}([^a-z0-9]|$)`), v] as [RegExp, string[]])
    // Longer keys first so "Kimya Mühendisliği" wins over "Kimya".
    .sort((a, b) => b[0].source.length - a[0].source.length);
  return aliases;
}

/** Expands student shorthand ("MM önü", "BÖTE", "kafeterya") into English map search terms. */
export function expandQuery(query: string): string[] {
  const f = foldTr(query);
  const out: string[] = [];
  for (const [re, terms] of loadAliases()) {
    if (re.test(f)) {
      out.push(...terms);
      break;
    }
  }
  out.push(query);
  return out;
}

export function allPlaces(db: DatabaseSync, categoryId?: number): PlaceRow[] {
  const sql = 'SELECT id, name, category_id, category, lat, lng, description FROM places';
  return (categoryId === undefined
    ? db.prepare(sql).all()
    : db.prepare(`${sql} WHERE category_id = ?`).all(categoryId)) as unknown as PlaceRow[];
}

/** OpenStreetMap feature on campus (collectors/osm.ts), linked to a map place when one lies inside its outline. */
export interface OsmRow {
  id: string;
  name: string;
  name_en: string | null;
  other_names: string;
  kind: string;
  lat: number;
  lng: number;
  place_id: string | null;
}

/** Map category id of OSM-only places (no map.metu.edu.tr entry inside the outline). */
export const OSM_CATEGORY_ID = 0;

function osmRows(db: DatabaseSync): OsmRow[] {
  return db.prepare('SELECT id, name, name_en, other_names, kind, lat, lng, place_id FROM osm_features').all() as unknown as OsmRow[];
}

const osmNames = (o: OsmRow) => [o.name, o.name_en, ...o.other_names.split('; ')].filter((n): n is string => Boolean(n));

/** Best score of `name` against the expanded query terms (alias hits rank above raw-query hits). */
function nameScore(name: string, terms: string[]): number {
  let score = 0;
  terms.forEach((t, i) => {
    const weight = i === terms.length - 1 ? 1 : 1.5;
    const s = matchScore(name, t) * weight;
    const exact = foldTr(name).startsWith(foldTr(t)) ? 0.5 : 0;
    score = Math.max(score, s + exact);
  });
  return score;
}

/**
 * Finds places by name (with alias expansion), best match first. OpenStreetMap names (Turkish, short and alternative
 * names such as "Mediko", "Üçlü Amfi") count for the map place inside the OSM outline; OSM features without a map entry
 * are returned as places of category OSM_CATEGORY_ID.
 */
export function searchPlaces(db: DatabaseSync, query: string, opts: { categoryId?: number; limit?: number } = {}): PlaceRow[] {
  const places = allPlaces(db, opts.categoryId);
  const terms = expandQuery(query);
  const scores = new Map<string, { p: PlaceRow; score: number }>();
  for (const p of places) {
    let score = nameScore(p.name, terms);
    // Prefer the building itself over "Library Parking Lot", "Library Bus Station", "Dormitory … ATM".
    if (opts.categoryId === undefined && DEPRIORITIZED_CATEGORIES.has(p.category_id)) score -= 0.05;
    scores.set(p.id, { p, score });
  }
  for (const o of osmRows(db)) {
    const score = Math.max(...osmNames(o).map((n) => nameScore(n, terms)));
    if (score < 0.5) continue;
    const linked = o.place_id ? scores.get(o.place_id) : undefined;
    if (linked) linked.score = Math.max(linked.score, score);
    else if (!o.place_id && opts.categoryId === undefined) {
      const p: PlaceRow = { id: `osm:${o.id}`, name: o.name_en ?? o.name, category_id: OSM_CATEGORY_ID, category: 'OpenStreetMap', lat: o.lat, lng: o.lng, description: o.name_en ? o.name : '' };
      scores.set(p.id, { p, score: score - 0.05 }); // an official map entry with the same score wins
    }
  }
  return [...scores.values()]
    .filter((x) => x.score >= 0.5)
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.limit ?? 5)
    .map((x) => x.p);
}

/** OSM names and outline of a place (its own OSM feature, or the map place an OSM feature is linked to). */
export function osmDetails(db: DatabaseSync, placeId: string): { names: string[]; outline: [number, number][] | null } | undefined {
  const row = (
    placeId.startsWith('osm:')
      ? db.prepare('SELECT name, name_en, other_names, outline FROM osm_features WHERE id = ?').get(placeId.slice(4))
      : db.prepare(`SELECT name, name_en, other_names, outline FROM osm_features WHERE place_id = ? ORDER BY kind = 'building' DESC LIMIT 1`).get(placeId)
  ) as { name: string; name_en: string | null; other_names: string; outline: string | null } | undefined;
  if (!row) return undefined;
  const names = [row.name, ...row.other_names.split('; ')].filter(Boolean);
  return { names: [...new Set(names)], outline: row.outline ? (JSON.parse(row.outline) as [number, number][]) : null };
}

export function nearestPlaces(
  db: DatabaseSync,
  lat: number,
  lng: number,
  opts: { categoryId?: number; limit?: number; maxMeters?: number } = {},
): (PlaceRow & { distance_m: number })[] {
  return allPlaces(db, opts.categoryId)
    .map((p) => ({ ...p, distance_m: Math.round(distanceMeters(lat, lng, p.lat, p.lng)) }))
    .filter((p) => p.distance_m <= (opts.maxMeters ?? 1000))
    .sort((a, b) => a.distance_m - b.distance_m)
    .slice(0, opts.limit ?? 5);
}

export interface ClassroomMatch {
  code: string;
  building: string;
  place: PlaceRow | undefined;
}

/**
 * Classroom code → building ("BMB G102", "hza105", "YP-D101"). An exact code wins; otherwise a code ending with the
 * query ("G102") is accepted when it identifies one building. Returns [] when the query is not a classroom code.
 */
export function findClassroom(db: DatabaseSync, query: string): ClassroomMatch[] {
  const rec = db.prepare('SELECT data FROM records WHERE id = ?').get('classrooms:metu') as { data: string | null } | undefined;
  if (!rec?.data) return [];
  const buildings = (JSON.parse(rec.data) as { buildings: { building: string; place_id: string | null; codes: string[] }[] }).buildings;
  const cleaned = foldTr(query).replace(/\b(derslik|derslig\w*|sinif\w*|classroom|room|nerede|where|is|the)\b/g, ' ');
  const q = cleaned.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (q.length < 2 || !/\d/.test(q)) return [];
  const norm = (c: string) => c.toUpperCase().replace(/[^A-Z0-9İ]/g, '').replace(/İ/g, 'I');
  const placeOf = (id: string | null) =>
    id ? (db.prepare('SELECT id, name, category_id, category, lat, lng, description FROM places WHERE id = ?').get(id) as PlaceRow | undefined) : undefined;
  const hits = (pred: (code: string) => boolean) =>
    buildings.flatMap((b) => b.codes.filter((c) => pred(norm(c))).map((c) => ({ code: c, building: b.building, place: placeOf(b.place_id) })));
  const exact = hits((c) => c === q);
  if (exact.length) return exact;
  const suffix = q.length >= 3 ? hits((c) => c.endsWith(q)) : [];
  return new Set(suffix.map((s) => s.building)).size === 1 ? suffix : suffix.slice(0, 5);
}
