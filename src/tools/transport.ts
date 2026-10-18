import type { DatabaseSync } from 'node:sqlite';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { PAGE_SOURCES, RING_LIVE_CACHE_MS, RING_LIVE_URL, type Lang } from '../config.js';
import { politeFetch } from '../collectors/http.js';
import { t } from '../i18n.js';
import { foldTr } from '../lib/text.js';
import { formatHm, istanbulClock, now, parseHm } from '../lib/time.js';
import { type Freshness } from '../store/freshness.js';
import { getRecord } from '../store/records.js';
import { answer, COMMON_OUTPUT, LangSchema, READ_ONLY, recordFreshness, seeAlso } from './common.js';

// ---------- live ring positions (the one tool-time fetch, cached 30 s and single-flight) ----------

interface RingStopRaw {
  mins?: number;
  time?: string;
  dst?: string;
}
interface RingBusRaw {
  key?: string;
  id?: string;
  clr?: string;
  sp?: string;
  ago?: number;
  addr?: string;
  stops?: RingStopRaw[];
}

export interface LiveBus {
  plate: string;
  route_color: string;
  segment: string;
  speed_kmh: number | null;
  next_stops: { stop: string; eta_min: number; eta_time: string | null }[];
}

const COLOR_NAMES: Record<string, Record<Lang, string>> = {
  yellow: { en: 'Yellow', tr: 'Sarı' },
  red: { en: 'Red', tr: 'Kırmızı' },
  brown: { en: 'Light brown', tr: 'Açık kahverengi' },
  gray: { en: 'Gray', tr: 'Gri' },
  grey: { en: 'Gray', tr: 'Gri' },
  purple: { en: 'Purple', tr: 'Mor' },
  navy: { en: 'Navy', tr: 'Lacivert' },
  orange: { en: 'Orange', tr: 'Turuncu' },
  turquoise: { en: 'Turquoise', tr: 'Turkuaz' },
};

/** Parses ring.json: `key` is "From - To - color"; each stop `dst` is "Stop - Next - color" reached in `mins`. */
export function parseRingJson(body: string): LiveBus[] {
  const raw = JSON.parse(body) as unknown;
  if (!Array.isArray(raw)) return [];
  return (raw as RingBusRaw[]).map((b) => {
    const keyParts = (b.key ?? '').split(' - ');
    const color = keyParts.length > 2 ? keyParts[keyParts.length - 1]!.trim().toLowerCase() : 'unknown';
    return {
      plate: String(b.id ?? ''),
      route_color: color,
      segment: keyParts.slice(0, -1).join(' → ') || String(b.addr ?? ''),
      speed_kmh: b.sp !== undefined && Number.isFinite(Number(b.sp)) ? Number(b.sp) : null,
      next_stops: (b.stops ?? [])
        .filter((s) => typeof s.dst === 'string' && typeof s.mins === 'number')
        .map((s) => ({ stop: s.dst!.split(' - ')[0]!.trim(), eta_min: Math.round(s.mins! * 10) / 10, eta_time: s.time ?? null }))
        .slice(0, 12),
    };
  });
}

let liveCache: { at: number; buses: LiveBus[] } | undefined;
let inflight: Promise<LiveBus[]> | undefined;

export async function getLiveBuses(): Promise<{ buses: LiveBus[]; fetchedAt: number }> {
  if (liveCache && Date.now() - liveCache.at < RING_LIVE_CACHE_MS) return { buses: liveCache.buses, fetchedAt: liveCache.at };
  inflight ??= politeFetch(undefined, RING_LIVE_URL, { conditional: false, timeoutMs: 8_000 })
    .then((res) => parseRingJson(res.body))
    .finally(() => {
      inflight = undefined;
    });
  const buses = await inflight;
  liveCache = { at: Date.now(), buses };
  return { buses, fetchedAt: liveCache.at };
}

