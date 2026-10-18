import type { DatabaseSync } from 'node:sqlite';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { FAQ_BASE_URL } from '../config.js';
import { t } from '../i18n.js';
import { foldTr } from '../lib/text.js';
import { computeFreshness } from '../store/freshness.js';
import { searchRecords, type StoredRecord } from '../store/records.js';
import { answer, COMMON_OUTPUT, LangSchema, READ_ONLY, recordFreshness, seeAlso, toolError } from './common.js';

const ANSWER_CHARS = 1500;

/** English IT words → the Turkish terms the FAQ is written in (the FAQ is Turkish only). */
const EN_TO_TR: Record<string, string> = {
  password: 'şifre', forgot: 'unuttum', email: 'e-posta', mail: 'e-posta', wifi: 'kablosuz', wireless: 'kablosuz',
  connect: 'bağlan', software: 'yazılım', license: 'lisans', licensed: 'lisanslı', card: 'kart', account: 'hesap',
  quota: 'kota', printer: 'yazıcı', lab: 'salon', install: 'kurulum', phone: 'telefon', student: 'öğrenci',
};

/** Question words that match almost every FAQ entry ("nasıl", "how") and only add noise to the any-word fallback. */
const STOPWORDS = new Set([
  'nasil', 'nedir', 'ne', 'neden', 'icin', 'ile', 'bir', 've', 'veya', 'mi', 'mu', 'yapilir', 'yapmaliyim', 'olur', 'var',
  'how', 'what', 'why', 'to', 'the', 'do', 'does', 'can', 'is', 'a', 'an', 'of', 'in', 'on', 'for', 'with', 'my', 'get',
]);

/** Folded, translated, stopword-free query words. */
export function faqWords(query: string): string[] {
  return foldTr(query)
    .split(/[^\p{L}\p{N}]+/u)
    .map((w) => foldTr(EN_TO_TR[w] ?? w))
    .flatMap((w) => w.split(/[^\p{L}\p{N}]+/u))
    .filter((w) => w.length >= 2 && !STOPWORDS.has(w));
}

/** Crude stem so Turkish suffixes still match ("kurulur" ~ "kurulum", "bağlanamıyorum" ~ "bağlanabilirim"). */
const stem = (w: string) => (w.length >= 6 ? w.slice(0, Math.max(5, w.length - 3)) : w);
const contains = (text: string, w: string) => foldTr(text).includes(stem(w));
/** Every word of a one- or two-word query, else at least half of the words, must appear. */
const needed = (words: string[]) => (words.length <= 2 ? words.length : Math.ceil(words.length / 2));

/** FTS over FAQ answers: all words first, then any word, so "eduroam bağlanamıyorum" still finds eduroam pages. */
export function searchFaq(db: DatabaseSync, query: string, limit: number): StoredRecord[] {
  const words = faqWords(query);
  if (words.length === 0) return [];
  const all = searchRecords(db, words.join(' '), ['faq'], limit);
  if (all.length >= limit) return all;
  const seen = new Set(all.map((r) => r.id));
  const any: StoredRecord[] = [];
  for (const w of words.filter((x) => x.length >= 3)) {
    for (const r of searchRecords(db, w, ['faq'], limit)) {
      if (!seen.has(r.id)) {
        seen.add(r.id);
        any.push(r);
      }
    }
  }
  // Pages matching more of the words rank first; a page matching a single word of a multi-word query is dropped.
  const score = (r: StoredRecord) => words.filter((w) => contains(`${r.title} ${r.body}`, w)).length;
  return all.concat(any.filter((r) => score(r) >= needed(words)).sort((a, b) => score(b) - score(a))).slice(0, limit);
}

/** Listed questions whose answer page has not been fetched yet (nightly batches), matched on the question text. */
export function pendingFaqQuestions(db: DatabaseSync, query: string, exclude: Set<string>, limit: number): { url: string; question: string; grp: string }[] {
  const words = faqWords(query);
  if (words.length === 0) return [];
  const rows = db.prepare('SELECT url, question, grp FROM faq_queue').all() as { url: string; question: string; grp: string }[];
  const score = (r: { question: string; grp: string }) => words.filter((w) => contains(`${r.question} ${r.grp}`, w)).length;
  return rows
    .filter((r) => !exclude.has(r.url) && db.prepare('SELECT 1 FROM records WHERE id = ?').get(`faq:${r.url}`) === undefined)
    .map((r) => ({ r, s: score(r) }))
    .filter(({ s }) => s >= needed(words))
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map(({ r }) => r);
}

