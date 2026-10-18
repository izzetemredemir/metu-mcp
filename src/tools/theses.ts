import type { DatabaseSync } from 'node:sqlite';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { pendingThesisSets } from '../collectors/theses.js';
import type { Lang } from '../config.js';
import { t } from '../i18n.js';
import { foldTr, toFtsQuery } from '../lib/text.js';
import { computeFreshness } from '../store/freshness.js';
import { answer, COMMON_OUTPUT, LangSchema, READ_ONLY, seeAlso } from './common.js';

const OPENMETU_URL = 'https://open.metu.edu.tr/';
const DEGREE = ['master', 'phd'] as const;
const DEGREE_LABEL: Record<string, Record<Lang, string>> = {
  master: { tr: 'Yüksek lisans', en: "Master's" },
  phd: { tr: 'Doktora', en: 'PhD' },
  thesis: { tr: 'Tez', en: 'Thesis' },
};

interface ThesisRow {
  id: number;
  title: string;
  title_alt: string | null;
  author: string;
  advisors: string;
  department: string;
  year: number | null;
  degree: string;
  language: string | null;
  abstract: string;
  subjects: string;
  pdf_url: string | null;
  url: string;
}

const ThesisOut = z.object({
  title: z.string(),
  title_alt: z.string().nullable().describe('Title in the other language (theses carry a Turkish and an English title)'),
  author: z.string(),
  advisors: z.string(),
  department: z.string(),
  year: z.number().int().nullable(),
  degree: z.string().describe('master, phd or thesis (older records without a degree)'),
  language: z.string().nullable(),
  subjects: z.string(),
  abstract: z.string().describe('Empty in concise mode'),
  url: z.string().describe('OpenMETU record page'),
  pdf_url: z.string().nullable().describe('Full text PDF, when the thesis is open access'),
});

/** Every word of `needle` (accent- and case-insensitive) occurs in `hay`. */
function containsWords(hay: string, needle: string): boolean {
  const h = foldTr(hay);
  return foldTr(needle)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .every((w) => h.includes(w));
}

