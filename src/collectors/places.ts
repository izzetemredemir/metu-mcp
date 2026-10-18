import { MAP_CATEGORIES, MAP_MARKER_URL } from '../config.js';
import { cleanText, htmlToText } from '../lib/sanitize.js';
import { foldTr } from '../lib/text.js';
import { transaction } from '../store/db.js';
import { upsertRecord } from '../store/records.js';
import { politeFetch } from './http.js';
import { runUnit, type CollectorContext } from './runner.js';

export const PLACES_SOURCE = 'metu-map';

export interface Place {
  id: string;
  name: string;
  category_id: number;
  category: string;
  lat: number;
  lng: number;
  description: string;
}

/**
 * map.metu.edu.tr `POST /getmarker.php type=<id>` answers with script blocks like
 * `createMarker(lat, lng, "name", type, "descHtml", w, h, placeId, "slug");`.
 */
export function parseMarkers(body: string, categoryId: number): Place[] {
  const re =
    /createMarker\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*"((?:[^"\\]|\\.)*)"\s*,\s*(\d+)\s*,\s*"((?:[^"\\]|\\.)*)"\s*,\s*\d+\s*,\s*\d+\s*,\s*(\d+)/g;
  const out: Place[] = [];
  for (const m of body.matchAll(re)) {
    const unescape = (s: string) =>
      s
        .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
        .replace(/\\\//g, '/')
        .replace(/\\"/g, '"');
    const name = cleanText(htmlToText(unescape(m[3]!), 200).replace(/\n/g, ' '), 200);
    const descHtml = unescape(m[5]!).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    let description = htmlToText(descHtml, 800);
    if (foldTr(description.replace(/\s+/g, ' ')) === foldTr(name)) description = '';
    const lat = Number(m[1]);
    const lng = Number(m[2]);
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const type = Number(m[4]);
    out.push({
      id: `map:${m[6]}`,
      name,
      category_id: type || categoryId,
      category: MAP_CATEGORIES[type || categoryId]?.en ?? 'Other',
      lat,
      lng,
      description,
    });
  }
  return out;
}

export async function collectPlaces(ctx: CollectorContext): Promise<void> {
  await runUnit(ctx, 'places', async () => {
    const all = new Map<string, Place>();
    for (const id of Object.keys(MAP_CATEGORIES).map(Number)) {
      const res = await politeFetch(ctx.db, MAP_MARKER_URL, { method: 'POST', form: { type: String(id) }, conditional: false });
      for (const p of parseMarkers(res.body, id)) if (!all.has(p.id)) all.set(p.id, p);
    }
    if (all.size < 50) throw new Error(`only ${all.size} map markers parsed (endpoint change?)`);
    const places = [...all.values()].sort((a, b) => a.id.localeCompare(b.id));
    transaction(ctx.db, () => {
      ctx.db.prepare('DELETE FROM places WHERE source = ?').run(PLACES_SOURCE);
      const ins = ctx.db.prepare(
        `INSERT INTO places (id, name, category_id, category, lat, lng, description, source, search_text)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const p of places) {
        ins.run(p.id, p.name, p.category_id, p.category, p.lat, p.lng, p.description, PLACES_SOURCE, foldTr(`${p.name} ${p.description}`));
      }
    });
    upsertRecord(ctx.db, {
      id: 'places:metu-map',
      kind: 'places',
      source: PLACES_SOURCE,
      lang: 'en',
      title: 'METU campus map places',
      body: places.map((p) => `${p.category}: ${p.name}`).join('\n'),
      url: 'https://map.metu.edu.tr/',
      data: { count: places.length },
    });
    return places.length;
  });
}
