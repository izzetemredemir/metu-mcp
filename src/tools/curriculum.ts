import type { DatabaseSync } from 'node:sqlite';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { CATALOG_BASE_URL, type Lang } from '../config.js';
import type { CurriculumCourse, CurriculumItem, CurriculumSemester, SpecialProgram } from '../collectors/curriculum.js';
import { t } from '../i18n.js';
import { foldTr } from '../lib/text.js';
import { computeFreshness } from '../store/freshness.js';
import { getRecord, type StoredRecord } from '../store/records.js';
import { answer, COMMON_OUTPUT, LangSchema, READ_ONLY, recordFreshness, seeAlso, toolError } from './common.js';
import { departmentPrefix } from './courses.js';

/** The curriculum record for a department code ("CENG", "BÖTE") or a programme name ("Computer Engineering"). */
export function findCurriculum(db: DatabaseSync, department: string): StoredRecord | undefined {
  const prefix = departmentPrefix(department);
  if (prefix) {
    const row = db
      .prepare(`SELECT prog, count(*) AS n FROM courses WHERE short_code GLOB ? GROUP BY prog ORDER BY n DESC LIMIT 1`)
      .get(`${prefix}[0-9]*`) as { prog: number } | undefined;
    const rec = row ? getRecord(db, `curriculum:${row.prog}`) : undefined;
    if (rec) return rec;
  }
  const words = foldTr(department).split(/\s+/).filter((w) => w.length >= 3);
  if (words.length === 0) return undefined;
  const programs = db.prepare('SELECT prog, name FROM catalog_programs').all() as { prog: number; name: string }[];
  const hit = programs
    .map((p) => ({ p, score: words.filter((w) => foldTr(p.name).includes(w)).length, exact: foldTr(p.name) === foldTr(department) }))
    .filter((x) => x.score === words.length)
    .sort((a, b) => Number(b.exact) - Number(a.exact) || a.p.name.length - b.p.name.length)[0];
  return hit ? getRecord(db, `curriculum:${hit.p.prog}`) : undefined;
}

const L = {
  semester: { en: 'Semester', tr: 'Dönem' },
  ects: { en: 'ECTS', tr: 'AKTS' },
  credit: { en: 'cr', tr: 'kredi' },
  any: { en: 'Choose {n} of', tr: 'Şunlardan {n} tanesi' },
  total: { en: 'semester total', tr: 'dönem toplamı' },
} as const satisfies Record<string, Record<Lang, string>>;

function nameOf(db: DatabaseSync, c: CurriculumCourse): string {
  if (c.name) return c.name;
  const row = db.prepare('SELECT name FROM courses WHERE code = ?').get(c.code) as { name: string } | undefined;
  return row?.name ?? '';
}

function formatItem(db: DatabaseSync, i: CurriculumItem, lang: Lang): string {
  if (i.kind === 'course') {
    const facts = [i.credit !== null ? `${i.credit} ${L.credit[lang]}` : '', i.ects !== null ? `${i.ects} ${L.ects[lang]}` : ''].filter(Boolean);
    return `• ${i.short_code} ${nameOf(db, i)}${facts.length ? ` · ${facts.join(' · ')}` : ''}`;
  }
  if (i.kind === 'elective') return `• ${i.label}${i.ects !== null ? ` · ${i.ects} ${L.ects[lang]}` : ''}`;
  return `• ${L.any[lang].replace('{n}', String(i.pick))}: ${i.options.map((o) => `${o.short_code}${nameOf(db, o) ? ` (${nameOf(db, o)})` : ''}`).join(' / ')}`;
}

