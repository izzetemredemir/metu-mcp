import type { DatabaseSync } from 'node:sqlite';
import * as cheerio from 'cheerio';
import { CATALOG_BASE_URL, CATALOG_DETAILS_PER_RUN, CATALOG_FACULTY_IDS, SYLLABUS_PER_RUN } from '../config.js';
import { cleanText, htmlToText } from '../lib/sanitize.js';
import { foldTr } from '../lib/text.js';
import { now } from '../lib/time.js';
import { transaction } from '../store/db.js';
import { FetchError, politeFetch } from './http.js';
import { runUnit, type CollectorContext } from './runner.js';

/**
 * Course catalog (catalog.metu.edu.tr): faculty → programmes (`fac_inst.php`) → courses given by each department
 * (`prog_courses.php`, one table with credits) → course pages (`course.php`, details and prerequisites).
 * The list pages are crawled weekly; detail pages are refreshed in daily batches, oldest first.
 */

export interface CatalogProgram {
  prog: number;
  name: string;
  degree: string;
}

export interface CatalogCourseRow {
  code: string;
  short_code: string;
  name: string;
  metu_credit: number | null;
  contact_hours: number | null;
  lab_hours: number | null;
  ects: number | null;
}

export interface CatalogCourseDetail {
  code: string;
  short_code: string;
  name: string;
  credit_text: string | null;
  ects: number | null;
  department: string | null;
  language: string | null;
  level: string | null;
  coordinator: string | null;
  offered_semester: string | null;
  /** Alternative sets of course codes; completing any one set satisfies the prerequisite. */
  prerequisites: string[][];
  prerequisite_note: string | null;
  content: string | null;
  /** odtusyllabus.metu.edu.tr fragments embedded on the course page (objectives, learning outcomes). */
  syllabus_urls: { objectives?: string; outcomes?: string };
}

const num = (s: string): number | null => {
  const n = Number(s.trim().replace(',', '.'));
  return s.trim() !== '' && Number.isFinite(n) ? n : null;
};

export const catalogUrl = (path: string) => new URL(path, CATALOG_BASE_URL).href;
export const courseUrl = (prog: number, code: string) => catalogUrl(`course.php?prog=${prog}&course_code=${code}`);

/** "CENG 213", "ceng213" → "CENG213". */
export function normalizeCourseCode(s: string): string {
  return s.toUpperCase().replace(/[\s._-]+/g, '');
}

export function parseFacultyPrograms(html: string, facultyId: number): { faculty: string; programs: CatalogProgram[] } {
  const $ = cheerio.load(html);
  const faculty =
    cleanText($(`a[href="fac_inst.php?fac_inst=${facultyId}"]`).first().text(), 200) || cleanText($('h2').first().text(), 200);
  const programs: CatalogProgram[] = [];
  $('table.fac_inst tr').each((_, tr) => {
    // Faculties link `program.php?fac_prog=<id>`, graduate schools `program.php?inst_prog=<id>`; both ids work for prog_courses.php.
    const a = $(tr).find('a[href*="program.php?"]').first();
    const prog = Number(/(?:fac|inst)_prog=(\d+)/.exec(a.attr('href') ?? '')?.[1]);
    if (!prog) return;
    const degree = $(tr)
      .find('td')
      .slice(1)
      .map((_, td) => cleanText($(td).text(), 40))
      .get()
      .filter(Boolean)
      .join(', ');
    programs.push({ prog, name: cleanText(a.text(), 200), degree });
  });
  return { faculty, programs };
}

