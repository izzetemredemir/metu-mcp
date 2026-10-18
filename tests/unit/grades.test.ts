import { describe, expect, it } from 'vitest';
import { extractPage } from '../../src/collectors/extract.js';
import { computeGpa, parseGradeRules } from '../../src/lib/grades.js';
import { fixture } from '../helpers.js';

const text = extractPage(fixture('oidb-lisans-yonetmeligi.html'), 80_000, 'https://oidb.metu.edu.tr/tr/x').text;
const rules = parseGradeRules(text)!;

describe('grading rules from the undergraduate regulation', () => {
  it('parses the scale, statuses, honors and probation line', () => {
    expect(rules.coefficients).toEqual({ AA: 4, BA: 3.5, BB: 3, CB: 2.5, CC: 2, DC: 1.5, DD: 1, FD: 0.5, FF: 0, NA: 0 });
    expect(rules.statuses).toEqual(['S', 'U', 'EX', 'I', 'W']);
    expect(rules.highHonor).toEqual({ min: 3.5, max: 4 });
    expect(rules.honor).toEqual({ min: 3, max: 3.49 });
    expect(rules.honorMinCourses).toBe(3);
    expect(rules.probationBelow).toBe(2);
    expect(rules.lastGradeCounts).toBe(true);
  });

  it('returns null for text without a grade table', () => {
    expect(parseGradeRules('nothing here')).toBeNull();
  });
});

describe('GPA', () => {
  it('computes term averages, honors and the cumulative average with the last grade of a repeat', () => {
    const r = computeGpa(rules, [
      { course: 'MATH119', credit: 5, grade: 'FF', term: '2025 Fall' },
      { course: 'PHYS105', credit: 4, grade: 'BB', term: '2025 Fall' },
      { course: 'CENG111', credit: 4, grade: 'AA', term: '2025 Fall' },
      { course: 'ENG101', credit: 4, grade: 'S', term: '2025 Fall' },
      { course: 'math 119', credit: 5, grade: 'ba', term: '2026 Spring' },
      { course: 'CENG140', credit: 4, grade: 'AA', term: '2026 Spring' },
      { course: 'PHYS106', credit: 4, grade: 'BA', term: '2026 Spring' },
    ]);
    expect(r.terms).toEqual([
      { term: '2025 Fall', gpa: 2.15, credits: 13, credited_courses: 3, standing: null },
      { term: '2026 Spring', gpa: 3.65, credits: 13, credited_courses: 3, standing: 'high_honor' },
    ]);
    // FF in MATH119 is replaced by BA: (5*3.5 + 4*3 + 4*4 + 4*4 + 4*3.5) / 21
    expect(r.cgpa).toBe(3.6);
    expect(r.credits).toBe(21);
    expect(r.excluded).toEqual([
      { course: 'ENG101', grade: 'S', reason: 'status' },
      { course: 'MATH119', grade: 'FF', reason: 'repeated' },
    ]);
    expect(r.below_probation_line).toBe(false);
  });

  it('needs three credited courses for honor and flags the probation line', () => {
    const r = computeGpa(rules, [
      { course: 'A1', credit: 3, grade: 'AA', term: 't1' },
      { course: 'A2', credit: 3, grade: 'BA', term: 't1' },
      { course: 'B1', credit: 3, grade: 'DD', term: 't2' },
      { course: 'B2', credit: 3, grade: 'FF', term: 't2' },
      { course: 'B3', credit: 3, grade: 'FD', term: 't2' },
      { course: 'B4', credit: 3, grade: 'DD', term: 't2', not_included: true },
    ]);
    expect(r.terms[0]).toMatchObject({ gpa: 3.75, standing: null });
    expect(r.cgpa).toBe(1.8);
    expect(r.below_probation_line).toBe(true);
    expect(() => computeGpa(rules, [{ credit: 3, grade: 'A+' }])).toThrow(/Unknown grade/);
  });
});
