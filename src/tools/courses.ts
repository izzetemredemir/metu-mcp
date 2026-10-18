import type { DatabaseSync } from 'node:sqlite';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { CATALOG_BASE_URL, type Lang } from '../config.js';
import { normalizeCourseCode } from '../collectors/catalog.js';
import { t } from '../i18n.js';
import { loadLinks } from '../links.js';
import { foldTr } from '../lib/text.js';
import { computeFreshness, type Freshness } from '../store/freshness.js';
import { answer, COMMON_OUTPUT, LangSchema, linkOut, READ_ONLY, toolError, type LinkOut } from './common.js';

export interface CourseRow {
  code: string;
  short_code: string;
  name: string;
  prog: number;
  department: string;
  metu_credit: number | null;
  contact_hours: number | null;
  lab_hours: number | null;
  ects: number | null;
  credit_text: string | null;
  language: string | null;
  level: string | null;
  coordinator: string | null;
  offered_semester: string | null;
  prerequisites: string | null;
  prerequisite_note: string | null;
  content: string | null;
  syllabus: string | null;
  url: string;
  listed_at: string;
  detail_fetched_at: string | null;
}

const CourseRef = z.object({ code: z.string(), short_code: z.string(), name: z.string() });
type CourseRefT = z.infer<typeof CourseRef>;

const CourseOut = z.object({
  short_code: z.string().describe('Course code as students write it, e.g. CENG213'),
  code: z.string().describe('Numeric catalog code, e.g. 5710213'),
  name: z.string(),
  department: z.string(),
  metu_credit: z.number().nullable(),
  credit_text: z.string().nullable().describe('METU credit (theoretical-lab hours/week), e.g. "4(3-2)"'),
  ects: z.number().nullable(),
  language: z.string().nullable(),
  level: z.string().nullable(),
  offered_semester: z.string().nullable().describe('As stated in the catalog; not proof the course is offered this term'),
  coordinator: z.string().nullable(),
  prerequisites: z
    .array(z.array(CourseRef))
    .nullable()
    .describe('Alternative sets: completing ANY one set satisfies the prerequisite. null = details not collected yet'),
  required_by: z.array(CourseRef).describe('Courses that list this one in a prerequisite set'),
  content: z.string().nullable(),
  objectives: z.string().nullable().describe('Course objectives from the syllabus (odtusyllabus.metu.edu.tr)'),
  learning_outcomes: z.string().nullable().describe('Learning outcomes from the syllabus'),
  url: z.string(),
});
type CourseOutT = z.infer<typeof CourseOut>;

export const COURSE_COLUMNS = `code, short_code, name, prog, department, metu_credit, contact_hours, lab_hours, ects, credit_text, language,
  level, coordinator, offered_semester, prerequisites, prerequisite_note, content, syllabus, url, listed_at, detail_fetched_at`;

function refs(db: DatabaseSync, codes: string[]): Map<string, CourseRefT> {
  if (codes.length === 0) return new Map();
  const rows = db
    .prepare(`SELECT code, short_code, name FROM courses WHERE code IN (${codes.map(() => '?').join(',')})`)
    .all(...codes) as CourseRefT[];
  return new Map(rows.map((r) => [r.code, r]));
}

export function courseOut(db: DatabaseSync, c: CourseRow, withRelations: boolean): CourseOutT {
  let prerequisites: CourseRefT[][] | null = null;
  let requiredBy: CourseRefT[] = [];
  if (withRelations) {
    const sets = c.prerequisites ? (JSON.parse(c.prerequisites) as string[][]) : null;
    if (sets) {
      const known = refs(db, sets.flat());
      prerequisites = sets.map((set) => set.map((code) => known.get(code) ?? { code, short_code: code, name: '' }));
    }
    requiredBy = db
      .prepare(`SELECT code, short_code, name FROM courses WHERE prerequisites LIKE ? ORDER BY short_code LIMIT 30`)
      .all(`%"${c.code}"%`) as CourseRefT[];
  }
  const syllabus = (c.syllabus ? JSON.parse(c.syllabus) : {}) as { objectives?: string; outcomes?: string };
  return {
    short_code: c.short_code,
    code: c.code,
    name: c.name,
    department: c.department,
    metu_credit: c.metu_credit,
    credit_text: c.credit_text,
    ects: c.ects,
    language: c.language,
    level: c.level,
    offered_semester: c.offered_semester,
    coordinator: c.coordinator,
    prerequisites,
    required_by: requiredBy,
    content: c.content,
    objectives: syllabus.objectives ?? null,
    learning_outcomes: syllabus.outcomes ?? null,
    url: c.url,
  };
}