export function parseProgramCourses(html: string): { department: string; courses: CatalogCourseRow[] } {
  const $ = cheerio.load(html);
  const department = cleanText($('#navbar a[href^="program.php"]').last().text(), 200);
  const courses: CatalogCourseRow[] = [];
  $('td.short_course').each((_, td) => {
    const a = $(td).find('a').first();
    const code = /course_code=(\d+)/.exec(a.attr('href') ?? '')?.[1];
    if (!code) return;
    const cells = $(td).parent().find('td');
    courses.push({
      code,
      short_code: normalizeCourseCode(a.text()),
      name: cleanText(cells.eq(1).text(), 300),
      metu_credit: num(cells.eq(2).text()),
      contact_hours: num(cells.eq(3).text()),
      lab_hours: num(cells.eq(4).text()),
      ects: num(cells.eq(5).text()),
    });
  });
  return { department, courses };
}

export function parseCourseDetail(html: string): CatalogCourseDetail | null {
  const $ = cheerio.load(html);
  const heading = cleanText($('#navbar').nextAll('h2').first().text() || $('h2').first().text(), 300);
  const m = /^([A-Z]{2,6}\s?\d{3,4}[A-Z]?)\s+(.*)$/.exec(heading);
  const fields = new Map<string, string>();
  let prerequisites: string[][] = [];
  let prerequisiteNote: string | null = null;
  let code: string | null = null;

  $('table.course tr').each((_, tr) => {
    const cells = $(tr).find('td');
    const label = cleanText(cells.first().text(), 200).replace(/:$/, '').toLowerCase();
    if (cells.length === 1 && cells.first().attr('colspan')) {
      prerequisiteNote = cleanText(cells.first().text().replace(/\s+/g, ' '), 500).replace(/ \.$/, '.') || null;
      return;
    }
    if (label === 'prerequisite') {
      const valueHtml = cells.eq(1).html() ?? '';
      prerequisites = valueHtml
        .split(/<br\s*\/?>/i)
        .map((part) => [...part.matchAll(/course_code=(\d+)/g)].map((x) => x[1]!))
        .filter((set) => set.length > 0);
      return;
    }
    if (label === 'course code') code = cleanText(cells.eq(1).text(), 20);
    else fields.set(label, cleanText(cells.eq(1).text(), 300));
  });
  if (!code) return null;

  const body = $('.field-body').first().html() ?? '';
  const contentStart = body.search(/<h3>\s*Course Content\s*<\/h3>/i);
  let content: string | null = null;
  if (contentStart >= 0) {
    const rest = body.slice(contentStart).replace(/^<h3>[\s\S]*?<\/h3>/i, '');
    const end = rest.search(/<iframe|<h3/i);
    content = cleanText(htmlToText(end >= 0 ? rest.slice(0, end) : rest, 4000), 4000) || null;
  }

  const field = (prefix: string) => [...fields].find(([k]) => k.startsWith(prefix))?.[1] || null;
  const syllabusUrl = (id: string) => {
    const src = $(`iframe#${id}`).attr('src');
    return src && /^https:\/\/odtusyllabus\.metu\.edu\.tr\/get\.php\?/.test(src) ? src : undefined;
  };
  const syllabus_urls: CatalogCourseDetail['syllabus_urls'] = {};
  const objectives = syllabusUrl('courseObjectives');
  const outcomes = syllabusUrl('courseLearningOutcomes');
  if (objectives) syllabus_urls.objectives = objectives;
  if (outcomes) syllabus_urls.outcomes = outcomes;
  return {
    code,
    short_code: normalizeCourseCode(m?.[1] ?? ''),
    name: cleanText(m?.[2] ?? heading, 300),
    credit_text: field('metu credit'),
    ects: num(field('ects credit') ?? ''),
    department: field('department'),
    language: field('language of instruction'),
    level: field('level of study'),
    coordinator: field('course coordinator'),
    offered_semester: field('offered semester')?.replace(/\.$/, '') ?? null,
    prerequisites,
    prerequisite_note: prerequisiteNote,
    content,
    syllabus_urls,
  };
}

