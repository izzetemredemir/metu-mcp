import type { DatabaseSync } from 'node:sqlite';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { MAP_CATEGORIES, OSM_ATTRIBUTION, type Lang } from '../config.js';
import { t } from '../i18n.js';
import { distanceMeters, isOnCampus, mapLink } from '../lib/geo.js';
import { formatHm, istanbulClock, now } from '../lib/time.js';
import { weekdayName } from '../lib/trdate.js';
import { evaluate, loadParkingRules, PERMIT_TYPES, zoneOf, type Verdict } from '../parking.js';
import {
  findClassroom,
  nearestPlaces,
  OSM_CATEGORY_ID,
  osmDetails,
  PARKING_CATEGORY_ID,
  searchPlaces,
  TRANSPORT_CATEGORY_ID,
  type PlaceRow,
} from '../places.js';
import { ringLines, suggestRings } from '../ring.js';
import { computeFreshness, type Freshness } from '../store/freshness.js';
import { getRecord } from '../store/records.js';
import { answer, COMMON_OUTPUT, LangSchema, READ_ONLY, recordFreshness, seeAlso, toolError } from './common.js';

/** Below this straight-line distance walking wins; no ring is suggested. */
const RING_MIN_DISTANCE_M = 800;

const PlaceOut = z.object({
  name: z.string(),
  category: z.string(),
  lat: z.number(),
  lng: z.number(),
  map_url: z.string(),
  description: z.string(),
  distance_m: z.number().optional(),
  local_names: z.array(z.string()).optional().describe('Names used on OpenStreetMap (Turkish, short names)'),
  outline: z.array(z.tuple([z.number(), z.number()])).optional().describe('Building outline as [lat, lng] pairs (OpenStreetMap)'),
});

function placeOut(p: PlaceRow & { distance_m?: number }, lang: Lang, db?: DatabaseSync) {
  const osm = db ? osmDetails(db, p.id) : undefined;
  return {
    name: p.name,
    category:
      p.category_id === OSM_CATEGORY_ID
        ? lang === 'tr'
          ? 'Yer (OpenStreetMap)'
          : 'Place (OpenStreetMap)'
        : (MAP_CATEGORIES[p.category_id]?.[lang] ?? p.category),
    lat: p.lat,
    lng: p.lng,
    map_url: mapLink(p.lat, p.lng),
    description: p.description,
    ...(p.distance_m !== undefined ? { distance_m: p.distance_m } : {}),
    ...(osm ? { local_names: osm.names.filter((n) => n !== p.name), ...(osm.outline ? { outline: osm.outline } : {}) } : {}),
  };
}

function placesFreshness(db: DatabaseSync, lang: Lang): Freshness {
  const rec = getRecord(db, 'places:metu-map');
  return rec
    ? recordFreshness(db, rec, 'places', lang)
    : computeFreshness(db, { kind: 'places', collector: 'places', source_url: 'https://map.metu.edu.tr/' }, lang);
}

const CATEGORY_KEYS = Object.fromEntries(Object.entries(MAP_CATEGORIES).map(([id, l]) => [l.en.toLowerCase().replace(/[^a-z]+/g, '-'), Number(id)]));

const VERDICT_TEXT: Record<Verdict, Record<Lang, string>> = {
  yes: { en: 'allowed', tr: 'izinli' },
  no: { en: 'not allowed', tr: 'izin yok' },
  'only-off-hours': { en: 'only outside working hours', tr: 'yalnızca mesai dışında' },
  'not-listed': { en: 'not covered by the rules — check signs', tr: 'kurallarda yok — tabelaya bak' },
};

