import { OSM_CAMPUS_BBOX, OSM_OVERPASS_URL } from '../config.js';
import { distanceMeters } from '../lib/geo.js';
import { cleanText } from '../lib/sanitize.js';
import { foldTr } from '../lib/text.js';
import { now } from '../lib/time.js';
import { transaction } from '../store/db.js';
import { politeFetch } from './http.js';
import { runUnit, type CollectorContext } from './runner.js';

/**
 * OpenStreetMap enrichment (weekly, one Overpass query): named buildings, amenities and sports facilities on the Ankara
 * campus with their outlines and the names students use (Turkish name, short / alternative names). Each feature is
 * linked to the map.metu.edu.tr place that lies inside its outline (or, for points, the nearest one within a few
 * metres), so Turkish queries like "Mediko" or "Üçlü Amfi" find the official map entry.
 */

export interface OsmFeature {
  id: string;
  name: string;
  name_en: string | null;
  other_names: string[];
  kind: string;
  lat: number;
  lng: number;
  /** Closed outline as [lat, lng] pairs (ways only). */
  outline: [number, number][] | null;
}

interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  bounds?: { minlat: number; minlon: number; maxlat: number; maxlon: number };
  geometry?: { lat: number; lon: number }[];
  members?: { role: string; geometry?: { lat: number; lon: number }[] }[];
  tags?: Record<string, string>;
}

export function overpassQuery(): string {
  const bbox = OSM_CAMPUS_BBOX.join(',');
  return (
    `[out:json][timeout:90];(` +
    `way["building"]["name"](${bbox});relation["building"]["name"](${bbox});` +
    `way["amenity"]["name"](${bbox});node["amenity"]["name"](${bbox});` +
    `way["leisure"]["name"](${bbox});` +
    `);out tags geom;`
  );
}

const OTHER_NAME_KEYS = ['short_name', 'alt_name', 'official_name', 'old_name', 'loc_name', 'name:tr'];

export function parseOverpass(json: string): OsmFeature[] {
  const elements = (JSON.parse(json) as { elements?: OverpassElement[] }).elements ?? [];
  const out: OsmFeature[] = [];
  for (const e of elements) {
    const tags = e.tags ?? {};
    const name = cleanText(tags.name ?? '', 200);
    if (!name) continue;
    // Ways carry their geometry; relations (multipolygons) the geometry of their outer members.
    const ring = e.geometry ?? e.members?.find((m) => m.role === 'outer')?.geometry;
    const outline = ring && ring.length >= 4 ? ring.map((p) => [p.lat, p.lon] as [number, number]) : null;
    let lat = e.lat;
    let lng = e.lon;
    if (lat === undefined || lng === undefined) {
      if (outline) {
        lat = outline.reduce((s, p) => s + p[0], 0) / outline.length;
        lng = outline.reduce((s, p) => s + p[1], 0) / outline.length;
      } else if (e.bounds) {
        lat = (e.bounds.minlat + e.bounds.maxlat) / 2;
        lng = (e.bounds.minlon + e.bounds.maxlon) / 2;
      } else continue;
    }
    const others = OTHER_NAME_KEYS.flatMap((k) => (tags[k] ?? '').split(';'))
      .map((n) => cleanText(n, 120))
      .filter((n) => n && n !== name);
    out.push({
      id: `${e.type}/${e.id}`,
      name,
      name_en: tags['name:en'] ? cleanText(tags['name:en'], 200) : null,
      other_names: [...new Set(others)],
      kind: tags.building ? 'building' : (tags.amenity ?? tags.leisure ?? 'other'),
      lat,
      lng,
      outline: e.type === 'node' ? null : outline,
    });
  }
  return out;
}

/** Ray casting; the outline is [lat, lng] pairs. */
export function insideOutline(lat: number, lng: number, outline: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
    const [yi, xi] = outline[i]!;
    const [yj, xj] = outline[j]!;
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Points (no outline) are linked only to a map place this close. */
const POINT_LINK_M = 25;

/**
 * The map place a feature stands for: a place inside its outline (the one nearest the outline's centre when several
 * are), else for points the nearest place within POINT_LINK_M. Parking lots and bus stops are never the building.
 */
export function linkPlace(f: OsmFeature, places: { id: string; lat: number; lng: number; category_id: number }[]): string | null {
  const candidates = places.filter((p) => p.category_id !== 7 && p.category_id !== 23);
  const hits = f.outline
    ? candidates.filter((p) => insideOutline(p.lat, p.lng, f.outline!))
    : candidates.filter((p) => distanceMeters(f.lat, f.lng, p.lat, p.lng) <= POINT_LINK_M);
  hits.sort((a, b) => distanceMeters(f.lat, f.lng, a.lat, a.lng) - distanceMeters(f.lat, f.lng, b.lat, b.lng));
  return hits[0]?.id ?? null;
}

export async function collectOsm(ctx: CollectorContext): Promise<void> {
  await runUnit(ctx, 'osm', async () => {
    const res = await politeFetch(ctx.db, OSM_OVERPASS_URL, { method: 'POST', form: { data: overpassQuery() }, timeoutMs: 120_000 });
    const features = parseOverpass(res.body);
    if (features.length < 50) throw new Error(`only ${features.length} OSM features parsed (Overpass error or empty area?)`);
    const places = ctx.db.prepare('SELECT id, lat, lng, category_id FROM places').all() as { id: string; lat: number; lng: number; category_id: number }[];
    const ts = now().toISOString();
    transaction(ctx.db, () => {
      ctx.db.prepare('DELETE FROM osm_features').run();
      const ins = ctx.db.prepare(
        `INSERT INTO osm_features (id, name, name_en, other_names, kind, lat, lng, outline, place_id, search_text, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const f of features) {
        ins.run(f.id, f.name, f.name_en, f.other_names.join('; '), f.kind, f.lat, f.lng, f.outline ? JSON.stringify(f.outline) : null,
          linkPlace(f, places), foldTr([f.name, f.name_en, ...f.other_names].filter(Boolean).join(' ')), ts);
      }
    });
    return features.length;
  });
}