const L = {
  credit: { en: 'METU credit', tr: 'ODTÜ kredisi' },
  ects: { en: 'ECTS', tr: 'AKTS' },
  language: { en: 'Language', tr: 'Dil' },
  level: { en: 'Level', tr: 'Düzey' },
  semester: { en: 'Offered', tr: 'Açıldığı dönem' },
  coordinator: { en: 'Coordinator', tr: 'Koordinatör' },
  prereq: { en: 'Prerequisite', tr: 'Önkoşul' },
  prereq_none: { en: 'none listed', tr: 'listelenmemiş' },
  prereq_any: { en: 'any one of these sets', tr: 'bu setlerden herhangi biri' },
  prereq_unknown: { en: 'details not collected yet — see the catalog page', tr: 'ayrıntılar henüz toplanmadı — katalog sayfasına bak' },
  required_by: { en: 'Prerequisite for', tr: 'Önkoşulu olduğu dersler' },
  content: { en: 'Content', tr: 'İçerik' },
  objectives: { en: 'Objectives', tr: 'Amaç' },
  outcomes: { en: 'Learning outcomes', tr: 'Öğrenme çıktıları' },
  not_offered_note: {
    en: 'The catalog does not say whether the course is offered this term or by whom; check the offered-courses page.',
    tr: 'Katalog, dersin bu dönem açılıp açılmadığını ve kimin verdiğini göstermez; açılan dersler sayfasına bak.',
  },
} as const satisfies Record<string, Record<Lang, string>>;

function formatRef(r: CourseRefT): string {
  return r.name ? `${r.short_code} (${r.name})` : r.short_code;
}

function formatCourse(c: CourseOutT, lang: Lang): string {
  const lines = [`${c.short_code} — ${c.name} (${c.department})`];
  const credit = c.credit_text ?? (c.metu_credit !== null ? String(c.metu_credit) : null);
  const facts = [
    credit && `${L.credit[lang]}: ${credit}`,
    c.ects !== null && `${L.ects[lang]}: ${c.ects}`,
    c.language && `${L.language[lang]}: ${c.language}`,
    c.level && `${L.level[lang]}: ${c.level}`,
    c.offered_semester && `${L.semester[lang]}: ${c.offered_semester}`,
  ].filter(Boolean);
  if (facts.length) lines.push(facts.join(' · '));
  if (c.coordinator) lines.push(`${L.coordinator[lang]}: ${c.coordinator}`);
  if (c.prerequisites === null) lines.push(`${L.prereq[lang]}: ${L.prereq_unknown[lang]}`);
  else if (c.prerequisites.length === 0) lines.push(`${L.prereq[lang]}: ${L.prereq_none[lang]}`);
  else if (c.prerequisites.length === 1) lines.push(`${L.prereq[lang]}: ${c.prerequisites[0]!.map(formatRef).join(' + ')}`);
  else {
    lines.push(`${L.prereq[lang]} (${L.prereq_any[lang]}):`);
    c.prerequisites.forEach((set, i) => lines.push(`  ${i + 1}. ${set.map(formatRef).join(' + ')}`));
  }
  if (c.required_by.length) lines.push(`${L.required_by[lang]}: ${c.required_by.map((r) => r.short_code).join(', ')}`);
  if (c.content) lines.push(`${L.content[lang]}: ${c.content}`);
  const cut = (t: string) => (t.length > 900 ? `${t.slice(0, 899)}…` : t);
  if (c.objectives) lines.push(`${L.objectives[lang]}: ${cut(c.objectives)}`);
  if (c.learning_outcomes) lines.push(`${L.outcomes[lang]}:\n${cut(c.learning_outcomes)}`);
  lines.push(c.url);
  return lines.join('\n');
}

function catalogFreshness(db: DatabaseSync, rows: CourseRow[], lang: Lang): Freshness {
  if (rows.length === 1) {
    const c = rows[0]!;
    return computeFreshness(
      db,
      { kind: 'course', collector: c.detail_fetched_at ? 'catalog-details' : 'catalog', source_url: c.url, fetched_at: c.detail_fetched_at ?? c.listed_at },
      lang,
    );
  }
  return computeFreshness(db, { kind: 'course', collector: 'catalog', source_url: CATALOG_BASE_URL }, lang);
}

