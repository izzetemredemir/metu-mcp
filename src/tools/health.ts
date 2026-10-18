import type { DatabaseSync } from 'node:sqlite';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { DOCTORS_URL, type Lang } from '../config.js';
import { DOCTORS_RECORD_ID, type DoctorDuty, type DutyStatus } from '../collectors/doctors.js';
import { foldTr } from '../lib/text.js';
import { formatDateTime, istanbulClock } from '../lib/time.js';
import { computeFreshness } from '../store/freshness.js';
import { getRecord } from '../store/records.js';
import { answer, COMMON_OUTPUT, LangSchema, READ_ONLY, recordFreshness, seeAlso, toolError } from './common.js';

/** Everyday words → a term that appears in the page's bilingual specialty headings. */
const SPECIALTY_ALIASES: Record<string, string> = {
  eye: 'ophthalmology', goz: 'goz', dis: 'dis hekimi', dental: 'dentist', tooth: 'dentist', teeth: 'dentist',
  skin: 'dermatology', cilt: 'dermatoloji', gp: 'general practitioner', 'general practitioner': 'general practitioner',
  pratisyen: 'pratisyen', doctor: 'pratisyen', doktor: 'pratisyen', child: 'pediatrics', cocuk: 'cocuk',
  women: 'gynaecology', kadin: 'kadin', 'x-ray': 'radiology', xray: 'radiology', rontgen: 'radyoloji',
  psychiatry: 'psikiyatri', psikiyatri: 'psikiyatri', lung: 'gogus', gogus: 'gogus', internal: 'internal', dahiliye: 'ic hastaliklari',
  physiotherapy: 'fizik', fizik: 'fizik',
};

const STATUS_LABEL: Record<DutyStatus, Record<Lang, string>> = {
  on_duty: { en: 'on duty', tr: 'burada' },
  off_duty: { en: 'off duty', tr: 'izinli / yok' },
  other: { en: 'see note', tr: 'nota bak' },
  unknown: { en: 'no status today', tr: 'bugün durum girilmemiş' },
};

const DoctorOut = z.object({
  specialty: z.string(),
  name: z.string(),
  status: z.enum(['on_duty', 'off_duty', 'other', 'unknown']),
  status_text: z.string(),
  note: z.string().describe('Standing schedule note, e.g. "every Monday-Wednesday mornings"'),
});

export function filterDoctors(doctors: DoctorDuty[], specialty: string | undefined): DoctorDuty[] {
  if (!specialty) return doctors;
  const q = foldTr(specialty).trim();
  const term = SPECIALTY_ALIASES[q] ?? q;
  return doctors.filter((d) => foldTr(d.specialty).includes(term));
}

export function registerHealthTools(server: McpServer, db: DatabaseSync): void {
  server.registerTool(
    'metu_doctors_on_duty',
    {
      title: 'Doctors on duty at the METU health center',
      description:
        'Which doctors are at the METU Health and Counseling Center (SRM / "Medico") today, by specialty: general ' +
        'practitioner, dentist, eye, dermatology, gynaecology, pediatrics, radiology, psychiatry, internal medicine … with ' +
        'each doctor\'s status (on duty / off duty) and standing schedule notes. Collected hourly on weekdays; the center ' +
        'is closed on weekends and holidays (first aid 24/7). Appointments need a login (see links).',
      inputSchema: z.object({
        specialty: z.string().max(60).optional().describe('Filter, Turkish or English: "göz", "eye", "diş", "dentist", "pratisyen"'),
        only_on_duty: z.boolean().default(false).describe('Only doctors marked as on duty'),
        lang: LangSchema,
      }),
      outputSchema: z.object({ doctors: z.array(DoctorOut), ...COMMON_OUTPUT }),
      annotations: { ...READ_ONLY, title: 'Doctors on duty (Medico)' },
    },
    async ({ specialty, only_on_duty, lang }) => {
      const links = seeAlso(db, { query: 'mediko sağlık randevu health appointment', category: 'health', limit: 3 }, lang);
      const rec = getRecord(db, DOCTORS_RECORD_ID);
      if (!rec?.data) {
        return answer({
          lang,
          text: lang === 'tr' ? `Doktor listesi henüz toplanmadı: ${DOCTORS_URL}` : `The doctors list has not been collected yet: ${DOCTORS_URL}`,
          data: { doctors: [] },
          freshness: [computeFreshness(db, { kind: 'duty', collector: 'doctors', source_url: DOCTORS_URL }, lang)],
          see_also: links,
        });
      }
      const all = (JSON.parse(rec.data) as { doctors: DoctorDuty[] }).doctors;
      let doctors = filterDoctors(all, specialty);
      if (only_on_duty) doctors = doctors.filter((d) => d.status === 'on_duty');
      if (doctors.length === 0) {
        const specialties = [...new Set(all.map((d) => d.specialty))].join(', ');
        return toolError(
          lang === 'tr'
            ? `Eşleşen doktor yok. Branşlar: ${specialties}`
            : `No matching doctor. Specialties: ${specialties}`,
          lang,
          links,
        );
      }

      const lines: string[] = [];
      let lastSpecialty = '';
      for (const d of doctors) {
        if (d.specialty !== lastSpecialty) {
          lines.push(`${lines.length ? '\n' : ''}${d.specialty}`);
          lastSpecialty = d.specialty;
        }
        const status = d.status === 'other' ? d.status_text : STATUS_LABEL[d.status][lang];
        lines.push(`• ${d.name}: ${status}${d.note ? ` — ${d.note}` : ''}`);
      }
      const clock = istanbulClock();
      const notes = [
        lang === 'tr'
          ? `Durumlar ${formatDateTime(rec.fetched_at)} itibarıyla sağlık merkezinin sayfasından alındı. Çalışma saatleri 08:30–16:30, poliklinik 09:00–12:00 ve 13:30–16:00.`
          : `Statuses as published on the health center page at ${formatDateTime(rec.fetched_at)}. Hours 08:30–16:30, polyclinic 09:00–12:00 and 13:30–16:00.`,
      ];
      if (clock.weekday === 0 || clock.weekday === 6) {
        notes.push(
          lang === 'tr'
            ? 'Bugün hafta sonu: sağlık merkezi kapalı, yalnızca ilk yardım ünitesi 7/24 açık. Acil durumda 112.'
            : 'It is the weekend: the health center is closed; only the first-aid unit is open 24/7. Emergencies: 112.',
        );
      }
      return answer({
        lang,
        text: `${lines.join('\n')}\n\n${notes.join('\n')}`,
        data: { doctors },
        freshness: [recordFreshness(db, rec, 'doctors', lang)],
        see_also: links,
      });
    },
  );
}
