import type { DatabaseSync } from 'node:sqlite';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { DOCTORS_RECORD_ID, type DoctorDuty } from '../collectors/doctors.js';
import { diningUrl, type DayMenu } from '../collectors/dining.js';
import { ANNOUNCEMENT_SOURCES, DOCTORS_URL, KIM_EVENTS_URL, type Lang } from '../config.js';
import { t } from '../i18n.js';
import { addDaysIso, formatDateOnly, istanbulClock, now, todayIstanbul } from '../lib/time.js';
import { formatDate } from '../lib/trdate.js';
import { computeFreshness, type Freshness } from '../store/freshness.js';
import { getRecord, listRecords } from '../store/records.js';
import { calendarFreshness, queryEvents, toOut } from './calendar.js';
import { answer, COMMON_OUTPUT, LangSchema, READ_ONLY, recordFreshness } from './common.js';

const SOURCE_IDS = ANNOUNCEMENT_SOURCES.map((s) => s.id) as [string, ...string[]];
/** Calendar entries shown: today's and those starting in the next days. */
const CALENDAR_DAYS_AHEAD = 7;
/** Announcements newer than this are "today's news". */
const ANNOUNCEMENT_HOURS = 48;

const Item = z.object({ title: z.string(), when: z.string(), url: z.string().nullable() });

