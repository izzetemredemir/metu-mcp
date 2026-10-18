import * as cheerio from 'cheerio';
import { cleanText } from '../lib/sanitize.js';
import { upsertRecord } from '../store/records.js';
import { catalogUrl, normalizeCourseCode } from './catalog.js';
import { FetchError, politeFetch } from './http.js';
import { runUnit, type CollectorContext } from './runner.js';

/**
 * Undergraduate curricula from catalog.metu.edu.tr `program.php?fac_prog=<id>`: after the "Undergraduate Curriculum"
 * heading, one table per semester ("First Semester" … "Eighth Semester") with linked must courses, unlinked elective
 * rows ("TECHNICAL ELECTIVE"), "Any N of the following set" groups and a "Semester Total" (ECTS) row.
 * Stored as one record per programme (kind `curriculum`), so no table is needed.
 */

export interface CurriculumCourse {
  kind: 'course';
  code: string;
  short_code: string;
  name: string;
  credit: number | null;
  ects: number | null;
}
export type CurriculumItem =
  | CurriculumCourse
  | { kind: 'elective'; label: string; ects: number | null }
  | { kind: 'choice'; pick: number; options: CurriculumCourse[] };

export interface CurriculumSemester {
  number: number;
  label: string;
  items: CurriculumItem[];
  ects_total: number | null;
}

const ORDINALS = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth', 'Ninth', 'Tenth'];

/** Graduate schools publish no semester curricula. */
const GRADUATE_FACULTY_IDS = new Set([975, 900, 955, 850, 849]);

const num = (s: string) => {
  const t = s.trim();
  const n = Number(t.replace(',', '.'));
  return t !== '' && Number.isFinite(n) ? n : null;
};

/** Rows of one catalog course table: linked courses, "Any N of the following set" groups and unlinked elective rows. */
function parseTableItems(tableHtml: string): { items: CurriculumItem[]; total: number | null } {
  const $ = cheerio.load(tableHtml);
  const items: CurriculumItem[] = [];
  let group: { kind: 'choice'; pick: number; options: CurriculumCourse[] } | undefined;
  let total: number | null = null;
  const closeGroup = () => {
    if (group?.options.length) items.push(group);
    group = undefined;
  };
  $('tr').each((_, tr) => {
    const row = $(tr);
    const text = cleanText(row.text().replace(/\s+/g, ' '), 300);
    const any = /Any (\d+) of the following/i.exec(text);
    if (any) {
      closeGroup();
      group = { kind: 'choice', pick: Number(any[1]), options: [] };
      return;
    }
    if (/Semester Total/i.test(text)) {
      total = num(row.find('td').last().text());
      return;
    }
    if ((row.find('td').attr('style') ?? '').includes('border-top')) {
      closeGroup();
      return;
    }
    const cells = row.find('td');
    const link = row.find('td.short_course a[href*="course_code="]').first();
    if (link.length) {
      const course: CurriculumCourse = {
        kind: 'course',
        code: /course_code=(\d+)/.exec(link.attr('href') ?? '')![1]!,
        short_code: normalizeCourseCode(link.text()),
        name: cleanText(cells.eq(1).text(), 200),
        credit: num(cells.eq(2).text()),
        ects: num(cells.eq(5).text()),
      };
      if (group) group.options.push(course);
      else items.push(course);
      return;
    }
    const label = cleanText(row.find('td.course').text(), 120);
    if (label) items.push({ kind: 'elective', label, ects: num(cells.last().text()) });
  });
  closeGroup();
  return { items, total };
}

export function parseCurriculum(html: string): CurriculumSemester[] {
  const start = html.search(/Undergraduate Curriculum/i);
  if (start < 0) return [];
  const body = html.slice(start);
  const out: CurriculumSemester[] = [];
  const re = new RegExp(`(${ORDINALS.join('|')}) Semester\\s*(<table[\\s\\S]*?</table>)`, 'g');
  for (const m of body.matchAll(re)) {
    const { items, total } = parseTableItems(m[2]!);
    out.push({ number: ORDINALS.indexOf(m[1]!) + 1, label: `${m[1]} Semester`, items, ects_total: total });
  }
  return out;
}

/** One double major or minor programme offered by a department (a department may offer several). */
export interface SpecialProgram {
  title: string;
  description: string;
  items: CurriculumItem[];
  /** Text after the course tables, e.g. "3 elective course(s) approved by the Department …", "Total minimum credit: 21". */
  notes: string;
}

/** Headings inside a programme that introduce a course table rather than a new programme. */
const TABLE_HEADING = /^(compulsory|elective|restricted|required|must|core)\b.*\bcourses?\b/i;

/**
 * Double major (`program.php?dm_prog=<id>`) and minor (`min_prog=<id>`) pages: after the department links box, each
 * programme is an `<h3>` title, a description, "Compulsory Courses" (and similar) `<h3>` + table pairs, then free-text
 * requirements.
 */
