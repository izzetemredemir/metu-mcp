import type { DatabaseSync } from 'node:sqlite';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { normalizeCourseCode } from '../collectors/catalog.js';
import type { CurriculumCourse, CurriculumSemester } from '../collectors/curriculum.js';
import { CATALOG_BASE_URL, type Lang } from '../config.js';
import { t } from '../i18n.js';
import { computeFreshness } from '../store/freshness.js';
import { answer, COMMON_OUTPUT, LangSchema, READ_ONLY, recordFreshness, seeAlso, toolError } from './common.js';
import { departmentPrefix } from './courses.js';
import { findCurriculum } from './curriculum.js';

/**
 * Planning helpers over the collected catalog and curricula. Nothing the student passes in is stored or sent anywhere:
 * the course list only lives for the duration of the call.
 */

const PassedSchema = z
  .array(z.string().min(2).max(20))
  .min(1)
  .max(150)
  .describe('Courses already passed, by code: "CENG 213", "MATH119" or the 7-digit catalog code "5710213"');

const CourseRef = z.object({ short_code: z.string(), code: z.string(), name: z.string() });
type CourseRefT = z.infer<typeof CourseRef>;

interface PrereqRow extends CourseRefT {
  prerequisites: string;
  prerequisite_note: string | null;
  ects: number | null;
}

/** Resolves the student's list to catalog course codes; returns what could not be found. */
function resolvePassed(db: DatabaseSync, input: string[]): { passed: Map<string, CourseRefT & { ects: number | null }>; unknown: string[] } {
  const get = db.prepare('SELECT code, short_code, name, ects FROM courses WHERE code = ? OR short_code = ? LIMIT 1');
  const passed = new Map<string, CourseRefT & { ects: number | null }>();
  const unknown: string[] = [];
  for (const raw of input) {
    const norm = normalizeCourseCode(raw);
    const row = get.get(norm, norm) as (CourseRefT & { ects: number | null }) | undefined;
    if (row) passed.set(row.code, row);
    else unknown.push(raw);
  }
  return { passed, unknown };
}

const short = (db: DatabaseSync, code: string): string =>
  (db.prepare('SELECT short_code FROM courses WHERE code = ?').get(code) as { short_code: string } | undefined)?.short_code ?? code;

const unknownLine = (unknown: string[], lang: Lang): string =>
  unknown.length
    ? lang === 'tr'
      ? `Katalogda bulunamayan kodlar (hesaba katılmadı): ${unknown.join(', ')}`
      : `Codes not found in the catalog (ignored): ${unknown.join(', ')}`
    : '';

