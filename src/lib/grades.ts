import { foldTr } from './text.js';

/**
 * Grading rules parsed from the stored text of METU's undergraduate regulation (Lisans Eğitim-Öğretim Yönetmeliği), so
 * the GPA calculator never relies on hand-copied numbers: if METU changes the scale, the next page collection changes it.
 */
export interface GradeRules {
  /** Letter grade → coefficient (AA 4.00 … FF 0.00, NA 0.00). */
  coefficients: Record<string, number>;
  /** Status grades that never enter averages (S, U, EX, I, W). */
  statuses: string[];
  /** Term average ranges for honor / high honor, and the minimum number of credited courses for them. */
  honor: { min: number; max: number } | null;
  highHonor: { min: number; max: number } | null;
  honorMinCourses: number | null;
  /** Probation: cumulative average below this for two consecutive terms. */
  probationBelow: number | null;
  /** "In a repeated course the last grade counts." */
  lastGradeCounts: boolean;
}

const num = (s: string) => Number(s.replace(',', '.'));
const WORD_NUMBERS: Record<string, number> = { bir: 1, iki: 2, uc: 3, dort: 4, bes: 5 };

export function parseGradeRules(text: string): GradeRules | null {
  const coefficients: Record<string, number> = {};
  for (const m of text.matchAll(/\b(AA|BA|BB|CB|CC|DC|DD|FD|FF|NA)\s+(\d[.,]\d{2})\b/g)) {
    coefficients[m[1]!] ??= num(m[2]!);
  }
  if (Object.keys(coefficients).length < 10) return null;

  const statuses = [
    ...new Set([...text.matchAll(/\b(S|U|EX|I|W)\s+(Successful|Unsuccessful|Exempt|Incomplete|Withdrawn)\b/g)].map((m) => m[1]!)),
  ];
  const range = (re: RegExp) => {
    const m = re.exec(text);
    return m ? { min: num(m[1]!), max: num(m[2]!) } : null;
  };
  const folded = foldTr(text);
  const minCourses = /en az (\w+) adet kredili ders/.exec(folded)?.[1];
  const probation = /iki yariyil ust uste (\d[.,]\d{2})\S* altinda olan ogrenciler sinamali/.exec(folded)?.[1];
  return {
    coefficients,
    statuses,
    highHonor: range(/(\d[.,]\d{2})\s*-\s*(\d[.,]\d{2}) arasında olanlar yüksek şeref/),
    honor: range(/(\d[.,]\d{2})\s*-\s*(\d[.,]\d{2}) arasında olanlar şeref/),
    honorMinCourses: minCourses ? (WORD_NUMBERS[minCourses] ?? (Number(minCourses) || null)) : null,
    probationBelow: probation ? num(probation) : null,
    lastGradeCounts: /tekrarlanan derste onceki not dikkate alinmaz ve alinan son not gecerlidir/.test(folded),
  };
}

export interface GradeEntry {
  /** Course code ("CENG213"); entries with the same code are repeats of one course. */
  course?: string;
  credit: number;
  grade: string;
  /** Term label; terms are ordered as they first appear. */
  term?: string;
  /** Taken as "not included" (NI): never counts towards averages. */
  not_included?: boolean;
}

export interface TermResult {
  term: string;
  gpa: number | null;
  credits: number;
  credited_courses: number;
  standing: 'high_honor' | 'honor' | null;
}

export interface GpaResult {
  terms: TermResult[];
  cgpa: number | null;
  credits: number;
  /** Entries left out of averages, with the reason. */
  excluded: { course: string; grade: string; reason: 'status' | 'not_included' | 'zero_credit' | 'repeated' }[];
  below_probation_line: boolean;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function average(entries: GradeEntry[], rules: GradeRules): { gpa: number | null; credits: number } {
  let points = 0;
  let credits = 0;
  for (const e of entries) {
    points += e.credit * rules.coefficients[e.grade]!;
    credits += e.credit;
  }
  return { gpa: credits > 0 ? round2(points / credits) : null, credits };
}

/** Term averages and the cumulative average under METU's rules (last grade of a repeated course counts). */
export function computeGpa(rules: GradeRules, input: GradeEntry[]): GpaResult {
  const excluded: GpaResult['excluded'] = [];
  const counted: (GradeEntry & { index: number })[] = [];
  input.forEach((raw, index) => {
    const e = { ...raw, grade: raw.grade.trim().toUpperCase(), course: raw.course?.toUpperCase().replace(/\s+/g, '') };
    const label = e.course ?? `#${index + 1}`;
    if (e.not_included) excluded.push({ course: label, grade: e.grade, reason: 'not_included' });
    else if (rules.statuses.includes(e.grade)) excluded.push({ course: label, grade: e.grade, reason: 'status' });
    else if (!(e.grade in rules.coefficients)) throw new Error(`Unknown grade "${raw.grade}" (use ${Object.keys(rules.coefficients).join(', ')} or ${rules.statuses.join(', ')})`);
    else if (!(e.credit > 0)) excluded.push({ course: label, grade: e.grade, reason: 'zero_credit' });
    else counted.push({ ...e, index });
  });

  const termOrder = [...new Set(input.map((e) => e.term ?? ''))];
  const terms: TermResult[] = termOrder
    .filter((t) => t !== '')
    .map((term) => {
      const inTerm = counted.filter((e) => (e.term ?? '') === term);
      const { gpa, credits } = average(inTerm, rules);
      let standing: TermResult['standing'] = null;
      const enoughCourses = rules.honorMinCourses === null || inTerm.length >= rules.honorMinCourses;
      if (gpa !== null && enoughCourses) {
        if (rules.highHonor && gpa >= rules.highHonor.min) standing = 'high_honor';
        else if (rules.honor && gpa >= rules.honor.min && gpa <= rules.honor.max) standing = 'honor';
      }
      return { term, gpa, credits, credited_courses: inTerm.length, standing };
    });

  // Cumulative: one result per course — the last attempt (by term order, then input order) when the rule applies.
  const rank = (e: { term?: string; index: number }) => termOrder.indexOf(e.term ?? '') * 10_000 + e.index;
  const latest = new Map<string, (typeof counted)[number]>();
  for (const e of [...counted].sort((a, b) => rank(a) - rank(b))) {
    const key = e.course ?? `#${e.index}`;
    const prev = latest.get(key);
    if (prev && rules.lastGradeCounts) excluded.push({ course: key, grade: prev.grade, reason: 'repeated' });
    if (!prev || rules.lastGradeCounts) latest.set(key, e);
  }
  const { gpa: cgpa, credits } = average([...latest.values()], rules);
  return {
    terms,
    cgpa,
    credits,
    excluded,
    below_probation_line: cgpa !== null && rules.probationBelow !== null && cgpa < rules.probationBelow,
  };
}
