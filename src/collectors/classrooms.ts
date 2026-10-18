import * as cheerio from 'cheerio';
import { CLASSROOMS_URL } from '../config.js';
import { cleanText } from '../lib/sanitize.js';
import { upsertRecord } from '../store/records.js';
import { politeFetch } from './http.js';
import { runUnit, type CollectorContext } from './runner.js';

/**
 * "Location of classrooms on METU campus" (www.metu.edu.tr): one table row per building with its classroom codes;
 * building (or block) names link to `map.metu.edu.tr/place/<id>/…`, the same ids as our `places` table (`map:<id>`).
 */

export interface ClassroomBuilding {
  building: string;
  /** Map place id (`map:<id>`), when the row links to the campus map. */
  place_id: string | null;
  codes: string[];
}

export const CLASSROOMS_RECORD_ID = 'classrooms:metu';

/** "BMB G102", "yp-a1", "HZ F105" → "BMBG102", "YPA1", "HZF105". */
export function normalizeRoomCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9İ]/g, '');
}

const placeId = (href: string | undefined) => {
  const id = /map\.metu\.edu\.tr\/place\/(\d+)/.exec(href ?? '')?.[1];
  return id ? `map:${id}` : null;
};

const splitCodes = (text: string) =>
  text
    .split(/[,;]/)
    .map((c) => cleanText(c.replace(/^:/, ''), 30))
    .filter((c) => c.length >= 2);

export function parseClassrooms(html: string): ClassroomBuilding[] {
  const $ = cheerio.load(html);
  const out: ClassroomBuilding[] = [];
  $('table tr').each((_, tr) => {
    const left = $(tr).find('td').first();
    const right = $(tr).find('td').eq(1);
    if (!right.length || left.hasClass('tbleftbold')) return;
    const building = cleanText(left.text().replace(/\s+/g, ' '), 200);
    const blocks = right.find('a[href*="map.metu.edu.tr/place/"]');
    if (blocks.length > 0 && /Block/i.test(blocks.first().text())) {
      // Blocks of one building, each "X Block: CODE, CODE, …" with its own map link.
      const html = right.html() ?? '';
      const parts = html.split(/(?=<a\s)/i).filter((p) => /<a\s/i.test(p));
      for (const part of parts) {
        const p = cheerio.load(`<div>${part}</div>`);
        const a = p('a').first();
        const codes = splitCodes(p('div').text().replace(a.text(), ''));
        if (codes.length) out.push({ building: `${building} — ${cleanText(a.text(), 60)}`, place_id: placeId(a.attr('href')), codes });
      }
      return;
    }
    const codes = splitCodes(right.text());
    if (building && codes.length) out.push({ building, place_id: placeId(left.find('a').attr('href')), codes });
  });
  return out;
}

/** Weekly (with the map): which building each classroom code is in. */
export async function collectClassrooms(ctx: CollectorContext): Promise<void> {
  await runUnit(ctx, 'classrooms', async () => {
    const buildings = parseClassrooms((await politeFetch(ctx.db, CLASSROOMS_URL)).body);
    if (buildings.length < 10) throw new Error(`only ${buildings.length} classroom buildings parsed (layout change?)`);
    upsertRecord(ctx.db, {
      id: CLASSROOMS_RECORD_ID,
      kind: 'places',
      source: 'metu-classrooms',
      lang: 'en',
      title: 'Classroom locations on METU campus',
      body: buildings.map((b) => `${b.building}: ${b.codes.join(', ')}`).join('\n'),
      url: CLASSROOMS_URL,
      data: { buildings },
    });
    return buildings.length;
  });
}