function courseLinks(lang: Lang): LinkOut[] {
  const ids = ['oibs2-course-schedule', 'course-catalog'];
  return loadLinks()
    .filter((l) => ids.includes(l.id))
    .map((l) => linkOut(l, lang));
}

/** Turkish department names and abbreviations students use → catalog course prefix (keys are foldTr-folded). */
const DEPARTMENT_ALIASES: Record<string, string> = {
  bote: 'CEIT', 'bilgisayar ve ogretim teknolojileri': 'CEIT', 'bilgisayar muhendisligi': 'CENG', bilmuh: 'CENG',
  'elektrik elektronik': 'EE', 'elektrik elektronik muhendisligi': 'EE', 'makine muhendisligi': 'ME', makine: 'ME',
  'insaat muhendisligi': 'CE', insaat: 'CE', 'endustri muhendisligi': 'IE', endustri: 'IE', 'kimya muhendisligi': 'CHE',
  'havacilik ve uzay muhendisligi': 'AEE', havacilik: 'AEE', 'cevre muhendisligi': 'ENVE', 'gida muhendisligi': 'FDE',
  'jeoloji muhendisligi': 'GEOE', 'maden muhendisligi': 'MINE', 'petrol ve dogal gaz muhendisligi': 'PETE',
  'metalurji ve malzeme muhendisligi': 'METE', metalurji: 'METE', 'muhendislik bilimleri': 'ES', matematik: 'MATH',
  fizik: 'PHYS', kimya: 'CHEM', biyoloji: 'BIOL', 'molekuler biyoloji ve genetik': 'GENE', istatistik: 'STAT',
  tarih: 'HIST', felsefe: 'PHIL', psikoloji: 'PSY', sosyoloji: 'SOC', iktisat: 'ECON', ekonomi: 'ECON', isletme: 'BA',
  'uluslararasi iliskiler': 'IR', 'siyaset bilimi ve kamu yonetimi': 'ADM', 'siyaset bilimi': 'ADM', mimarlik: 'ARCH',
  'sehir ve bolge planlama': 'CRP', 'sehir planlama': 'CRP', 'endustriyel tasarim': 'ID', 'yabanci diller egitimi': 'FLE',
  'ingiliz dili ogretmenligi': 'FLE', 'egitim bilimleri': 'EDS', 'okul oncesi egitimi': 'ECE', 'beden egitimi ve spor': 'PES',
  'turk dili': 'TURK', muzik: 'MUS',
};

const DEPT_FILLER = /\b(bolumu|bolum|dersleri|dersler|department|courses|of)\b/g;

/** Department course prefix for a query like "CENG", "BÖTE" or "Matematik bölümü dersleri", if it names one. */
export function departmentPrefix(query: string): string | undefined {
  const key = foldTr(query).replace(DEPT_FILLER, ' ').replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (DEPARTMENT_ALIASES[key]) return DEPARTMENT_ALIASES[key];
  return /^[a-z]{2,6}$/.test(key) ? key.toUpperCase() : undefined;
}

type FindResult = { mode: 'exact' | 'department' | 'search'; rows: CourseRow[]; total: number };

