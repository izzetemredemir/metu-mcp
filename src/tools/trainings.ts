import type { DatabaseSync } from 'node:sqlite';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { TRAININGS_LIST_URL, type Lang } from '../config.js';
import { t } from '../i18n.js';
import { foldTr } from '../lib/text.js';
import { todayIstanbul } from '../lib/time.js';
import { formatDate } from '../lib/trdate.js';
import { computeFreshness } from '../store/freshness.js';
import { answer, COMMON_OUTPUT, LangSchema, READ_ONLY, seeAlso } from './common.js';

interface TrainingRow {
  id: string;
  provider: string;
  title: string;
  description: string;
  category: string;
  language: string | null;
  format: 'online' | 'in-person' | 'hybrid' | null;
  price: string | null;
  duration: string | null;
  start_text: string | null;
  start_date: string | null;
  end_date: string | null;
  registration: string | null;
  registration_status: string | null;
  url: string;
}

const TrainingOut = z.object({
  title: z.string(),
  provider: z.string().describe('ODTÜ-SEM (continuing education centre), Bilgeİş, METU OCW or METU Learn'),
  category: z.string(),
  language: z.string().nullable(),
  format: z.enum(['online', 'in-person', 'hybrid']).nullable(),
  price: z.string().nullable().describe('As published, e.g. "Ücretsiz" (free) or "10.000 TL"'),
  duration: z.string().nullable().describe('E.g. "139 modül" for open courseware'),
  start: z.string().nullable().describe('As published: a date, a date range or a self-paced note; null = not collected yet'),
  start_date: z.string().nullable().describe('YYYY-MM-DD when the start is a date'),
  end_date: z.string().nullable(),
  registration: z.string().nullable().describe('Registration window, when published'),
  registration_status: z.string().nullable().describe('E.g. "Kayıtlar Açık" (registration open)'),
  url: z.string().describe('Enrolment page METULearn links to, or the METULearn catalog searched for the title'),
  description: z.string(),
});

const FORMAT_LABEL: Record<NonNullable<TrainingRow['format']>, Record<Lang, string>> = {
  online: { en: 'online', tr: 'çevrim içi' },
  'in-person': { en: 'in person', tr: 'yüz yüze' },
  hybrid: { en: 'hybrid', tr: 'hibrit' },
};

function startLabel(r: TrainingRow, lang: Lang): string {
  if (r.start_date) {
    const start = formatDate(r.start_date, lang, false);
    return r.end_date && r.end_date !== r.start_date ? `${start} – ${formatDate(r.end_date, lang, false)}` : start;
  }
  return r.start_text ?? '';
}

export function registerTrainingTools(server: McpServer, db: DatabaseSync): void {
  server.registerTool(
    'metu_trainings',
    {
      title: 'METU trainings and certificate programmes',
      description:
        'Catalog of METU continuing-education trainings on METULearn (learn.metu.edu.tr): ODTÜ-SEM certificate programmes ' +
        '(in person or online, often paid), free Bilgeİş online courses, METU OCW open courseware and METU Learn courses. ' +
        'Search by words in the title, provider or category (e.g. "yapay zeka", "CCNP", "proje yönetimi", "sertifika"). ' +
        'Each training lists provider, format, language, price, start date or self-paced note, registration status and ' +
        'the enrolment link. Trainings that start soon come first. For METU School of Foreign Languages courses ' +
        '(TOEFL, IELTS, General English) use metu_campus_services with topic "language"; for degree courses use metu_course.',
      inputSchema: z.object({
        query: z.string().max(100).optional().describe('Words in title, provider, category or description'),
        format: z.enum(['online', 'in-person', 'hybrid']).optional(),
        limit: z.number().int().min(1).max(30).default(10),
        lang: LangSchema,
      }),
      outputSchema: z.object({ trainings: z.array(TrainingOut), total_matches: z.number().int(), ...COMMON_OUTPUT }),
      annotations: { ...READ_ONLY, title: 'METU trainings and certificate programmes' },
    },
    async ({ query, format, limit, lang }) => {
      const where: string[] = ['1 = 1'];
      const params: (string | number)[] = [];
      if (format) {
        where.push('format = ?');
        params.push(format);
      }
      for (const w of foldTr(query ?? '').split(/[^\p{L}\p{N}]+/u).filter((x) => x.length >= 2).slice(0, 6)) {
        where.push('search_text LIKE ?');
        params.push(`%${w}%`);
      }
      const total = (db.prepare(`SELECT COUNT(*) AS n FROM trainings WHERE ${where.join(' AND ')}`).get(...params) as { n: number }).n;
      const today = todayIstanbul();
      const rows = db
        .prepare(
          `SELECT id, provider, title, description, category, language, format, price, duration, start_text, start_date,
             end_date, registration, registration_status, url
           FROM trainings WHERE ${where.join(' AND ')}
           -- Upcoming or running dated trainings first (soonest start), then everything else alphabetically.
           ORDER BY COALESCE(end_date, start_date) >= ? DESC, CASE WHEN COALESCE(end_date, start_date) >= ? THEN start_date END,
             title COLLATE NOCASE
           LIMIT ?`,
        )
        .all(...params, today, today, limit) as unknown as TrainingRow[];

      const freshness = [
        computeFreshness(db, { kind: 'training', collector: 'trainings', source_url: TRAININGS_LIST_URL }, lang),
        computeFreshness(db, { kind: 'training', collector: 'trainings-details', source_url: TRAININGS_LIST_URL }, lang),
      ];
      const trainings = rows.map((r) => ({
        title: r.title,
        provider: r.provider,
        category: r.category,
        language: r.language,
        format: r.format,
        price: r.price,
        duration: r.duration,
        start: r.start_text,
        start_date: r.start_date,
        end_date: r.end_date,
        registration: r.registration,
        registration_status: r.registration_status,
        url: r.url,
        description: r.description.length > 400 ? `${r.description.slice(0, 399)}…` : r.description,
      }));
      const lines = rows.map((r) => {
        const facts = [
          r.provider,
          r.format ? FORMAT_LABEL[r.format][lang] : '',
          r.language ?? '',
          r.price ?? '',
          r.duration ?? '',
        ].filter(Boolean);
        const when = startLabel(r, lang);
        const status = r.registration_status ? ` (${r.registration_status})` : '';
        const start = when ? `\n  ${lang === 'tr' ? 'Başlangıç' : 'Start'}: ${when}${status}` : status ? `\n ${status}` : '';
        return `• ${r.title} — ${facts.join(' · ')}${start}\n  ${r.url}`;
      });
      const header =
        total > rows.length
          ? lang === 'tr'
            ? `${total} eğitimden ${rows.length} tanesi:`
            : `${rows.length} of ${total} trainings:`
          : '';
      const text = rows.length ? [header, ...lines].filter(Boolean).join('\n') : t(lang, 'no_results');
      return answer({
        lang,
        text,
        data: { trainings, total_matches: total },
        freshness,
        see_also: rows.length ? undefined : seeAlso(db, { query: 'metulearn eğitim training sertifika certificate', limit: 2 }, lang),
      });
    },
  );
}