export function registerCampusTools(server: McpServer, db: DatabaseSync): void {
  server.registerTool(
    'metu_campus_place',
    {
      title: 'Find a place on METU campus',
      description:
        'Finds buildings, departments, parking lots, gates, ATMs, banks, food places, libraries, health units and more on ' +
        'the METU Ankara campus map, with coordinates and a map link. Understands student shorthand such as "MM", "BMB", ' +
        '"KKM", "BÖTE", "çarşı", "mediko", "A2 kapısı", and classroom codes such as "BMB G102", "HZF105", "YP-D101", ' +
        '"U2" (which building a classroom is in). Place names come from map.metu.edu.tr (English); Turkish and short ' +
        'names ("Mediko", "Üçlü Amfi", "Kafes") and building outlines come from OpenStreetMap.',
      inputSchema: z.object({
        query: z.string().min(1).max(120).describe('Place name or shorthand'),
        category: z
          .enum(Object.keys(CATEGORY_KEYS) as [string, ...string[]])
          .optional()
          .describe('Restrict to one map category'),
        limit: z.number().int().min(1).max(10).default(5),
        lang: LangSchema,
      }),
      outputSchema: z.object({ places: z.array(PlaceOut), ...COMMON_OUTPUT }),
      annotations: { ...READ_ONLY, title: 'Find a place on METU campus' },
    },
    async ({ query, category, limit, lang }) => {
      const rooms = category ? [] : findClassroom(db, query);
      const roomPlaces = rooms.map((r) => r.place).filter((p): p is PlaceRow => p !== undefined);
      const found = roomPlaces.length
        ? [...new Map(roomPlaces.map((p) => [p.id, p])).values()].slice(0, limit)
        : searchPlaces(db, query, { categoryId: category ? CATEGORY_KEYS[category] : undefined, limit });
      const places = found.map((p) => placeOut(p, lang, db));
      const usesOsm = places.some((p) => p.local_names?.length || p.outline);
      const roomLines = rooms.map((r) => `${lang === 'tr' ? 'Derslik' : 'Classroom'} ${r.code}: ${r.building}`);
      const text = places.length
        ? [
            ...roomLines,
            ...places.map(
              (p) =>
                `• ${p.name} (${p.category})${p.local_names?.length ? ` — ${lang === 'tr' ? 'diğer adları' : 'also known as'}: ${p.local_names.join(', ')}` : ''}` +
                `\n  ${p.map_url}${p.description ? `\n  ${p.description.replace(/\n/g, ' ')}` : ''}`,
            ),
            ...(usesOsm ? [`${lang === 'tr' ? 'Bina adları ve sınırları' : 'Building names and outlines'}: ${OSM_ATTRIBUTION}`] : []),
          ].join('\n')
        : t(lang, 'no_results');
      return answer({
        lang,
        text,
        data: { places },
        freshness: [
          placesFreshness(db, lang),
          ...(usesOsm ? [computeFreshness(db, { kind: 'places', collector: 'osm', source_url: 'https://www.openstreetmap.org/' }, lang)] : []),
        ],
        see_also: places.length ? undefined : seeAlso(db, { query: 'harita map', category: 'campus' }, lang),
      });
    },
  );

  server.registerTool(
    'metu_parking_check',
    {
      title: 'Can I park here?',
      description:
        'Answers "can I park here?" on METU campus. Give a place (building, department, shorthand like "MM önü", ' +
        '"kütüphane") or coordinates, and the vehicle-permit type. Returns the nearest parking lots with an allowed / ' +
        'not allowed / only-off-hours verdict for that permit at the given time, the official rule text and a link. ' +
        'Permit types: yellow = student sarı pul, brown = student kahverengi pul, graduate = alumni, staff = personnel, ' +
        'none = no permit. The verdict is a summary of the official rules, not a guarantee: signs on site prevail.',
      inputSchema: z.object({
        place: z.string().max(120).optional().describe('Where the student wants to park'),
        lat: z.number().optional(),
        lng: z.number().optional(),
        permit: z.enum(PERMIT_TYPES).describe('Vehicle permit the student has'),
        at: z
          .string()
          .datetime({ offset: true })
          .optional()
          .describe('When they want to park (ISO 8601 with offset). Default: now'),
        lang: LangSchema,
      }),
      outputSchema: z.object({
        target: PlaceOut.nullable(),
        permit: z.string(),
        evaluated_at: z.string(),
        lots: z.array(
          PlaceOut.extend({
            zone: z.string().nullable(),
            verdict: z.enum(['yes', 'no', 'only-off-hours', 'not-listed']),
            allowed_at_time: z.boolean().nullable(),
          }),
        ),
        rule_text: z.string(),
        notes: z.string(),
        general_rules: z.array(z.string()),
        rules_may_have_changed: z.boolean(),
        ...COMMON_OUTPUT,
      }),
      annotations: { ...READ_ONLY, title: 'Can I park here?' },
    },
    async ({ place, lat, lng, permit, at, lang }) => {
      const rules = loadParkingRules();
      let target: (PlaceRow & { distance_m?: number }) | undefined;
      if (lat !== undefined && lng !== undefined) {
        if (!isOnCampus(lat, lng)) return toolError(lang === 'tr' ? 'Koordinatlar ODTÜ Ankara yerleşkesinin dışında.' : 'These coordinates are outside the METU Ankara campus.', lang);
        target = { id: 'coords', name: `${lat.toFixed(5)}, ${lng.toFixed(5)}`, category_id: 0, category: 'Location', lat, lng, description: '' };
      } else if (place) {
        target = searchPlaces(db, place, { limit: 1 })[0];
        if (!target) {
          return toolError(
            lang === 'tr'
              ? `"${place}" haritada bulunamadı. Bina/bölüm adını ya da kısaltmasını dene (ör. "Kütüphane", "MM", "KKM").`
              : `"${place}" was not found on the campus map. Try a building/department name or shorthand (e.g. "Library", "MM", "KKM").`,
            lang,
            seeAlso(db, { query: 'park parking', category: 'parking' }, lang),
          );
        }
      } else {
        return toolError(lang === 'tr' ? '`place` ya da `lat`+`lng` ver.' : 'Provide `place` or both `lat` and `lng`.', lang);
      }

      const when = at ? new Date(at) : now();
      const clock = istanbulClock(when);
      const lots =
        target.category_id === PARKING_CATEGORY_ID
          ? [{ ...target, distance_m: 0 }, ...nearestPlaces(db, target.lat, target.lng, { categoryId: PARKING_CATEGORY_ID, limit: 4, maxMeters: 600 }).filter((p) => p.id !== target!.id)]
          : nearestPlaces(db, target.lat, target.lng, { categoryId: PARKING_CATEGORY_ID, limit: 5, maxMeters: 600 });
      const evaluated = lots.map((lot) => {
        const e = evaluate(permit, lot.name, clock, rules);
        return { ...placeOut(lot, lang), zone: zoneOf(lot.name, rules)?.name[lang] ?? null, verdict: e.verdict, allowed_at_time: e.allowed_now };
      });

      const p = rules.permits[permit]!;
      const pageRec = getRecord(db, 'page:ihm-parking-by-permit:tr');
      const changedSince = db
        .prepare(
          "SELECT 1 FROM record_versions WHERE record_id = 'page:ihm-parking-by-permit:tr' AND change_type = 'changed' AND changed_at > ? LIMIT 1",
        )
        .get(`${rules.verified_on}T23:59:59+03:00`);
      const freshness: Freshness[] = [
        pageRec
          ? recordFreshness(db, pageRec, 'page:ihm-parking-by-permit', lang)
          : computeFreshness(db, { kind: 'page', collector: 'page:ihm-parking-by-permit', source_url: rules.source_url }, lang),
        placesFreshness(db, lang),
      ];

      const timeLabel = `${weekdayName(clock.weekday, lang)} ${formatHm(clock.minutes)}`;
      const lines: string[] = [];
      lines.push(
        lang === 'tr'
          ? `${p.name.tr} ile "${target.name}" çevresi (${timeLabel}, İstanbul saati):`
          : `${p.name.en} near "${target.name}" (${timeLabel}, Istanbul time):`,
      );
      if (evaluated.length === 0) {
        lines.push(lang === 'tr' ? '600 m içinde haritada kayıtlı otopark yok.' : 'No mapped parking lot within 600 m.');
      }
      for (const l of evaluated) {
        const now = l.verdict === 'only-off-hours' ? (l.allowed_at_time ? (lang === 'tr' ? ' → şu an uygun' : ' → allowed right now') : lang === 'tr' ? ' → şu an uygun değil' : ' → not allowed right now') : '';
        lines.push(`• ${l.name} (${l.distance_m ?? 0} m): ${VERDICT_TEXT[l.verdict][lang]}${now}\n  ${l.map_url}`);
      }
      lines.push(`${lang === 'tr' ? 'Not' : 'Note'}: ${p.notes[lang]}`);
      lines.push(`${lang === 'tr' ? 'Resmi kural' : 'Official rule'}: "${p.rule_text[lang]}"`);
      if (changedSince) {
        lines.push(
          lang === 'tr'
            ? `⚠️ Resmi park kuralları sayfası ${rules.verified_on} tarihinden sonra değişti; bu özet eski olabilir. Sayfayı kontrol et: ${rules.source_url}`
            : `⚠️ The official parking-rules page changed after ${rules.verified_on}; this summary may be outdated. Check: ${rules.source_url}`,
        );
      }
      lines.push(t(lang, 'signs_prevail'));

      return answer({
        lang,
        text: lines.join('\n'),
        data: {
          target: placeOut(target, lang),
          permit,
          evaluated_at: when.toISOString(),
          lots: evaluated,
          rule_text: p.rule_text[lang],
          notes: p.notes[lang],
          general_rules: rules.general_rules[lang],
          rules_may_have_changed: Boolean(changedSince),
        },
        freshness,
        see_also: seeAlso(db, { query: 'park otopark parking permit', category: 'parking' }, lang),
      });
    },
  );

  server.registerTool(
    'metu_vehicle_permit',
    {
      title: 'METU vehicle permit (taşıt pulu) info',
      description:
        'Explains METU student vehicle permits (araç/taşıt pulu): yellow vs brown permit, who is eligible (undergraduate ' +
        'lottery vs graduate students), required documents, discounts, validity, where to apply and whom to contact. ' +
        'Returns the official page text and the application links.',
      inputSchema: z.object({ lang: LangSchema }),
      outputSchema: z.object({ page_text: z.string(), permit_types: z.array(z.object({ id: z.string(), name: z.string(), notes: z.string() })), ...COMMON_OUTPUT }),
      annotations: { ...READ_ONLY, title: 'METU vehicle permit info' },
    },
    async ({ lang }) => {
      const rules = loadParkingRules();
      const rec = getRecord(db, `page:ihm-student-permit:${lang}`) ?? getRecord(db, 'page:ihm-student-permit:tr');
      const permitTypes = (['yellow', 'brown'] as const).map((id) => ({ id, name: rules.permits[id]!.name[lang], notes: rules.permits[id]!.notes[lang] }));
      const links = seeAlso(db, { query: 'taşıt pulu araç pulu başvuru vehicle permit', category: 'parking', limit: 4 }, lang);
      if (!rec) {
        return answer({
          lang,
          text: permitTypes.map((p) => `• ${p.name}: ${p.notes}`).join('\n'),
          data: { page_text: '', permit_types: permitTypes },
          freshness: [computeFreshness(db, { kind: 'page', collector: 'page:ihm-student-permit', source_url: 'https://ihm.metu.edu.tr/tr/ogrenci' }, lang)],
          see_also: links,
        });
      }
      const fallback = rec.lang !== lang ? `${t(lang, 'fallback_lang')}\n` : '';
      const pageText = rec.body.length > 6000 ? `${rec.body.slice(0, 6000)}…` : rec.body;
      return answer({
        lang,
        text: `${permitTypes.map((p) => `• ${p.name}: ${p.notes}`).join('\n')}\n\n${fallback}${pageText}`,
        data: { page_text: pageText, permit_types: permitTypes },
        freshness: [recordFreshness(db, rec, 'page:ihm-student-permit', lang)],
        see_also: links,
      });
    },
  );

  server.registerTool(
    'metu_campus_route',
    {
      title: 'Getting around METU campus',
      description:
        'How to get from one place on the METU campus to another: straight-line distance, an estimated walking time, the ' +
        'nearest ring-bus stops at both ends, for longer trips the ring lines that connect them (where to board and get ' +
        'off, from the official TİM route tables; metu_transport has live arrivals) and a walking-route map link. Places ' +
        'can be buildings, shorthand ("MM", "kütüphane", "A1 kapısı", "yurtlar") or classroom codes ("BMB G102").',
      inputSchema: z.object({
        from: z.string().min(1).max(120),
        to: z.string().min(1).max(120),
        lang: LangSchema,
      }),
      outputSchema: z.object({
        from: PlaceOut,
        to: PlaceOut,
        distance_m: z.number(),
        walk_minutes: z.number().describe('Estimate: 75 m/min with a 1.25 detour factor'),
        from_stops: z.array(PlaceOut),
        to_stops: z.array(PlaceOut),
        rings: z
          .array(
            z.object({
              ring: z.string(),
              board: z.string(),
              alight: z.string(),
              stops: z.number().int(),
              walk_to_board_m: z.number().int(),
              walk_from_alight_m: z.number().int(),
              timetable_url: z.string(),
            }),
          )
          .describe('Ring buses from a stop near the start to a stop near the destination (official TİM routes)'),
        route_url: z.string(),
        ...COMMON_OUTPUT,
      }),
      annotations: { ...READ_ONLY, title: 'Getting around METU campus' },
    },
    async ({ from, to, lang }) => {
      const resolve = (q: string): PlaceRow | undefined => findClassroom(db, q).find((r) => r.place)?.place ?? searchPlaces(db, q, { limit: 1 })[0];
      const a = resolve(from);
      const b = resolve(to);
      if (!a || !b) {
        const missing = [!a ? from : null, !b ? to : null].filter(Boolean).join(', ');
        return toolError(
          lang === 'tr' ? `Haritada bulunamadı: ${missing}. Bina adını ya da kısaltmasını dene.` : `Not found on the map: ${missing}. Try the building name or shorthand.`,
          lang,
          seeAlso(db, { query: 'harita map', category: 'campus' }, lang),
        );
      }
      const distance = Math.round(distanceMeters(a.lat, a.lng, b.lat, b.lng));
      const walk = Math.max(1, Math.round((distance * 1.25) / 75));
      const stopsNear = (p: PlaceRow) =>
        nearestPlaces(db, p.lat, p.lng, { categoryId: TRANSPORT_CATEGORY_ID, limit: 4, maxMeters: 700 })
          .filter((s) => /bus|stop|durak/i.test(s.name))
          .slice(0, 2);
      const fromStops = stopsNear(a);
      const toStops = stopsNear(b);
      const routeUrl = `https://www.openstreetmap.org/directions?engine=fossgis_osrm_foot&route=${a.lat.toFixed(6)}%2C${a.lng.toFixed(6)}%3B${b.lat.toFixed(6)}%2C${b.lng.toFixed(6)}`;
      const stopText = (stops: (PlaceRow & { distance_m: number })[]) => stops.map((s) => `${s.name} (${s.distance_m} m)`).join(', ') || '–';
      const lines = [
        `${a.name} → ${b.name}`,
        lang === 'tr'
          ? `Kuş uçuşu ${distance} m, yürüyerek yaklaşık ${walk} dk.`
          : `${distance} m in a straight line, about ${walk} min on foot.`,
        `${lang === 'tr' ? 'Yakın ring durakları (başlangıç)' : 'Nearest ring stops (start)'}: ${stopText(fromStops)}`,
        `${lang === 'tr' ? 'Yakın ring durakları (varış)' : 'Nearest ring stops (destination)'}: ${stopText(toStops)}`,
      ];
      // Rings only pay off on longer trips; the routes come from the collected TİM ring pages.
      const rings =
        distance > RING_MIN_DISTANCE_M
          ? suggestRings(ringLines(db), a, b)
              .slice(0, 3)
              .map((r) => ({
                ring: r.line.title[lang],
                board: r.board,
                alight: r.alight,
                stops: r.stops_between,
                walk_to_board_m: r.walk_to_board_m,
                walk_from_alight_m: r.walk_from_alight_m,
                timetable_url: r.line.url,
              }))
          : [];
      if (rings.length) {
        lines.push(
          `${lang === 'tr' ? 'Ring seçenekleri' : 'Ring options'}:\n` +
            rings
              .map((r) =>
                lang === 'tr'
                  ? `• ${r.ring}: ${r.board} durağında bin (${r.walk_to_board_m} m yürü), ${r.stops} durak sonra ${r.alight} durağında in (${r.walk_from_alight_m} m yürü). Saatler: ${r.timetable_url}`
                  : `• ${r.ring}: board at ${r.board} (${r.walk_to_board_m} m walk), get off ${r.stops} stop(s) later at ${r.alight} (${r.walk_from_alight_m} m walk). Timetable: ${r.timetable_url}`,
              )
              .join('\n') +
            `\n${lang === 'tr' ? 'Canlı varış saatleri için metu_transport.' : 'Live arrivals: metu_transport.'}`,
        );
      } else if (distance > 1500 && fromStops.length && toStops.length) {
        lines.push(
          lang === 'tr'
            ? 'Mesafe uzun: ring ile gitmek daha kolay olabilir; canlı varış saatleri için metu_transport.'
            : 'It is a long walk: a ring bus may be easier; use metu_transport for live arrivals.',
        );
      }
      lines.push(`${lang === 'tr' ? 'Yürüyüş rotası' : 'Walking route'}: ${routeUrl}`);
      return answer({
        lang,
        text: lines.join('\n'),
        data: {
          from: placeOut(a, lang),
          to: placeOut(b, lang),
          distance_m: distance,
          walk_minutes: walk,
          from_stops: fromStops.map((p) => placeOut(p, lang)),
          to_stops: toStops.map((p) => placeOut(p, lang)),
          rings,
          route_url: routeUrl,
        },
        freshness: [placesFreshness(db, lang)],
      });
    },
  );

}