export function registerTodayTools(server: McpServer, db: DatabaseSync): void {
  server.registerTool(
    'metu_today',
    {
      title: 'METU today',
      description:
        'One call for a student\'s day at METU: today\'s cafeteria lunch, dinner and vegetarian menu; academic-calendar ' +
        `entries running today or starting in the next ${CALENDAR_DAYS_AHEAD} days (add-drop, exams, holidays, deadlines); ` +
        'campus events today (clubs, university events, KKM); which specialties have a doctor on duty at the health ' +
        `center; and announcements of the last ${ANNOUNCEMENT_HOURS} hours from the Registrar and, if given, the ` +
        'student\'s department (`department` = announcement source id, e.g. "ceng", "ee", "arch"). Use the specific ' +
        'tools for details (metu_dining_menu, metu_calendar_events, metu_events, metu_doctors_on_duty, metu_announcements).',
      inputSchema: z.object({
        department: z.enum(SOURCE_IDS).optional().describe('Announcement source of the student\'s department or unit'),
        lang: LangSchema,
      }),
      outputSchema: z.object({
        date: z.string(),
        menu: z.object({ lunch: z.array(z.string()), dinner: z.array(z.string()), vegetarian: z.array(z.string()) }).nullable(),
        calendar: z.array(Item),
        events: z.array(Item),
        doctors_on_duty: z.array(z.object({ specialty: z.string(), names: z.array(z.string()) })),
        announcements: z.array(Item.extend({ source: z.string() })),
        ...COMMON_OUTPUT,
      }),
      annotations: { ...READ_ONLY, title: 'METU today' },
    },
    async ({ department, lang }) => {
      const day = todayIstanbul(now());
      const freshness: Freshness[] = [];
      const blocks: string[] = [`${lang === 'tr' ? 'Bugün' : 'Today'}: ${formatDate(day, lang)}`];

      // Cafeteria
      const menuRec = getRecord(db, `menu:${day}`);
      let menu: { lunch: string[]; dinner: string[]; vegetarian: string[] } | null = null;
      if (menuRec?.data) {
        const m = JSON.parse(menuRec.data) as DayMenu;
        menu = { lunch: m.lunch, dinner: m.dinner, vegetarian: m.vegetarian };
        freshness.push(recordFreshness(db, menuRec, 'dining', lang));
        const lines = [
          m.lunch.length ? `${t(lang, 'lunch')}: ${m.lunch.join(', ')}` : '',
          m.dinner.length ? `${t(lang, 'dinner')}: ${m.dinner.join(', ')}` : '',
          m.vegetarian.length ? `${t(lang, 'vegetarian')}: ${m.vegetarian.join(', ')}` : '',
        ].filter(Boolean);
        blocks.push(`## ${lang === 'tr' ? 'Yemekhane' : 'Cafeteria'}\n${lines.length ? lines.join('\n') : t(lang, 'no_menu', { date: formatDate(day, lang) })}`);
      } else {
        freshness.push(computeFreshness(db, { kind: 'menu', collector: 'dining', source_url: diningUrl(day), valid_for: day }, lang));
      }

      // Academic calendar: running today or starting soon
      const cal = queryEvents(db, { from: day, to: addDaysIso(day, CALENDAR_DAYS_AHEAD), limit: 8 }, lang);
      const calendar = cal.rows.map((r) => toOut(r, lang)).map((e) => ({ title: e.title, when: e.when, url: null }));
      freshness.push(...calendarFreshness(db, [...new Set(cal.rows.map((r) => r.academic_year))], lang));
      if (calendar.length) {
        blocks.push(`## ${lang === 'tr' ? 'Akademik takvim' : 'Academic calendar'}\n${calendar.map((c) => `• ${c.when} — ${c.title}`).join('\n')}`);
      }

      // Campus events today
      const evRows = db
        .prepare(
          `SELECT title, start, venue, url FROM events
           WHERE substr(start, 1, 10) <= ? AND substr(COALESCE(end, start), 1, 10) >= ?
             -- Season-long umbrella entries are not "today's" events.
             AND julianday(substr(COALESCE(end, start), 1, 10)) - julianday(substr(start, 1, 10)) <= 14
           ORDER BY start LIMIT 8`,
        )
        .all(day, day) as { title: string; start: string; venue: string; url: string }[];
      const events = evRows.map((e) => ({
        title: e.title,
        when: `${e.start.length > 10 ? e.start.slice(11, 16) : ''}${e.venue ? ` · ${e.venue}` : ''}`.replace(/^ · /, ''),
        url: e.url,
      }));
      freshness.push(computeFreshness(db, { kind: 'event', collector: 'events:kim', source_url: KIM_EVENTS_URL }, lang));
      if (events.length) {
        blocks.push(`## ${lang === 'tr' ? 'Kampüste bugün' : 'On campus today'}\n${events.map((e) => `• ${e.when ? `${e.when}: ` : ''}${e.title}\n  ${e.url}`).join('\n')}`);
      }

      // Health center: weekdays only
      const doctors_on_duty: { specialty: string; names: string[] }[] = [];
      const clock = istanbulClock();
      const docRec = getRecord(db, DOCTORS_RECORD_ID);
      if (docRec?.data && clock.weekday !== 0 && clock.weekday !== 6) {
        for (const d of (JSON.parse(docRec.data) as { doctors: DoctorDuty[] }).doctors.filter((x) => x.status === 'on_duty')) {
          const g = doctors_on_duty.find((x) => x.specialty === d.specialty);
          if (g) g.names.push(d.name);
          else doctors_on_duty.push({ specialty: d.specialty, names: [d.name] });
        }
        freshness.push(recordFreshness(db, docRec, 'doctors', lang));
        if (doctors_on_duty.length) {
          blocks.push(
            `## ${lang === 'tr' ? 'Sağlık merkezinde nöbetçi' : 'On duty at the health center'}\n` +
              doctors_on_duty.map((g) => `• ${g.specialty}: ${g.names.join(', ')}`).join('\n'),
          );
        }
      } else if (!docRec) {
        freshness.push(computeFreshness(db, { kind: 'duty', collector: 'doctors', source_url: DOCTORS_URL }, lang));
      }

      // Recent announcements: Registrar plus the student's department
      const since = new Date(now().getTime() - ANNOUNCEMENT_HOURS * 3_600_000).toISOString();
      const sources = ['oidb', ...(department && department !== 'oidb' ? [department] : [])];
      const announcements = sources.flatMap((source) => {
        const ownLang = listRecords(db, { kind: 'announcement', sources: [source], since, lang, limit: 4 }).rows;
        const rows = ownLang.length ? ownLang : listRecords(db, { kind: 'announcement', sources: [source], since, limit: 4 }).rows;
        return rows.map((r) => ({ source, title: r.title, when: formatDateOnly(r.published_at ?? r.first_seen_at), url: r.url }));
      });
      if (announcements.length) {
        blocks.push(
          `## ${lang === 'tr' ? `Son ${ANNOUNCEMENT_HOURS} saatin duyuruları` : `Announcements, last ${ANNOUNCEMENT_HOURS} hours`}\n` +
            announcements.map((a) => `• [${a.source}] ${a.title}\n  ${a.url}`).join('\n'),
        );
      } else {
        blocks.push(
          lang === 'tr'
            ? `Son ${ANNOUNCEMENT_HOURS} saatte yeni duyuru yok (${sources.join(', ')}).`
            : `No new announcements in the last ${ANNOUNCEMENT_HOURS} hours (${sources.join(', ')}).`,
        );
      }
      for (const source of sources) {
        const src = ANNOUNCEMENT_SOURCES.find((s) => s.id === source)!;
        const lang0 = src.urls[lang] ? lang : (Object.keys(src.urls)[0] as Lang);
        freshness.push(computeFreshness(db, { kind: 'announcement', collector: `announcements:${source}:${lang0}`, source_url: src.urls[lang0]! }, lang));
      }

      return answer({
        lang,
        text: blocks.join('\n\n'),
        data: { date: day, menu, calendar, events, doctors_on_duty, announcements },
        freshness,
      });
    },
  );
}