export function registerCurriculumTools(server: McpServer, db: DatabaseSync): void {
  server.registerTool(
    'metu_program_curriculum',
    {
      title: 'METU programme curriculum',
      description:
        'The official semester-by-semester undergraduate curriculum of a METU department from the academic catalog: must ' +
        'courses with METU credit and ECTS, elective slots (technical, free, non-departmental elective …), "choose one of" ' +
        'groups and semester ECTS totals. Answers "which courses do I take in the 3rd semester?" or "how many technical ' +
        'electives does CENG have?". Department by code ("CENG", "EE", "BÖTE", "Matematik") or programme name. With ' +
        '`program` = "double_major" or "minor" it returns the department\'s double major / minor programmes instead: ' +
        'required courses, "choose one of" groups, elective counts and minimum credits ("CENG yandal şartları").',
      inputSchema: z.object({
        department: z.string().min(2).max(100).describe('Department code or programme name, Turkish or English'),
        semester: z.number().int().min(1).max(10).optional().describe('Only this semester (1 = first-year fall)'),
        program: z
          .enum(['undergraduate', 'double_major', 'minor'])
          .default('undergraduate')
          .describe('Which programme of the department: its own curriculum, or the double major / minor it offers'),
        lang: LangSchema,
      }),
      outputSchema: z.object({
        department: z.string(),
        url: z.string(),
        semesters: z.array(
          z.object({
            number: z.number(),
            label: z.string(),
            ects_total: z.number().nullable(),
            items: z.array(z.record(z.string(), z.unknown())),
          }),
        ),
        programs: z
          .array(z.object({ title: z.string(), description: z.string(), items: z.array(z.record(z.string(), z.unknown())), notes: z.string() }))
          .describe('Double major / minor programmes (only with program = double_major or minor)'),
        ...COMMON_OUTPUT,
      }),
      annotations: { ...READ_ONLY, title: 'METU programme curriculum' },
    },
    async ({ department, semester, program, lang }) => {
      const links = seeAlso(db, { query: 'müfredat curriculum katalog', category: 'courses', limit: 2 }, lang);
      const rec = findCurriculum(db, department);
      if (!rec?.data) {
        const hasAny = db.prepare(`SELECT 1 FROM records WHERE kind = 'curriculum' LIMIT 1`).get() !== undefined;
        return toolError(
          hasAny
            ? `${t(lang, 'no_results')} ${lang === 'tr' ? 'Bölüm kodunu (ör. "CENG") ya da program adını dene.' : 'Try the department code (e.g. "CENG") or the programme name.'}`
            : lang === 'tr'
              ? `Müfredatlar henüz toplanmadı: ${CATALOG_BASE_URL}`
              : `Curricula have not been collected yet: ${CATALOG_BASE_URL}`,
          lang,
          links,
        );
      }
      const data = JSON.parse(rec.data) as { prog: number; department: string; semesters: CurriculumSemester[] };
      if (program !== 'undergraduate') {
        const kind = program === 'minor' ? 'minor' : 'double-major';
        const special = getRecord(db, `curriculum-${kind}:${data.prog}`);
        const label = program === 'minor' ? { tr: 'yandal', en: 'minor' } : { tr: 'çift anadal', en: 'double major' };
        if (!special?.data) {
          return answer({
            lang,
            text:
              lang === 'tr'
                ? `${data.department} için katalogda ${label.tr} programı bulunamadı (ya da henüz toplanmadı). Bölüm sayfası: ${rec.url}`
                : `No ${label.en} programme of ${data.department} in the catalog (or not collected yet). Department page: ${rec.url}`,
            data: { department: data.department, url: rec.url, semesters: [], programs: [] },
            freshness: [recordFreshness(db, rec, 'curriculum', lang)],
            see_also: seeAlso(db, { query: 'çift anadal yandal double major minor', limit: 3 }, lang),
          });
        }
        const programs = (JSON.parse(special.data) as { programs: SpecialProgram[] }).programs;
        const text = [
          `${data.department} — ${special.url}`,
          ...programs.map((p) =>
            [p.title, p.description, p.items.map((i) => formatItem(db, i, lang)).join('\n'), p.notes].filter(Boolean).join('\n'),
          ),
          lang === 'tr'
            ? `Başvuru koşulları ve takvim için: metu_campus_services (topic: regulations, query: "${label.tr}") ve ÖİDB formları (topic: registrar).`
            : `Eligibility and dates: metu_campus_services (topic: regulations, query: "${label.en}") and the Registrar forms (topic: registrar).`,
          lang === 'tr' ? t(lang, 'fallback_lang') : '',
        ]
          .filter(Boolean)
          .join('\n\n');
        return answer({
          lang,
          text,
          data: {
            department: data.department,
            url: special.url,
            semesters: [],
            programs: programs.map((p) => ({ ...p, items: p.items as unknown as Record<string, unknown>[] })),
          },
          freshness: [recordFreshness(db, special, 'curriculum', lang)],
          see_also: links,
        });
      }
      const semesters = semester ? data.semesters.filter((s) => s.number === semester) : data.semesters;
      const text = [
        `${data.department} — ${rec.url}`,
        ...semesters.map(
          (s) =>
            `${s.number}. ${L.semester[lang]} (${s.label})${s.ects_total !== null ? ` — ${L.total[lang]} ${s.ects_total} ${L.ects[lang]}` : ''}\n` +
            s.items.map((i) => formatItem(db, i, lang)).join('\n'),
        ),
        lang === 'tr' ? t(lang, 'fallback_lang') : '',
      ]
        .filter(Boolean)
        .join('\n\n');
      return answer({
        lang,
        text,
        data: {
          department: data.department,
          url: rec.url,
          semesters: semesters.map((s) => ({ ...s, items: s.items as unknown as Record<string, unknown>[] })),
          programs: [],
        },
        freshness: [rec ? recordFreshness(db, rec, 'curriculum', lang) : computeFreshness(db, { kind: 'curriculum', collector: 'curriculum', source_url: CATALOG_BASE_URL }, lang)],
        see_also: links,
      });
    },
  );
}