function courseSearchText(c: { short_code: string; name: string; department: string; content?: string | null }): string {
  const spaced = c.short_code.replace(/^([A-Z]+)(\d)/, '$1 $2');
  return foldTr(`${c.short_code} ${spaced} ${c.name} ${c.department} ${c.content ?? ''}`);
}

/** Stores one programme and the courses listed on its `prog_courses.php` page. */
export function saveProgramCourses(
  db: DatabaseSync,
  p: CatalogProgram & { faculty_id: number; faculty: string },
  parsed: ReturnType<typeof parseProgramCourses>,
  listedAt: string,
): void {
  const department = parsed.department || p.name;
  transaction(db, () => {
    db.prepare(
      `INSERT INTO catalog_programs (prog, name, degree, faculty_id, faculty, fetched_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(prog) DO UPDATE SET name = excluded.name, degree = excluded.degree, faculty_id = excluded.faculty_id,
         faculty = excluded.faculty, fetched_at = excluded.fetched_at`,
    ).run(p.prog, p.name, p.degree, p.faculty_id, p.faculty, listedAt);
    const upsert = db.prepare(
      `INSERT INTO courses (code, short_code, name, prog, department, metu_credit, contact_hours, lab_hours, ects, url, search_text, listed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(code) DO UPDATE SET short_code = excluded.short_code, name = excluded.name, prog = excluded.prog,
         department = excluded.department, metu_credit = excluded.metu_credit, contact_hours = excluded.contact_hours,
         lab_hours = excluded.lab_hours, ects = excluded.ects, url = excluded.url, listed_at = excluded.listed_at`,
    );
    for (const c of parsed.courses) {
      upsert.run(
        c.code, c.short_code, c.name, p.prog, department, c.metu_credit, c.contact_hours, c.lab_hours, c.ects,
        courseUrl(p.prog, c.code), courseSearchText({ ...c, department }), listedAt,
      );
    }
  });
}

/** Weekly: faculties → programmes → course lists. Courses that disappear from every list are removed. */
export async function collectCatalog(ctx: CollectorContext): Promise<void> {
  await runUnit(ctx, 'catalog', async () => {
    const startedAt = now().toISOString();
    const programs: (CatalogProgram & { faculty_id: number; faculty: string })[] = [];
    for (const facultyId of CATALOG_FACULTY_IDS) {
      const res = await politeFetch(ctx.db, catalogUrl(`fac_inst.php?fac_inst=${facultyId}`));
      const { faculty, programs: list } = parseFacultyPrograms(res.body, facultyId);
      for (const p of list) if (!programs.some((x) => x.prog === p.prog)) programs.push({ ...p, faculty_id: facultyId, faculty });
    }
    if (programs.length < 30) throw new Error(`only ${programs.length} programmes parsed (catalog layout change?)`);

    let total = 0;
    for (const p of programs) {
      let parsed: ReturnType<typeof parseProgramCourses>;
      try {
        parsed = parseProgramCourses((await politeFetch(ctx.db, catalogUrl(`prog_courses.php?prog=${p.prog}`))).body);
      } catch (err) {
        if (err instanceof FetchError && err.status === 404) continue;
        throw err;
      }
      saveProgramCourses(ctx.db, p, parsed, startedAt);
      total += parsed.courses.length;
    }
    if (total < 500) throw new Error(`only ${total} courses parsed (catalog layout change?)`);
    ctx.db.prepare('DELETE FROM courses WHERE listed_at < ?').run(startedAt);
    return total;
  });
}

