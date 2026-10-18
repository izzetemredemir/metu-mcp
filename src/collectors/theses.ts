import { XMLParser } from 'fast-xml-parser';
import { OAI_PAGES_PER_RUN, OPENMETU_HANDLE_URL, OPENMETU_OAI_URL, THESIS_SETS } from '../config.js';
import { cleanText } from '../lib/sanitize.js';
import { foldTr } from '../lib/text.js';
import { now } from '../lib/time.js';
import { transaction } from '../store/db.js';
import { politeFetch } from './http.js';
import { runUnit, type CollectorContext } from './runner.js';

export type ThesisDegree = 'master' | 'phd' | 'thesis';

export interface Thesis {
  id: number;
  title: string;
  title_alt: string | null;
  author: string;
  advisors: string;
  department: string;
  year: number | null;
  degree: ThesisDegree;
  language: string | null;
  abstract: string;
  subjects: string;
  pdf_url: string | null;
  url: string;
  datestamp: string;
}

export interface OaiPage {
  theses: Thesis[];
  /** Handle ids of records the repository reports as deleted (or that are no longer theses). */
  removed: number[];
  token: string | null;
  responseDate: string | null;
  /** OAI error code, e.g. `noRecordsMatch` (an empty incremental pass) or `badResumptionToken`. */
  error: string | null;
}

const DEGREES: Record<string, ThesisDegree> = { 'master thesis': 'master', 'ph.d. thesis': 'phd', thesis: 'thesis' };
/** A contributor naming the unit, not a person ("Department of …", "Graduate School of …", "… Bölümü"). */
const UNIT = /\b(department|program(me)?|graduate school|institute|school of|faculty)\b|bölüm|anabilim|enstitü/i;
/** Degree lines DSpace stores as descriptions ("M.S. - Master of Science", "Ph.D. - Doctor of Philosophy"). */
const DEGREE_LINE = /^(m\.?s\.?|m\.?a\.?|m\.?arch|m\.?b\.?a|m\.?c\.?p|m\.?ed|ph\.?d\.?|d\.?arch)\b.{0,60}$/i;
const ABSTRACT_MAX = 4000;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  processEntities: true,
  htmlEntities: true,
  parseTagValue: false,
  isArray: (name) => name === 'record' || name === 'setSpec' || name.startsWith('dc:'),
});

const str = (v: unknown): string => (typeof v === 'string' ? v : v && typeof v === 'object' && '#text' in v ? String(v['#text']) : '');
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(str).map((s) => s.trim()).filter(Boolean) : []);

/** Parses one OAI-PMH `ListRecords` response (oai_dc) from OpenMETU into theses; other item types are dropped. */
export function parseOaiPage(xml: string): OaiPage {
  const root = (parser.parse(xml) as Record<string, any>)['OAI-PMH'] ?? {};
  const error = root.error ? (root.error['@code'] as string) ?? 'error' : null;
  const lr = root.ListRecords ?? {};
  const theses: Thesis[] = [];
  const removed: number[] = [];
  for (const rec of (lr.record ?? []) as Record<string, any>[]) {
    const header = rec.header ?? {};
    const id = Number(/11511\/(\d+)$/.exec(str(header.identifier))?.[1]);
    if (!Number.isInteger(id)) continue;
    const dc = rec.metadata?.['oai_dc:dc'];
    if (header['@status'] === 'deleted' || !dc) {
      removed.push(id);
      continue;
    }
    const degree = list(dc['dc:type']).map((t) => DEGREES[t.toLowerCase()]).find(Boolean);
    if (!degree) {
      removed.push(id);
      continue;
    }
    const titles = list(dc['dc:title']).map((t) => cleanText(t.replace(/\s*[/:.]$/, ''), 500));
    const contributors = list(dc['dc:contributor']);
    const descriptions = list(dc['dc:description']);
    const identifiers = list(dc['dc:identifier']);
    const year = list(dc['dc:date'])
      // The issue date ("2006", "2023-9-11"); the timestamps with a time part are repository accession dates.
      .map((d) => /^(\d{4})(-\d{1,2}(-\d{1,2})?)?$/.exec(d)?.[1])
      .find(Boolean);
    theses.push({
      id,
      title: titles[0] ?? '',
      title_alt: titles[1] ?? null,
      author: list(dc['dc:creator']).join('; '),
      advisors: contributors.filter((c) => !UNIT.test(c)).join('; '),
      department: contributors.find((c) => UNIT.test(c)) ?? '',
      year: year ? Number(year) : null,
      degree,
      language: list(dc['dc:language'])[0] ?? null,
      abstract: cleanText(descriptions.filter((d) => !DEGREE_LINE.test(d)).join('\n\n'), ABSTRACT_MAX),
      subjects: list(dc['dc:subject']).map((s) => s.replace(/\.$/, '')).join('; '),
      pdf_url: identifiers.find((u) => /^https?:\/\/[^/]+\.metu\.edu\.tr\/.*\.pdf$/i.test(u)) ?? null,
      url: `${OPENMETU_HANDLE_URL}${id}`,
      datestamp: str(header.datestamp),
    });
  }
  const tokenNode = lr.resumptionToken;
  const token = str(tokenNode).trim() || null;
  return { theses: theses.filter((t) => t.title), removed, token, responseDate: str(root.responseDate) || null, error };
}