export function registerPlanningTools(server: McpServer, db: DatabaseSync): void {
  server.registerTool(
    'metu_course_eligibility',
    {
      title: 'METU courses I can take now',
      description:
        'Given the courses a student has passed, lists the catalog courses whose prerequisite requirement is now met ' +
        '(one complete prerequisite set), and the courses missing exactly one prerequisite. Optional `department` ' +
        '(course prefix such as "CENG", or a department name) limits the list to that department\'s courses. Based on ' +
        'the academic catalog\'s prerequisite sets; departments may add conditions (class standing, consent), so the ' +
        'note of each course is included. Nothing is stored.',
      inputSchema: z.object({
        passed: PassedSchema,
        department: z.string().min(2).max(100).optional().describe('Only courses of this department (code or name)'),
        limit: z.number().int().min(1).max(60).default(30),
        lang: LangSchema,
      }),
      outputSchema: z.object({
        eligible: z.array(CourseRef.extend({ satisfied_by: z.array(z.string()), note: z.string().nullable() })),
        one_missing: z.array(CourseRef.extend({ missing: z.string() })),
        unknown_codes: z.array(z.string()),
        prerequisites_coverage: z.object({ courses: z.number(), with_details: z.number() }),
        ...COMMON_OUTPUT,
      }),
      annotations: { ...READ_ONLY, title: 'METU courses I can take now' },
    },
    async ({ passed: input, department, limit, lang }) => {
      const { passed, unknown } = resolvePassed(db, input);
      const prefix = department ? departmentPrefix(department) : undefined;
      if (department && !prefix) {
        return toolError(lang === 'tr' ? 'Bölümü ders koduyla ver (ör. "CENG").' : 'Give the department as a course prefix (e.g. "CENG").', lang);
      }
      const rows = db
        .prepare(
          `SELECT code, short_code, name, prerequisites, prerequisite_note, ects FROM courses
           WHERE prerequisites IS NOT NULL AND prerequisites != '[]' ${prefix ? 'AND short_code GLOB ?' : ''}
           ORDER BY short_code`,
        )
        .all(...(prefix ? [`${prefix}[0-9]*`] : [])) as unknown as PrereqRow[];
      const eligible: (CourseRefT & { satisfied_by: string[]; note: string | null })[] = [];
      const oneMissing: (CourseRefT & { missing: string })[] = [];
      for (const r of rows) {
        if (passed.has(r.code)) continue;
        const sets = JSON.parse(r.prerequisites) as string[][];
        // Only courses that build on something the student passed; a set of courses nobody has started is noise.
        if (!sets.some((s) => s.some((c) => passed.has(c)))) continue;
        const done = sets.find((s) => s.every((c) => passed.has(c)));
        if (done) {
          eligible.push({ code: r.code, short_code: r.short_code, name: r.name, satisfied_by: done.map((c) => short(db, c)), note: r.prerequisite_note });
          continue;
        }
        const near = sets.find((s) => s.filter((c) => !passed.has(c)).length === 1 && s.some((c) => passed.has(c)));
        if (near) oneMissing.push({ code: r.code, short_code: r.short_code, name: r.name, missing: short(db, near.find((c) => !passed.has(c))!) });
      }
      const shown = eligible.slice(0, limit);
      // Course details (with prerequisites) are fetched ~1000 per night; say so while the catalog is incomplete.
      const coverage = db
        .prepare(`SELECT count(*) AS n, sum(detail_fetched_at IS NOT NULL) AS done FROM courses ${prefix ? 'WHERE short_code GLOB ?' : ''}`)
        .get(...(prefix ? [`${prefix}[0-9]*`] : [])) as { n: number; done: number | null };
      const partial =
        coverage.n > 0 && (coverage.done ?? 0) < coverage.n
          ? lang === 'tr'
            ? `⚠️ Ön koşul bilgisi ${coverage.n} dersin henüz ${coverage.done ?? 0} tanesi için toplandı; liste eksik olabilir.`
            : `⚠️ Prerequisites are collected for ${coverage.done ?? 0} of ${coverage.n} courses so far; the list may be incomplete.`
          : '';
      const lines = [
        shown.length
          ? `${lang === 'tr' ? 'Ön koşulu sağlanan dersler' : 'Prerequisites met'} (${eligible.length}):\n` +
            shown.map((c) => `• ${c.short_code} ${c.name} — ${lang === 'tr' ? 'sağlayan' : 'via'} ${c.satisfied_by.join(' + ')}`).join('\n')
          : t(lang, 'no_results'),
        oneMissing.length
          ? `${lang === 'tr' ? 'Bir ön koşulu eksik' : 'One prerequisite missing'} (${oneMissing.length}):\n` +
            oneMissing.slice(0, limit).map((c) => `• ${c.short_code} ${c.name} — ${lang === 'tr' ? 'eksik' : 'missing'}: ${c.missing}`).join('\n')
          : '',
        unknownLine(unknown, lang),
        partial,
        lang === 'tr'
          ? 'Not: Katalogdaki ön koşul setlerine göredir; bölüm ek şart koyabilir (sınıf, izin). Kayıt öncesi danışmanına ve OİBS\'ye bak.'
          : 'Note: based on the catalog\'s prerequisite sets; departments may add conditions (class standing, consent). Check with your advisor and OIBS before registering.',
      ].filter(Boolean);
      return answer({
        lang,
        text: lines.join('\n\n'),
        data: {
          eligible: shown,
          one_missing: oneMissing.slice(0, limit),
          unknown_codes: unknown,
          prerequisites_coverage: { courses: coverage.n, with_details: coverage.done ?? 0 },
        },
        freshness: [computeFreshness(db, { kind: 'course', collector: 'catalog-details', source_url: CATALOG_BASE_URL }, lang)],
        see_also: seeAlso(db, { query: 'açılan dersler offered courses ders programı', category: 'courses', limit: 2 }, lang),
      });
    },
  );

  server.registerTool(
    'metu_degree_audit',
    {
      title: 'METU degree progress check',
      description:
        'Unofficial degree progress check against the official undergraduate curriculum: given a department and the ' +
        'courses passed, lists the must courses still missing (by semester), "choose one of" groups not yet covered, the ' +
        'elective slots of the curriculum, passed courses outside the must list (candidates for elective slots), and ' +
        'ECTS completed versus the curriculum total. Which elective a course may fill (technical, non-departmental, free) ' +
        'is decided by the department — confirm with your advisor. Nothing is stored.',
      inputSchema: z.object({
        department: z.string().min(2).max(100).describe('Department code or programme name ("CENG", "Matematik")'),
        passed: PassedSchema,
        lang: LangSchema,
      }),
      outputSchema: z.object({
        department: z.string(),
        url: z.string(),
        missing_must: z.array(CourseRef.extend({ semester: z.number(), ects: z.number().nullable() })),
        open_choices: z.array(z.object({ semester: z.number(), pick: z.number(), options: z.array(z.string()) })),
        elective_slots: z.array(z.object({ label: z.string(), count: z.number() })),
        other_passed: z.array(CourseRef),
        ects_completed: z.number(),
        ects_required: z.number().nullable(),
        unknown_codes: z.array(z.string()),
        ...COMMON_OUTPUT,
      }),
      annotations: { ...READ_ONLY, title: 'METU degree progress check' },
    },
    async ({ department, passed: input, lang }) => {
      const rec = findCurriculum(db, department);
      if (!rec?.data) {
        return toolError(
          `${t(lang, 'no_results')} ${lang === 'tr' ? 'Bölüm kodunu (ör. "CENG") ya da program adını dene.' : 'Try the department code (e.g. "CENG") or the programme name.'}`,
          lang,
          seeAlso(db, { query: 'müfredat curriculum katalog', category: 'courses', limit: 2 }, lang),
        );
      }
      const data = JSON.parse(rec.data) as { department: string; semesters: CurriculumSemester[] };
      const { passed, unknown } = resolvePassed(db, input);
      const used = new Set<string>();
      const missingMust: (CourseRefT & { semester: number; ects: number | null })[] = [];
      const openChoices: { semester: number; pick: number; options: string[] }[] = [];
      const slots = new Map<string, number>();
      for (const s of data.semesters) {
        for (const i of s.items) {
          if (i.kind === 'course') {
            if (passed.has(i.code)) used.add(i.code);
            else missingMust.push({ code: i.code, short_code: i.short_code, name: nameOf(db, i), semester: s.number, ects: i.ects });
          } else if (i.kind === 'choice') {
            const hit = i.options.filter((o) => passed.has(o.code));
            hit.forEach((o) => used.add(o.code));
            if (hit.length < i.pick) openChoices.push({ semester: s.number, pick: i.pick - hit.length, options: i.options.map((o) => o.short_code) });
          } else {
            const label = i.label.replace(/\s*\(.*$/, '').trim();
            slots.set(label, (slots.get(label) ?? 0) + 1);
          }
        }
      }
      const otherPassed = [...passed.values()].filter((c) => !used.has(c.code)).map(({ code, short_code, name }) => ({ code, short_code, name }));
      const ectsCompleted = [...passed.values()].reduce((sum, c) => sum + (c.ects ?? 0), 0);
      const totals = data.semesters.map((s) => s.ects_total);
      const ectsRequired = totals.every((x) => x !== null) ? totals.reduce((a, b) => a! + b!, 0) : null;
      const electiveSlots = [...slots].map(([label, count]) => ({ label, count }));

      const L = lang === 'tr';
      const bySemester = new Map<number, typeof missingMust>();
      for (const m of missingMust) bySemester.set(m.semester, [...(bySemester.get(m.semester) ?? []), m]);
      const lines = [
        `${data.department} — ${rec.url}`,
        missingMust.length
          ? `${L ? 'Eksik zorunlu dersler' : 'Must courses missing'} (${missingMust.length}):\n` +
            [...bySemester]
              .map(([n, list]) => `${n}. ${L ? 'dönem' : 'semester'}: ${list.map((m) => m.short_code).join(', ')}`)
              .join('\n')
          : L
            ? 'Tüm zorunlu dersler tamamlanmış görünüyor.'
            : 'All must courses appear to be completed.',
        openChoices.length
          ? `${L ? 'Seçmeli gruplar' : '"Choose one of" groups'}:\n` +
            openChoices.map((c) => `• ${c.semester}. ${L ? 'dönem' : 'semester'}: ${c.pick} × ${c.options.join(' / ')}`).join('\n')
          : '',
        electiveSlots.length
          ? `${L ? 'Müfredattaki seçmeli kutuları' : 'Elective slots in the curriculum'}:\n` +
            electiveSlots.map((e) => `• ${e.count} × ${e.label}`).join('\n')
          : '',
        otherPassed.length
          ? `${L ? 'Zorunlu listede olmayan geçilen dersler (seçmeli sayılabilir)' : 'Passed courses outside the must list (may fill elective slots)'}: ${otherPassed.map((c) => c.short_code).join(', ')}`
          : '',
        `${L ? 'Tamamlanan AKTS' : 'ECTS completed'}: ${ectsCompleted}${ectsRequired !== null ? ` / ${ectsRequired}` : ''}`,
        unknownLine(unknown, lang),
        L
          ? 'Bu resmi bir mezuniyet kontrolü değildir; seçmelilerin hangi kutuyu dolduracağına bölüm karar verir. Danışmanınla ve OİBS\'deki transkriptinle karşılaştır.'
          : 'This is not an official graduation check; the department decides which slot an elective fills. Compare with your advisor and your OIBS transcript.',
      ].filter(Boolean);
      return answer({
        lang,
        text: lines.join('\n\n'),
        data: {
          department: data.department,
          url: rec.url,
          missing_must: missingMust,
          open_choices: openChoices,
          elective_slots: electiveSlots,
          other_passed: otherPassed,
          ects_completed: ectsCompleted,
          ects_required: ectsRequired,
          unknown_codes: unknown,
        },
        freshness: [recordFreshness(db, rec, 'curriculum', lang)],
        see_also: seeAlso(db, { query: 'transkript transcript mezuniyet graduation', limit: 2 }, lang),
      });
    },
  );
}

function nameOf(db: DatabaseSync, c: CurriculumCourse): string {
  if (c.name) return c.name;
  return (db.prepare('SELECT name FROM courses WHERE code = ?').get(c.code) as { name: string } | undefined)?.name ?? '';
}
