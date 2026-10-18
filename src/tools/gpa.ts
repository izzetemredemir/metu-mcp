import type { DatabaseSync } from 'node:sqlite';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { PAGE_SOURCES, type Lang } from '../config.js';
import { normalizeCourseCode } from '../collectors/catalog.js';
import { computeGpa, parseGradeRules, type GradeEntry } from '../lib/grades.js';
import { computeFreshness } from '../store/freshness.js';
import { getRecord } from '../store/records.js';
import { answer, COMMON_OUTPUT, LangSchema, READ_ONLY, recordFreshness, seeAlso, toolError } from './common.js';

const REGULATION_ID = 'regulation-undergraduate';
const REGULATION_URL = PAGE_SOURCES.find((p) => p.id === REGULATION_ID)!.url;

const STANDING: Record<string, Record<Lang, string>> = {
  high_honor: { en: 'high honor', tr: 'yüksek şeref' },
  honor: { en: 'honor', tr: 'şeref' },
};
const REASON: Record<string, Record<Lang, string>> = {
  status: { en: 'status grade, not in averages', tr: 'statü notu, ortalamaya girmez' },
  not_included: { en: 'taken as NI, not in averages', tr: 'NI statüsünde, ortalamaya girmez' },
  zero_credit: { en: 'no METU credit', tr: 'ODTÜ kredisi yok' },
  repeated: { en: 'repeated later; the last grade counts', tr: 'sonra tekrarlandı; son not geçerli' },
};

export function registerGpaTools(server: McpServer, db: DatabaseSync): void {
  server.registerTool(
    'metu_gpa_calculator',
    {
      title: 'METU GPA calculator',
      description:
        'Calculates term averages (YNO) and the cumulative average (GNO/CGPA) for METU undergraduates from letter grades, ' +
        'using the grading scale, status grades (S/U/EX/I/W excluded), the "last grade of a repeated course counts" rule, ' +
        'honor / high honor ranges and the probation line as published in the undergraduate regulation (collected from the ' +
        'Registrar\'s site, not hard-coded). Give each course with its code (credits are looked up in the catalog) or its ' +
        'METU credit, the letter grade and optionally the term. Grades are not stored.',
      inputSchema: z.object({
        courses: z
          .array(
            z.object({
              course: z.string().max(12).optional().describe('Course code, e.g. "CENG213" (repeats are matched by code)'),
              credit: z.number().min(0).max(20).optional().describe('METU credit; looked up from the catalog when omitted'),
              grade: z.string().max(3).describe('Letter grade AA…FF, NA, or a status S/U/EX/I/W'),
              term: z.string().max(40).optional().describe('Term label, e.g. "2025-2026 Fall"; terms are ordered as given'),
              not_included: z.boolean().optional().describe('Taken with NI status (not counted)'),
            }),
          )
          .min(1)
          .max(80),
        lang: LangSchema,
      }),
      outputSchema: z.object({
        terms: z.array(
          z.object({
            term: z.string(),
            gpa: z.number().nullable(),
            credits: z.number(),
            credited_courses: z.number(),
            standing: z.enum(['high_honor', 'honor']).nullable(),
          }),
        ),
        cgpa: z.number().nullable(),
        credits: z.number(),
        excluded: z.array(z.object({ course: z.string(), grade: z.string(), reason: z.string() })),
        below_probation_line: z.boolean(),
        ...COMMON_OUTPUT,
      }),
      annotations: { ...READ_ONLY, openWorldHint: false, title: 'METU GPA calculator' },
    },
    async ({ courses, lang }) => {
      const links = seeAlso(db, { query: 'yönetmelik not ortalaması regulation', category: 'regulations', limit: 2 }, lang);
      const rec = getRecord(db, `page:${REGULATION_ID}:tr`);
      const rules = rec ? parseGradeRules(rec.body) : null;
      if (!rec || !rules) {
        return toolError(
          lang === 'tr'
            ? `Not ölçeği henüz yönetmelikten alınamadı; hesaplama yapılamıyor. Yönetmelik: ${REGULATION_URL}`
            : `The grading scale has not been collected from the regulation yet, so no calculation is possible: ${REGULATION_URL}`,
          lang,
          links,
        );
      }

      const missing: string[] = [];
      const entries: GradeEntry[] = courses.map((c) => {
        let credit = c.credit;
        if (credit === undefined && c.course) {
          const row = db
            .prepare('SELECT metu_credit FROM courses WHERE short_code = ? ORDER BY detail_fetched_at IS NULL LIMIT 1')
            .get(normalizeCourseCode(c.course)) as { metu_credit: number | null } | undefined;
          credit = row?.metu_credit ?? undefined;
        }
        if (credit === undefined) missing.push(c.course ?? c.grade);
        return { course: c.course ? normalizeCourseCode(c.course) : undefined, credit: credit ?? 0, grade: c.grade, term: c.term, not_included: c.not_included };
      });
      if (missing.length) {
        return toolError(
          lang === 'tr'
            ? `Şu dersler için kredi bulunamadı, lütfen kredisini de ver: ${missing.join(', ')}`
            : `No credit found for: ${missing.join(', ')} — please give their METU credit.`,
          lang,
        );
      }

      let result;
      try {
        result = computeGpa(rules, entries);
      } catch (err) {
        return toolError((err as Error).message, lang);
      }

      const fmt = (n: number | null) => (n === null ? '–' : n.toFixed(2));
      const lines = result.terms.map(
        (t) =>
          `• ${t.term}: ${lang === 'tr' ? 'YNO' : 'term GPA'} ${fmt(t.gpa)} (${t.credits} ${lang === 'tr' ? 'kredi' : 'credits'})` +
          (t.standing ? ` — ${STANDING[t.standing]![lang]}` : ''),
      );
      lines.push(`${lang === 'tr' ? 'Genel not ortalaması (GNO)' : 'Cumulative GPA'}: ${fmt(result.cgpa)} (${result.credits} ${lang === 'tr' ? 'kredi' : 'credits'})`);
      if (result.excluded.length) {
        lines.push(
          `${lang === 'tr' ? 'Ortalamaya girmeyenler' : 'Not counted'}: ` +
            result.excluded.map((e) => `${e.course} ${e.grade} (${REASON[e.reason]![lang]})`).join('; '),
        );
      }
      if (result.below_probation_line) {
        lines.push(
          lang === 'tr'
            ? `⚠️ GNO ${fmt(rules.probationBelow)} altında: iki yarıyıl üst üste böyle olursa öğrenci sınamalı (probation) sayılır.`
            : `⚠️ CGPA is below ${fmt(rules.probationBelow)}: two consecutive terms like this mean probation.`,
        );
      }
      lines.push(
        lang === 'tr'
          ? 'Bu bir hesaplamadır; resmi ortalaman OİBS transkriptindedir.'
          : 'This is an estimate; your official averages are on your OİBS transcript.',
      );
      return answer({
        lang,
        text: lines.join('\n'),
        data: { ...result },
        freshness: [rec ? recordFreshness(db, rec, `page:${REGULATION_ID}`, lang) : computeFreshness(db, { kind: 'page', collector: `page:${REGULATION_ID}`, source_url: REGULATION_URL }, lang)],
        see_also: links,
      });
    },
  );
}