export function parseSpecialPrograms(html: string): SpecialProgram[] {
  const start = html.indexOf('<!--depts_links -->');
  if (start < 0) return [];
  const end = html.indexOf('<footer', start);
  const content = html.slice(start, end < 0 ? undefined : end);
  const out: SpecialProgram[] = [];
  const textOf = (fragment: string) =>
    cleanText(cheerio.load(`<div>${fragment.replace(/<br\s*\/?>/gi, ' ')}</div>`)('div').text().replace(/\s+/g, ' '), 1500);
  for (const chunk of content.split(/<h3[^>]*>/i).slice(1)) {
    const close = chunk.search(/<\/h3>/i);
    if (close < 0) continue;
    const heading = textOf(chunk.slice(0, close));
    const rest = chunk.slice(close + 5);
    const tables = [...rest.matchAll(/<table[\s\S]*?<\/table>/gi)];
    const current = out[out.length - 1];
    if (TABLE_HEADING.test(heading) && current) {
      for (const t of tables) current.items.push(...parseTableItems(t[0]).items);
      const after = tables.length ? rest.slice(tables[tables.length - 1]!.index! + tables[tables.length - 1]![0].length) : rest;
      const note = textOf(after);
      if (note) current.notes = [current.notes, note].filter(Boolean).join(' ');
      continue;
    }
    if (!heading) continue;
    const firstTable = tables[0]?.index ?? rest.length;
    out.push({ title: heading, description: textOf(rest.slice(0, firstTable)), items: tables.flatMap((t) => parseTableItems(t[0]).items), notes: '' });
  }
  return out.filter((p) => p.items.length || p.description || p.notes);
}

function summary(semesters: CurriculumSemester[]): string {
  return semesters
    .map((s) => {
      const items = s.items.map((i) =>
        i.kind === 'course' ? `${i.short_code} ${i.name}` : i.kind === 'elective' ? i.label : `any ${i.pick} of ${i.options.map((o) => o.short_code).join('/')}`,
      );
      return `${s.label}: ${items.join(', ')}`;
    })
    .join('\n');
}

/** Weekly: the semester-by-semester curriculum of every undergraduate programme. */
export async function collectCurricula(ctx: CollectorContext): Promise<void> {
  await runUnit(ctx, 'curriculum', async () => {
    const programs = (
      ctx.db.prepare('SELECT prog, name, faculty_id FROM catalog_programs ORDER BY prog').all() as { prog: number; name: string; faculty_id: number }[]
    ).filter((p) => !GRADUATE_FACULTY_IDS.has(p.faculty_id));
    if (programs.length === 0) throw new Error('no catalog programmes yet (run the catalog collector first)');
    let stored = 0;
    for (const p of programs) {
      const url = catalogUrl(`program.php?fac_prog=${p.prog}`);
      let html: string;
      try {
        html = (await politeFetch(ctx.db, url)).body;
      } catch (err) {
        if (err instanceof FetchError && err.status === 404) continue;
        throw err;
      }
      const semesters = parseCurriculum(html);
      if (semesters.length === 0) continue; // programme without a published semester plan
      // Double major / minor pages, only when the programme page links them.
      for (const [param, kind] of [['dm_prog', 'double-major'], ['min_prog', 'minor']] as const) {
        if (!html.includes(`${param}=${p.prog}`)) continue;
        const pageUrl = catalogUrl(`program.php?${param}=${p.prog}`);
        try {
          const programs = parseSpecialPrograms((await politeFetch(ctx.db, pageUrl)).body);
          if (programs.length === 0) continue;
          upsertRecord(ctx.db, {
            id: `curriculum-${kind}:${p.prog}`,
            kind: 'curriculum',
            source: 'catalog',
            lang: 'en',
            title: `${p.name} ${kind === 'minor' ? 'minor' : 'double major'} programme${programs.length > 1 ? 's' : ''}`,
            body: programs.map((x) => `${x.title}\n${x.description}\n${x.notes}`).join('\n\n'),
            url: pageUrl,
            data: { prog: p.prog, department: p.name, programs },
            search_extra: `${p.name} ${kind === 'minor' ? 'minor yandal' : 'double major çift anadal'}`,
          });
        } catch (err) {
          // The main curriculum is the unit's purpose; a failing side page is logged, not fatal.
          ctx.log(`[curriculum] ${pageUrl}: ${(err as Error).message}`);
        }
      }
      upsertRecord(ctx.db, {
        id: `curriculum:${p.prog}`,
        kind: 'curriculum',
        source: 'catalog',
        lang: 'en',
        title: `${p.name} undergraduate curriculum`,
        body: summary(semesters),
        url,
        data: { prog: p.prog, department: p.name, semesters },
        search_extra: p.name,
      });
      stored++;
    }
    if (stored < 10) throw new Error(`only ${stored} curricula parsed (catalog layout change?)`);
    return stored;
  });
}