/** Test hook. */
export function resetLiveCache(): void {
  liveCache = undefined;
  inflight = undefined;
}

// ---------- timetables from tim.metu.edu.tr pages ----------

/** Departure times listed between "Hareket Saatleri"/"Departure" and the route ("Güzergah"/"Route") section. */
export function parseDepartures(text: string): number[] {
  const f = foldTr(text);
  const start = f.search(/hareket saatleri|departure|kalkis saatleri/);
  if (start < 0) return [];
  const rest = f.slice(start);
  const endRel = rest.search(/guzergah|route|durak/);
  const section = endRel > 0 ? rest.slice(0, endRel) : rest.slice(0, 2000);
  const times = [...section.matchAll(/\b(\d{1,2}[.:]\d{2})\b/g)]
    .map((m) => parseHm(m[1]!))
    .filter((m): m is number => m !== undefined);
  return [...new Set(times)].sort((a, b) => a - b);
}

const RING_PAGES = PAGE_SOURCES.filter((p) => p.id.startsWith('ring-'));
const RING_IDS = RING_PAGES.map((p) => p.id.replace(/^ring-/, '')) as [string, ...string[]];

const LiveBusOut = z.object({
  plate: z.string(),
  route_color: z.string(),
  segment: z.string(),
  speed_kmh: z.number().nullable(),
  next_stops: z.array(z.object({ stop: z.string(), eta_min: z.number(), eta_time: z.string().nullable() })),
});