/** Daily: refresh a batch of course detail pages, never-fetched first, then the oldest. */
export async function collectCatalogDetails(ctx: CollectorContext, limit = CATALOG_DETAILS_PER_RUN): Promise<void> {
  await runUnit(ctx, 'catalog-details', async () => {
    const batch = ctx.db
      .prepare(
        `SELECT code, prog, url, department FROM courses
         ORDER BY detail_fetched_at IS NOT NULL, detail_fetched_at LIMIT ?`,
      )
      .all(limit) as { code: string; prog: number; url: string; department: string }[];
    if (batch.length === 0) return 0;
    let ok = 0;
    let failed = 0;
    const update = ctx.db.prepare(
      `UPDATE courses SET credit_text = ?, ects = COALESCE(?, ects), language = ?, level = ?, coordinator = ?,
         offered_semester = ?, prerequisites = ?, prerequisite_note = ?, content = ?, search_text = ?, detail_fetched_at = ?,
         syllabus_urls = ?
       WHERE code = ?`,
    );
    for (const row of batch) {
      try {
        const d = parseCourseDetail((await politeFetch(ctx.db, row.url)).body);
        if (!d) throw new Error('no course table');
        update.run(
          d.credit_text, d.ects, d.language, d.level, d.coordinator, d.offered_semester,
          JSON.stringify(d.prerequisites), d.prerequisite_note, d.content,
          courseSearchText({ short_code: d.short_code, name: d.name, department: row.department, content: d.content }),
          now().toISOString(), Object.keys(d.syllabus_urls).length ? JSON.stringify(d.syllabus_urls) : null, row.code,
        );
        ok++;
      } catch (err) {
        failed++;
        // Rotate it to the back of the queue so one broken page cannot block the batch head.
        ctx.db.prepare('UPDATE courses SET detail_fetched_at = ? WHERE code = ?').run(now().toISOString(), row.code);
        ctx.log(`[catalog-details] ${row.code}: ${(err as Error).message}`);
      }
    }
    if (ok === 0 || failed > batch.length / 2) throw new Error(`${failed} of ${batch.length} course pages failed`);
    return ok;
  });
}

/** Text of one odtusyllabus fragment (the `<h3>` heading dropped). */
export function parseSyllabusFragment(html: string): string {
  const $ = cheerio.load(html);
  $('h3').first().remove();
  return cleanText(htmlToText($('body').html() ?? '', 4000), 4000);
}

/**
 * Nightly: course objectives and learning outcomes from odtusyllabus.metu.edu.tr for a batch of courses whose catalog
 * page embeds them (URLs saved by catalog-details), never-fetched first.
 */
export async function collectSyllabi(ctx: CollectorContext, limit = SYLLABUS_PER_RUN): Promise<void> {
  await runUnit(ctx, 'syllabus', async () => {
    const batch = ctx.db
      .prepare(
        `SELECT code, syllabus_urls FROM courses WHERE syllabus_urls IS NOT NULL
         ORDER BY syllabus_fetched_at IS NOT NULL, syllabus_fetched_at LIMIT ?`,
      )
      .all(limit) as { code: string; syllabus_urls: string }[];
    if (batch.length === 0) return 0;
    let ok = 0;
    for (const row of batch) {
      const urls = JSON.parse(row.syllabus_urls) as CatalogCourseDetail['syllabus_urls'];
      const syllabus: { objectives?: string; outcomes?: string } = {};
      try {
        for (const key of ['objectives', 'outcomes'] as const) {
          const url = urls[key];
          if (url) syllabus[key] = parseSyllabusFragment((await politeFetch(ctx.db, url, { conditional: false })).body) || undefined;
        }
        ctx.db
          .prepare('UPDATE courses SET syllabus = ?, syllabus_fetched_at = ? WHERE code = ?')
          .run(Object.keys(syllabus).length ? JSON.stringify(syllabus) : null, now().toISOString(), row.code);
        ok++;
      } catch (err) {
        // Links can expire; rotate to the back and let the next catalog-details run refresh them.
        ctx.db.prepare('UPDATE courses SET syllabus_fetched_at = ? WHERE code = ?').run(now().toISOString(), row.code);
        ctx.log(`[syllabus] ${row.code}: ${(err as Error).message}`);
      }
    }
    if (ok === 0) throw new Error(`all ${batch.length} syllabus fetches failed`);
    return ok;
  });
}