function save(ctx: CollectorContext, page: OaiPage): void {
  const ts = now().toISOString();
  transaction(ctx.db, () => {
    const del = ctx.db.prepare('DELETE FROM theses WHERE id = ?');
    for (const id of page.removed) del.run(id);
    const ins = ctx.db.prepare(
      `INSERT INTO theses (id, title, title_alt, author, advisors, department, year, degree, language, abstract, subjects,
         pdf_url, url, datestamp, search_text, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET title = excluded.title, title_alt = excluded.title_alt, author = excluded.author,
         advisors = excluded.advisors, department = excluded.department, year = excluded.year, degree = excluded.degree,
         language = excluded.language, abstract = excluded.abstract, subjects = excluded.subjects,
         pdf_url = excluded.pdf_url, url = excluded.url, datestamp = excluded.datestamp,
         search_text = excluded.search_text, fetched_at = excluded.fetched_at`,
    );
    for (const t of page.theses) {
      const search = foldTr([t.title_alt, t.author, t.advisors, t.department, t.subjects, t.abstract].filter(Boolean).join(' '));
      ins.run(t.id, t.title, t.title_alt, t.author, t.advisors, t.department, t.year, t.degree, t.language, t.abstract,
        t.subjects, t.pdf_url, t.url, t.datestamp, search, ts);
    }
  });
}

interface OaiState {
  set_spec: string;
  from_date: string | null;
  token: string | null;
  pass_started: string | null;
}

/**
 * Nightly: harvests the thesis sets page by page. A pass that runs out of the per-run page budget keeps its resumption
 * token and continues the next night; a finished pass records its start time, so later passes are incremental.
 */
export async function collectTheses(ctx: CollectorContext): Promise<void> {
  await runUnit(ctx, 'theses', async () => {
    let budget = OAI_PAGES_PER_RUN;
    let stored = 0;
    const getState = ctx.db.prepare('SELECT set_spec, from_date, token, pass_started FROM oai_state WHERE set_spec = ?');
    const putState = ctx.db.prepare(
      `INSERT INTO oai_state (set_spec, from_date, token, pass_started) VALUES (?, ?, ?, ?)
       ON CONFLICT(set_spec) DO UPDATE SET from_date = excluded.from_date, token = excluded.token,
         pass_started = excluded.pass_started`,
    );
    for (const { set } of THESIS_SETS) {
      const state: OaiState = (getState.get(set) as OaiState | undefined) ?? { set_spec: set, from_date: null, token: null, pass_started: null };
      while (budget > 0) {
        budget--;
        const url = state.token
          ? `${OPENMETU_OAI_URL}?verb=ListRecords&resumptionToken=${encodeURIComponent(state.token)}`
          : `${OPENMETU_OAI_URL}?verb=ListRecords&metadataPrefix=oai_dc&set=${set}${state.from_date ? `&from=${state.from_date}` : ''}`;
        const page = parseOaiPage((await politeFetch(ctx.db, url, { conditional: false, timeoutMs: 120_000 })).body);
        if (page.error === 'badResumptionToken') {
          // Expired token: restart this pass from its previous starting point.
          ctx.log(`[theses] ${set}: resumption token expired, restarting the pass`);
          Object.assign(state, { token: null, pass_started: null });
          continue;
        }
        if (page.error && page.error !== 'noRecordsMatch') throw new Error(`OAI error "${page.error}" for ${url}`);
        if (!state.token) state.pass_started = page.responseDate;
        save(ctx, page);
        stored += page.theses.length;
        state.token = page.token;
        if (!state.token) {
          // Pass complete: the next one asks only for records changed since this pass started.
          Object.assign(state, { from_date: state.pass_started ?? state.from_date, pass_started: null });
          putState.run(set, state.from_date, null, null);
          break;
        }
        putState.run(set, state.from_date, state.token, state.pass_started);
      }
      if (budget === 0) break;
    }
    return stored;
  });
}

/** Sets whose first full harvest has not finished yet (answers mention that the index is still growing). */
export function pendingThesisSets(db: CollectorContext['db']): number {
  const done = db.prepare('SELECT COUNT(*) AS n FROM oai_state WHERE from_date IS NOT NULL').get() as { n: number };
  return THESIS_SETS.length - done.n;
}
