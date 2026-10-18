import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { PAGE_SOURCES, type Localized } from './config.js';
import { distanceMeters } from './lib/geo.js';
import { foldTr } from './lib/text.js';
import { getRecord } from './store/records.js';

/**
 * Ring bus routes from the collected TİM ring pages ("Sarı Ring Güzergahı" tables), with each stop placed on the map
 * through data/ring_stops.yaml. Used by metu_campus_route to name the ring that connects two places.
 */

export interface RingRoute {
  /** Route heading as published, e.g. "Sarı Ring Güzergahı". */
  name: string;
  stops: string[];
}

/**
 * Route tables of one ring page (stored text). The tables have two "Sıra | Durak Yeri" column pairs per row, so the text
 * interleaves both columns ("1, A-2 Metro Kapısı, 11, Makina Mühendisliği, 2, Kolej, …"). A stop belongs to the left
 * column when its number continues the left sequence, else to the right one; the route is left then right. This also
 * survives the tables' numbering slips (two stops numbered 11).
 */
export function parseRingRoutes(text: string): RingRoute[] {
  const out: RingRoute[] = [];
  const sections = text.split(/\n(?=[^\n]*Güzergah[ıi]?\s*\n)/);
  for (const section of sections.slice(1)) {
    const lines = section.split('\n').map((l) => l.trim());
    const name = lines[0]!;
    const left: string[] = [];
    const right: string[] = [];
    let lastLeft = 0;
    let lastRight = 0;
    let pending: number | undefined;
    const place = (n: number, stop: string) => {
      // The first stop opens the left column whatever its number (the red ring continues the yellow one at 21).
      const toLeft = lastLeft === 0 || n === lastLeft + 1 || (lastRight > 0 && n !== lastRight + 1 && n < lastRight);
      if (toLeft) lastLeft = n;
      else lastRight = n;
      if (stop) (toLeft ? left : right).push(stop);
    };
    for (const line of lines.slice(1)) {
      if (/^(ring nerede|odtü harita)/i.test(line) || /güzergah/i.test(line)) break;
      if (!line || /^(sıra|durak yeri)$/i.test(line)) continue;
      if (/^\d{1,2}$/.test(line)) {
        if (pending !== undefined) place(pending, '');
        pending = Number(line);
        continue;
      }
      if (pending === undefined) continue; // notes between tables
      place(pending, line.replace(/^(başlangıç|bitiş)\s*:?\s*/i, '').trim());
      pending = undefined;
    }
    if (pending !== undefined) place(pending, '');
    const stops = [...left, ...right];
    if (stops.length >= 3) out.push({ name, stops });
  }
  return out;
}

const STOPS_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data/ring_stops.yaml');
const key = (s: string) => foldTr(s).replace(/[^a-z0-9]+/g, ' ').trim();
let stopPlaces: Map<string, string> | undefined;

function stopPlaceName(stop: string): string | undefined {
  stopPlaces ??= new Map(Object.entries(parse(readFileSync(STOPS_FILE, 'utf8')) as Record<string, string>).map(([k, v]) => [key(k), v]));
  return stopPlaces.get(key(stop));
}

export interface RingLine {
  page_id: string;
  title: Localized;
  url: string;
  route: string;
  stops: { name: string; lat: number; lng: number }[];
}

/** Every route of the collected ring pages with map coordinates per stop (stops missing from the alias file are dropped). */
export function ringLines(db: DatabaseSync): RingLine[] {
  const coords = db.prepare('SELECT lat, lng FROM places WHERE name = ? LIMIT 1');
  const out: RingLine[] = [];
  for (const src of PAGE_SOURCES.filter((p) => p.id.startsWith('ring-'))) {
    const rec = getRecord(db, `page:${src.id}:tr`);
    if (!rec) continue;
    for (const r of parseRingRoutes(rec.body)) {
      const stops = r.stops.flatMap((name) => {
        const placeName = stopPlaceName(name);
        const p = placeName ? (coords.get(placeName) as { lat: number; lng: number } | undefined) : undefined;
        return p ? [{ name, lat: p.lat, lng: p.lng }] : [];
      });
      out.push({ page_id: src.id, title: src.title, url: rec.url, route: r.name, stops });
    }
  }
  return out;
}

export interface RingSuggestion {
  line: RingLine;
  board: string;
  alight: string;
  stops_between: number;
  walk_to_board_m: number;
  walk_from_alight_m: number;
}

/** Stops farther than this from the start or the destination are not offered. */
const MAX_WALK_M = 600;
/** A stop ridden costs about as much as walking this far (a ring stop is ~1 min apart; walking 40 m is ~30 s). */
const STOP_COST_M = 40;
const score = (x: RingSuggestion) => x.walk_to_board_m + x.walk_from_alight_m + x.stops_between * STOP_COST_M;

/**
 * Rings that run from a stop near `a` to a later stop near `b` (routes are one-directional lists, loops included), best
 * first by total walking, then by stops ridden; at most one suggestion per ring page.
 */
export function suggestRings(lines: RingLine[], a: { lat: number; lng: number }, b: { lat: number; lng: number }): RingSuggestion[] {
  const best = new Map<string, RingSuggestion>();
  for (const line of lines) {
    const dA = line.stops.map((s) => distanceMeters(a.lat, a.lng, s.lat, s.lng));
    const dB = line.stops.map((s) => distanceMeters(b.lat, b.lng, s.lat, s.lng));
    for (let i = 0; i < line.stops.length; i++) {
      if (dA[i]! > MAX_WALK_M) continue;
      for (let j = i + 1; j < line.stops.length; j++) {
        if (dB[j]! > MAX_WALK_M || line.stops[j]!.name === line.stops[i]!.name) continue;
        const s: RingSuggestion = {
          line,
          board: line.stops[i]!.name,
          alight: line.stops[j]!.name,
          stops_between: j - i,
          walk_to_board_m: Math.round(dA[i]!),
          walk_from_alight_m: Math.round(dB[j]!),
        };
        const prev = best.get(line.page_id);
        if (!prev || score(s) < score(prev)) best.set(line.page_id, s);
      }
    }
  }
  return [...best.values()].sort((x, y) => score(x) - score(y));
}