/** Finds courses by exact code ("CENG 213", "5710213"), department ("CENG", "BÖTE") or words in name/content. */
export function findCourses(db: DatabaseSync, query: string, limit: number, offset = 0): FindResult {
  const norm = normalizeCourseCode(query);
  if (/^\d{7}$/.test(norm) || /^[A-Z]{2,6}\d{3,4}[A-Z]?$/.test(norm)) {
    const rows = db
      .prepare(`SELECT ${COURSE_COLUMNS} FROM courses WHERE code = ? OR short_code = ? ORDER BY prog`)
      .all(norm, norm) as unknown as CourseRow[];
    if (rows.length) return { mode: 'exact', rows, total: rows.length };
  }
  const prefix = departmentPrefix(query);
  if (prefix) {
    const pattern = `${prefix}[0-9]*`;
    const total = (db.prepare(`SELECT count(*) AS n FROM courses WHERE short_code GLOB ?`).get(pattern) as { n: number }).n;
    if (total > 0) {
      const rows = db
        .prepare(`SELECT ${COURSE_COLUMNS} FROM courses WHERE short_code GLOB ? ORDER BY short_code LIMIT ? OFFSET ?`)
        .all(pattern, limit, offset) as unknown as CourseRow[];
      return { mode: 'department', rows, total };
    }
  }
  const words = foldTr(query)
    .split(/\s+/)
    .filter((w) => w.length >= 2)
    .slice(0, 6);
  if (words.length === 0) return { mode: 'search', rows: [], total: 0 };
  const where = words.map(() => `search_text LIKE ?`).join(' AND ');
  const params = words.map((w) => `%${w}%`);
  const total = (db.prepare(`SELECT count(*) AS n FROM courses WHERE ${where}`).get(...params) as { n: number }).n;
  const rows = db
    .prepare(`SELECT ${COURSE_COLUMNS} FROM courses WHERE ${where} ORDER BY (name LIKE ?) DESC, short_code LIMIT ? OFFSET ?`)
    .all(...params, `%${query.trim()}%`, limit, offset) as unknown as CourseRow[];
  return { mode: 'search', rows, total };
}

export function registerCourseTools(server: McpServer, db: DatabaseSync): void {
  server.registerTool(
    'metu_course_info',
    {
      title: 'METU course catalog',
      description:
        'Looks up METU courses in the official course catalog (catalog.metu.edu.tr): METU credit, ECTS, language, level, ' +
        'usual semester, coordinator, prerequisites (alternative sets) and which courses require it, and the course content. ' +
        'Query by code ("CENG 213", "ceng213", "5710213"), by department to list its courses ("CENG", "MATH", "BÖTE", ' +
        '"Matematik"), or by ' +
        'words from the title/content ("data structures", "machine learning"). It does NOT know whether a course is offered ' +
        'this term, its sections, instructors or hours — point the student to the offered-courses page for that.',
      inputSchema: z.object({
        query: z.string().min(2).max(120).describe('Course code, department prefix, or words from the course title/content'),
        limit: z.number().int().min(1).max(50).default(10),
        offset: z.number().int().min(0).default(0).describe('Skip this many results (paging through a department or search)'),
        lang: LangSchema,
      }),
      outputSchema: z.object({
        mode: z.enum(['exact', 'department', 'search']),
        total: z.number().describe('Number of matching courses (may exceed the returned list)'),
        courses: z.array(CourseOut),
        ...COMMON_OUTPUT,
      }),
      annotations: { ...READ_ONLY, title: 'METU course catalog' },
    },
    async ({ query, limit, offset, lang }) => {
      const { mode, rows, total } = findCourses(db, query, limit, offset);
      const links = courseLinks(lang);
      if (rows.length === 0) {
        const hasData = (db.prepare('SELECT count(*) AS n FROM courses').get() as { n: number }).n > 0;
        const msg = hasData
          ? `${t(lang, 'no_results')} ${lang === 'tr' ? 'Ders kodunu (ör. "CENG 213") ya da ders adından kelimeler dene.' : 'Try a course code (e.g. "CENG 213") or words from the course title.'}`
          : lang === 'tr'
            ? 'Ders kataloğu henüz toplanmadı; doğrudan katalog sayfasına bak.'
            : 'The course catalog has not been collected yet; check the catalog site directly.';
        return toolError(msg, lang, links);
      }
      const detailed = mode === 'exact';
      const courses = rows.map((r) => courseOut(db, r, detailed));
      const body = detailed
        ? courses.map((c) => formatCourse(c, lang)).join('\n\n')
        : courses
            .map((c) => `• ${c.short_code} — ${c.name}${c.metu_credit !== null ? ` · ${c.metu_credit} cr` : ''}${c.ects !== null ? ` · ${c.ects} ${L.ects[lang]}` : ''}`)
            .join('\n');
      const parts = [body];
      const shownUpTo = mode === 'exact' ? rows.length : offset + rows.length;
      if (total > shownUpTo) parts.push(t(lang, 'more_results', { n: total - shownUpTo, offset: shownUpTo }));
      if (lang === 'tr') parts.push(t(lang, 'fallback_lang'));
      parts.push(L.not_offered_note[lang]);
      return answer({
        lang,
        text: parts.join('\n\n'),
        data: { mode, total, courses },
        freshness: [catalogFreshness(db, rows, lang)],
        see_also: links,
      });
    },
  );
}