export function registerTransportTools(server: McpServer, db: DatabaseSync): void {
  server.registerTool(
    'metu_transport',
    {
      title: 'METU ring buses',
      description:
        'Campus ring buses: live positions and minutes until each bus reaches its next stops (from ring.metu.edu.tr), ' +
        'plus the official timetable (next departures) and route of a ring line from tim.metu.edu.tr. Use `stop` to ' +
        'ask "when does a ring reach <stop>?" (e.g. "Rektörlük", "Batı Yurtlar", "Makina Müh.", "BÖTE-MYO"). Also points to EGO bus, ' +
        'metro and dolmuş information.',
      inputSchema: z.object({
        ring: z.enum(RING_IDS).optional().describe('Timetable of one ring line'),
        stop: z.string().max(80).optional().describe('Stop name to get live arrival estimates for'),
        live: z.boolean().default(true).describe('Include live bus positions'),
        lang: LangSchema,
      }),
      outputSchema: z.object({
        live_buses: z.array(LiveBusOut),
        arrivals: z.array(z.object({ stop: z.string(), route_color: z.string(), plate: z.string(), eta_min: z.number() })),
        timetable: z
          .object({ ring: z.string(), title: z.string(), next_departures: z.array(z.string()), all_departures: z.array(z.string()) })
          .nullable(),
        live_error: z.string().nullable(),
        ...COMMON_OUTPUT,
      }),
      annotations: { ...READ_ONLY, title: 'METU ring buses' },
    },
    async ({ ring, stop, live, lang }) => {
      const lines: string[] = [];
      const freshness: Freshness[] = [];
      let buses: LiveBus[] = [];
      let liveError: string | null = null;
      if (live || stop) {
        try {
          const res = await getLiveBuses();
          buses = res.buses;
          const at = new Date(res.fetchedAt).toISOString();
          freshness.push({ source_url: 'https://ring.metu.edu.tr/', fetched_at: at, source_updated_at: at, last_changed_at: at, valid_for: null, status: 'fresh', warning: null });
        } catch (err) {
          liveError = (err as Error).message;
          lines.push(lang === 'tr' ? `Canlı ring verisine şu an ulaşılamıyor (${liveError}).` : `Live ring data is unavailable right now (${liveError}).`);
        }
      }

      const color = (c: string) => COLOR_NAMES[c]?.[lang] ?? c;
      const arrivals: { stop: string; route_color: string; plate: string; eta_min: number }[] = [];
      if (stop) {
        const q = foldTr(stop).replace(/[^a-z0-9]/g, '');
        for (const b of buses) {
          const hit = b.next_stops.find((s) => foldTr(s.stop).replace(/[^a-z0-9]/g, '').includes(q));
          if (hit) arrivals.push({ stop: hit.stop, route_color: b.route_color, plate: b.plate, eta_min: hit.eta_min });
        }
        arrivals.sort((a, b) => a.eta_min - b.eta_min);
        if (arrivals.length) {
          lines.push(lang === 'tr' ? `"${stop}" durağına yaklaşan ringler:` : `Rings approaching "${stop}":`);
          for (const a of arrivals.slice(0, 6)) lines.push(`• ${color(a.route_color)} (${a.plate}) → ${a.stop}: ~${Math.max(0, Math.round(a.eta_min))} ${lang === 'tr' ? 'dk' : 'min'}`);
        } else if (!liveError) {
          lines.push(lang === 'tr' ? `Şu an "${stop}" durağına yaklaşan canlı ring görünmüyor.` : `No live ring is currently approaching "${stop}".`);
        }
      } else if (live && buses.length) {
        lines.push(lang === 'tr' ? `Şu an hatta ${buses.length} ring var:` : `${buses.length} ring bus(es) running now:`);
        for (const b of buses.slice(0, 10)) {
          const next = b.next_stops[0];
          lines.push(`• ${color(b.route_color)} (${b.plate}): ${b.segment}${next ? ` — ${next.stop} ~${Math.max(0, Math.round(next.eta_min))} ${lang === 'tr' ? 'dk' : 'min'}` : ''}`);
        }
      } else if (live && !liveError) {
        lines.push(lang === 'tr' ? 'Şu an hatta canlı ring görünmüyor (sefer saatleri dışında olabilir).' : 'No ring buses are live right now (probably outside service hours).');
      }

      let timetable: { ring: string; title: string; next_departures: string[]; all_departures: string[] } | null = null;
      if (ring) {
        const pageId = `ring-${ring}`;
        const rec = getRecord(db, `page:${pageId}:${lang}`) ?? getRecord(db, `page:${pageId}:tr`);
        const src = RING_PAGES.find((p) => p.id === pageId)!;
        if (rec) {
          const deps = parseDepartures(rec.body);
          const clock = istanbulClock(now());
          const upcoming = deps.filter((m) => m >= clock.minutes).slice(0, 4);
          timetable = { ring, title: rec.title, next_departures: upcoming.map(formatHm), all_departures: deps.map(formatHm) };
          lines.push('');
          lines.push(`${rec.title}${rec.lang !== lang ? ` ${t(lang, 'fallback_lang')}` : ''}`);
          if (deps.length) {
            lines.push(
              lang === 'tr'
                ? `Sıradaki kalkışlar: ${upcoming.length ? upcoming.map(formatHm).join(', ') : 'bugün için kalmadı'} (tüm saatler: ${deps.map(formatHm).join(', ')})`
                : `Next departures: ${upcoming.length ? upcoming.map(formatHm).join(', ') : 'none left today'} (all: ${deps.map(formatHm).join(', ')})`,
            );
          }
          lines.push(rec.body.split('\n').slice(0, 25).join('\n'));
          freshness.push(recordFreshness(db, rec, `page:${pageId}`, lang));
        } else {
          lines.push(lang === 'tr' ? `${src.title.tr} sefer bilgisi henüz toplanmadı: ${src.url}` : `${src.title.en} timetable has not been collected yet: ${src.url_en ?? src.url}`);
        }
      }

      return answer({
        lang,
        text: lines.join('\n') || t(lang, 'no_results'),
        data: { live_buses: buses, arrivals, timetable, live_error: liveError },
        freshness,
        see_also: seeAlso(db, { query: 'ring ulaşım transport ego dolmuş', category: 'transport', limit: 2 }, lang),
      });
    },
  );
}