const FaqOut = z.object({
  question: z.string(),
  answer: z.string(),
  groups: z.array(z.string()),
  url: z.string(),
  updated_at: z.string().nullable().describe('The FAQ page\'s own "last updated" date'),
  answer_collected: z.boolean().describe('false: the question is listed but its answer has not been fetched yet — open the link'),
});

export function registerItHelpTools(server: McpServer, db: DatabaseSync): void {
  server.registerTool(
    'metu_it_help',
    {
      title: 'METU IT help (BİDB FAQ)',
      description:
        'Searches the METU Computer Center (BİDB) FAQ: Wi-Fi (eduroam / meturoam) setup per device, VPN, METU e-mail ' +
        'and passwords, user accounts and quotas, licensed software (MATLAB, Microsoft 365, ANSYS …), the smart card, ' +
        'computer labs and their hours, dormitory networks, METU-SIS. Returns the official answers. The FAQ is in Turkish; ' +
        'English questions are matched with common IT words.',
      inputSchema: z.object({
        query: z.string().min(2).max(200).describe('The problem in the student\'s words, e.g. "eduroam şifremi unuttum", "MATLAB kurulumu"'),
        limit: z.number().int().min(1).max(8).default(4),
        lang: LangSchema,
      }),
      outputSchema: z.object({ answers: z.array(FaqOut), ...COMMON_OUTPUT }),
      annotations: { ...READ_ONLY, title: 'METU IT help' },
    },
    async ({ query, limit, lang }) => {
      const records = searchFaq(db, query, limit);
      const pending = pendingFaqQuestions(db, query, new Set(records.map((r) => r.url)), limit);
      const links = seeAlso(db, { query: `${query} bidb`, category: 'it', limit: 2 }, lang);
      if (records.length === 0 && pending.length === 0) {
        const hasData = (db.prepare(`SELECT 1 FROM records WHERE kind = 'faq' LIMIT 1`).get() as unknown) !== undefined;
        return toolError(
          hasData
            ? `${t(lang, 'no_results')} ${lang === 'tr' ? 'Başka kelimelerle dene ya da SSS sayfasına bak.' : 'Try other words or browse the FAQ.'} ${FAQ_BASE_URL}tr`
            : lang === 'tr'
              ? `BİDB SSS henüz toplanmadı: ${FAQ_BASE_URL}tr`
              : `The BİDB FAQ has not been collected yet: ${FAQ_BASE_URL}tr`,
          lang,
          links,
        );
      }
      // Rank collected answers and still-pending questions together by how many query words they contain; the question
      // title counts triple, so a pending question that names the exact problem beats a loosely related answer.
      const words = faqWords(query);
      const score = (title: string, rest: string) =>
        words.reduce((n, w) => n + (contains(title, w) ? 3 : contains(rest, w) ? 1 : 0), 0);
      const answers = [
        ...records.map((r) => ({
          question: r.title,
          answer: r.body.length > ANSWER_CHARS ? `${r.body.slice(0, ANSWER_CHARS - 1)}…` : r.body,
          groups: ((r.data ? JSON.parse(r.data) : {}) as { groups?: string[] }).groups ?? [],
          url: r.url,
          updated_at: r.source_updated_at,
          answer_collected: true,
          score: score(r.title, r.body),
        })),
        ...pending.map((p) => ({
          question: p.question, answer: '', groups: [p.grp], url: p.url, updated_at: null, answer_collected: false,
          score: score(p.question, p.grp),
        })),
      ]
        .sort((a, b) => b.score - a.score || Number(b.answer_collected) - Number(a.answer_collected))
        .slice(0, limit)
        .map(({ score: _score, ...a }) => a);
      const notYet = lang === 'tr' ? '(Cevap henüz toplanmadı; sayfayı aç.)' : '(Answer not collected yet; open the page.)';
      const text = [
        answers.map((a, i) => `${i + 1}. ${a.question}\n${a.url}\n${a.answer_collected ? a.answer : notYet}`).join('\n\n'),
        lang === 'en' ? t(lang, 'fallback_lang') : '',
      ]
        .filter(Boolean)
        .join('\n\n');
      return answer({
        lang,
        text,
        data: { answers },
        freshness: records.length
          ? [recordFreshness(db, records[0]!, 'faq-answers', lang)]
          : [computeFreshness(db, { kind: 'faq', collector: 'faq', source_url: `${FAQ_BASE_URL}tr` }, lang)],
        see_also: links,
      });
    },
  );
}
