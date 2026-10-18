import * as cheerio from 'cheerio';
import { DOCTORS_URL } from '../config.js';
import { cleanText } from '../lib/sanitize.js';
import { upsertRecord } from '../store/records.js';
import { politeFetch } from './http.js';
import { runUnit, type CollectorContext } from './runner.js';

export const DOCTORS_RECORD_ID = 'duty:srm-doctors';

export type DutyStatus = 'on_duty' | 'off_duty' | 'other' | 'unknown';

export interface DoctorDuty {
  specialty: string;
  name: string;
  /** Normalized from the page's status cell ("BURADA (ON DUTY)", "İZİNLİ (OFF DUTY)", "-", free text). */
  status: DutyStatus;
  /** The status cell as published, when it is free text. */
  status_text: string;
  /** Standing note such as "HER PAZARTESİ-ÇARŞAMBA SABAH BURADA" (regular schedule). */
  note: string;
}

export function normalizeDutyStatus(raw: string): DutyStatus {
  const s = raw.toLocaleUpperCase('tr-TR');
  if (!s || s === '-') return 'unknown';
  if (s.includes('BURADA') || s.includes('ON DUTY')) return 'on_duty';
  if (s.includes('İZİNLİ') || s.includes('OFF DUTY') || s.includes('RAPORLU') || s.includes('YOK')) return 'off_duty';
  return 'other';
}

/**
 * srm.metu.edu.tr/tr/doktorlarimiz: `.item-list` blocks with an `<h3>` specialty and one `<li>` per doctor holding
 * `.views-field-title` (name), `.views-field-field-doktor-durum-notu` (standing note) and
 * `.views-field-field-doktor-durumu` (today's status). The "dd/mm/yyyy dated list" stamp on the page is written by
 * client-side JavaScript from the visitor's clock, so it is ignored; our fetch time is the only real timestamp.
 */
export function parseDoctors(html: string): DoctorDuty[] {
  const $ = cheerio.load(html);
  const out: DoctorDuty[] = [];
  $('.item-list').each((_, block) => {
    const specialty = cleanText($(block).find('h3').first().text(), 120);
    if (!specialty) return;
    $(block)
      .find('li')
      .each((_, li) => {
        const name = cleanText($(li).find('.views-field-title').text(), 120);
        if (!name) return;
        const statusText = cleanText($(li).find('.views-field-field-doktor-durumu').text(), 200);
        const status = normalizeDutyStatus(statusText);
        out.push({
          specialty,
          name,
          status,
          status_text: status === 'other' ? statusText : '',
          note: cleanText($(li).find('.views-field-field-doktor-durum-notu').text(), 300),
        });
      });
  });
  return out;
}

/** Hourly on weekdays: who is on duty at the health center (Medico). */
export async function collectDoctors(ctx: CollectorContext): Promise<void> {
  await runUnit(ctx, 'doctors', async () => {
    const res = await politeFetch(ctx.db, DOCTORS_URL, { conditional: false });
    const doctors = parseDoctors(res.body);
    if (doctors.length < 5) throw new Error(`only ${doctors.length} doctors parsed (layout change?)`);
    upsertRecord(ctx.db, {
      id: DOCTORS_RECORD_ID,
      kind: 'duty',
      source: 'health-doctors',
      lang: 'tr',
      title: 'SRM doctors on duty',
      body: doctors.map((d) => `${d.specialty}: ${d.name} — ${d.status}${d.note ? ` (${d.note})` : ''}`).join('\n'),
      url: DOCTORS_URL,
      data: { doctors },
    }, undefined, { noHistory: true });
    return doctors.length;
  });
}