export function registerThesisTools(server: McpServer, db: DatabaseSync): void {
  server.registerTool(
    'metu_theses',
    {
      title: 'METU theses (OpenMETU)',
      description:
        "Searches master's and PhD theses written at METU, harvested from OpenMETU (open.metu.edu.tr), the university's " +
        'open-access repository: title (Turkish and English), author, advisors, department, year, subjects, abstract and ' +
        'the full-text PDF link when open. `query` searches titles, abstracts, subjects and names (accent-insensitive, ' +
        'e.g. "deprem yalıtım", "reinforcement learning"). Filters: `department` (English name words, e.g. "Computer ' +
        'Engineering", "Architecture"), `advisor`, `author`, `degree`, year range. Without a query the newest theses ' +
        'come first. Useful to find former theses of an advisor, related work, or thesis examples in a department.',
      inputSchema: z.object({
        query: z.string().max(200).optional().describe('Words in title, abstract, subjects or names (Turkish or English)'),
        department: z.string().max(100).optional().describe('Department name words in English, e.g. "Civil Engineering"'),
        advisor: z.string().max(100).optional().describe('Advisor name (surname is enough)'),
        author: z.string().max(100).optional().describe('Author name (surname is enough)'),
        degree: z.enum(DEGREE).optional(),
        year_from: z.number().int().min(1950).max(2100).optional(),
        year_to: z.number().int().min(1950).max(2100).optional(),
        limit: z.number().int().min(1).max(20).default(8),
        response_format: z
          .enum(['concise', 'detailed'])
          .default('concise')
          .describe('"detailed" includes the abstract (up to ~1200 characters each)'),
        lang: LangSchema,
      }),
      outputSchema: z.object({
        theses: z.array(ThesisOut),
        total_matches: z.number().int(),
        index_complete: z.boolean().describe('false while the first harvest of OpenMETU is still running'),
        ...COMMON_OUTPUT,
      }),
      annotations: { ...READ_ONLY, title: 'METU theses (OpenMETU)' },
    },
    async ({ query, department, advisor, author, degree, year_from, year_to, limit, response_format, lang }) => {
      const fts = query ? toFtsQuery(query) : undefined;
      const where: string[] = [];
      const params: (string | number)[] = [];
      if (fts) {
        where.push('theses_fts MATCH ?');
        params.push(fts);
      }
      if (degree) {
        where.push('t.degree = ?');
        params.push(degree);
      }
      if (year_from) {
        where.push('t.year >= ?');
        params.push(year_from);
      }
      if (year_to) {
        where.push('t.year <= ?');
        params.push(year_to);
      }
      // Ids and the name fields only: the name filters run in JS (accent-insensitive), then one page is loaded in full.
      const candidates = db
        .prepare(
          `SELECT t.id, t.department, t.advisors, t.author FROM theses t
           ${fts ? 'JOIN theses_fts f ON f.rowid = t.id' : ''}
           ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
           ORDER BY ${fts ? 'bm25(theses_fts, 5.0, 1.0)' : 't.year IS NULL, t.year DESC, t.id DESC'}`,
        )
        .all(...params) as unknown as Pick<ThesisRow, 'id' | 'department' | 'advisors' | 'author'>[];
      const matches = candidates.filter(
        (c) =>
          (!department || containsWords(c.department, department)) &&
          (!advisor || containsWords(c.advisors, advisor)) &&
          (!author || containsWords(c.author, author)),
      );
      const get = db.prepare(
        `SELECT id, title, title_alt, author, advisors, department, year, degree, language, abstract, subjects, pdf_url, url
         FROM theses WHERE id = ?`,
      );
      const rows = matches.slice(0, limit).map((m) => get.get(m.id) as unknown as ThesisRow);

      const detailed = response_format === 'detailed';
      const theses = rows.map(({ id: _id, ...r }) => ({
        ...r,
        abstract: detailed ? (r.abstract.length > 1200 ? `${r.abstract.slice(0, 1199)}…` : r.abstract) : '',
      }));
      const pending = pendingThesisSets(db);
      const lines = rows.map((r) => {
        const facts = [DEGREE_LABEL[r.degree]?.[lang] ?? r.degree, r.year ?? '', r.department].filter(Boolean).join(' · ');
        const people = [r.author, r.advisors ? `${lang === 'tr' ? 'danışman' : 'advisor'}: ${r.advisors}` : '']
          .filter(Boolean)
          .join(' — ');
        const pdf = r.pdf_url ? `\n  PDF: ${r.pdf_url}` : '';
        const abs = detailed && r.abstract ? `\n  ${r.abstract.slice(0, 1200)}${r.abstract.length > 1200 ? '…' : ''}` : '';
        return `• ${r.title}\n  ${people}\n  ${facts}\n  ${r.url}${pdf}${abs}`;
      });
      const header =
        matches.length > rows.length
          ? lang === 'tr'
            ? `${matches.length} tezden ${rows.length} tanesi:`
            : `${rows.length} of ${matches.length} theses:`
          : '';
      const note = pending
        ? lang === 'tr'
          ? `⚠️ OpenMETU'nun ilk taraması sürüyor (${pending} enstitü eksik); sonuçlar henüz tam değil.`
          : `⚠️ The first harvest of OpenMETU is still running (${pending} graduate schools missing); results are incomplete.`
        : '';
      const text = [rows.length ? [header, ...lines].filter(Boolean).join('\n') : t(lang, 'no_results'), note]
        .filter(Boolean)
        .join('\n\n');
      return answer({
        lang,
        text,
        data: { theses, total_matches: matches.length, index_complete: pending === 0 },
        freshness: [computeFreshness(db, { kind: 'thesis', collector: 'theses', source_url: OPENMETU_URL }, lang)],
        see_also: rows.length ? undefined : seeAlso(db, { query: 'tez thesis kütüphane library', limit: 2 }, lang),
      });
    },
  );
}
