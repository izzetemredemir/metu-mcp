import type { DatabaseSync } from 'node:sqlite';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { Lang } from '../config.js';
import { diningUrl, type DayMenu } from '../collectors/dining.js';
import { t } from '../i18n.js';
import { foldTr } from '../lib/text.js';
import { now, todayIstanbul } from '../lib/time.js';
import { formatDate } from '../lib/trdate.js';
import { computeFreshness, type Freshness } from '../store/freshness.js';
import { getRecord } from '../store/records.js';
import { answer, COMMON_OUTPUT, IsoDate, LangSchema, READ_ONLY, recordFreshness, seeAlso, toolError } from './common.js';

const MealHours = z.object({ meal: z.enum(['breakfast', 'lunch', 'dinner']), weekend: z.boolean(), from: z.string(), to: z.string() });
type MealHoursT = z.infer<typeof MealHours>;

/** Parses "Kahvaltı: 08.00 - 10.00", "Hafta Sonu Öğle Yemeği: 12.00 - 14.00" … from the meal-hours page. */
export function parseMealHours(text: string): MealHoursT[] {
  const out: MealHoursT[] = [];
  const re = /(hafta sonu\s+)?(kahvalti|ogle yemegi|aksam yemegi)\s*:\s*(\d{1,2}[.:]\d{2})\s*-\s*(\d{1,2}[.:]\d{2})/g;
  for (const m of foldTr(text).matchAll(re)) {
    const meal = m[2]!.startsWith('kahvalti') ? 'breakfast' : m[2]!.startsWith('ogle') ? 'lunch' : 'dinner';
    out.push({ meal, weekend: Boolean(m[1]), from: m[3]!.replace('.', ':'), to: m[4]!.replace('.', ':') });
  }
  return out;
}

/** Extracts the student set-menu price ("Öğrenci 50,00") and student breakfast price from the prices page. */
export function parseStudentPrices(text: string): { student_meal_try: number | null; student_breakfast_try: number | null } {
  const f = foldTr(text).replace(/\s+/g, ' ');
  const meal = /ogrenci (\d+(?:,\d{2})?)/.exec(f.replace(/ogrenci-kahvalti/g, 'X'));
  const bf = /ogrenci-kahvalti \(corba\) (\d+(?:,\d{2})?)/.exec(f);
  const num = (s?: string) => (s ? Number(s.replace(',', '.')) : null);
  return { student_meal_try: num(meal?.[1]), student_breakfast_try: num(bf?.[1]) };
}

const DayMenuOut = z.object({
  date: z.string(),
  breakfast: z.array(z.string()),
  lunch: z.array(z.string()),
  dinner: z.array(z.string()),
  vegetarian: z.array(z.string()),
  vegan: z.array(z.string()),
  faculty_club: z.array(z.object({ name: z.string(), kcal: z.number().nullable() })),
  notes: z.array(z.string()),
});

export function registerDiningTools(server: McpServer, db: DatabaseSync): void {
  server.registerTool(
    'metu_dining_menu',
    {
      title: 'METU cafeteria menu',
      description:
        'Cafeteria (yemekhane) menu for a day: breakfast soup, lunch, dinner, vegetarian and vegan options, the Faculty ' +
        'Club à-la-carte list with calories, plus meal hours and the student price. Menus are available from today up ' +
        'to 7 days ahead. Dish names are published in Turkish only.',
      inputSchema: z.object({
        date: IsoDate.optional().describe('Day to show (YYYY-MM-DD, Istanbul time). Default: today'),
        meal: z.enum(['all', 'breakfast', 'lunch', 'dinner']).default('all'),
        lang: LangSchema,
      }),
      outputSchema: z.object({
        menu: DayMenuOut.nullable(),
        hours: z.array(MealHours),
        prices: z.object({ student_meal_try: z.number().nullable(), student_breakfast_try: z.number().nullable() }),
        ...COMMON_OUTPUT,
      }),
      annotations: { ...READ_ONLY, title: 'METU cafeteria menu' },
    },
    async ({ date, meal, lang }) => {
      const day = date ?? todayIstanbul(now());
      const rec = getRecord(db, `menu:${day}`);
      const hoursRec = getRecord(db, 'page:cafeteria-hours:tr');
      const pricesRec = getRecord(db, 'page:cafeteria-prices:tr');
      const hours = hoursRec ? parseMealHours(hoursRec.body) : [];
      const prices = pricesRec ? parseStudentPrices(pricesRec.body) : { student_meal_try: null, student_breakfast_try: null };
      const freshness: Freshness[] = [];
      if (rec) freshness.push(recordFreshness(db, rec, 'dining', lang));
      else freshness.push(computeFreshness(db, { kind: 'menu', collector: 'dining', source_url: diningUrl(day), valid_for: day }, lang));
      if (hoursRec) freshness.push(recordFreshness(db, hoursRec, 'page:cafeteria-hours', lang));

      if (!rec) {
        const today = todayIstanbul(now());
        if (day < today) return toolError(lang === 'tr' ? 'Geçmiş günlerin menüsü saklanmıyor; yalnızca bugün ve sonraki 7 gün.' : 'Past menus are not kept; only today and the next 7 days.', lang);
        return answer({
          lang,
          text: t(lang, 'menu_not_collected', { date: formatDate(day, lang), url: diningUrl(day) }),
          data: { menu: null, hours, prices },
          freshness,
          see_also: seeAlso(db, { query: 'yemekhane cafeteria', category: 'dining' }, lang),
        });
      }
      const menu = JSON.parse(rec.data ?? 'null') as DayMenu;
      const empty = !menu.breakfast.length && !menu.lunch.length && !menu.dinner.length;
      const lines: string[] = [`${formatDate(day, lang)}:`];
      if (empty) lines.push(t(lang, 'no_menu', { date: formatDate(day, lang) }));
      const show = (m: 'breakfast' | 'lunch' | 'dinner') => meal === 'all' || meal === m;
      const weekend = [0, 6].includes(new Date(`${day}T12:00:00Z`).getUTCDay());
      const hoursFor = (m: 'breakfast' | 'lunch' | 'dinner') => {
        const h = hours.find((x) => x.meal === m && x.weekend === weekend) ?? hours.find((x) => x.meal === m);
        return h ? ` (${h.from}–${h.to})` : '';
      };
      if (show('breakfast') && menu.breakfast.length) lines.push(`${t(lang, 'breakfast')}${hoursFor('breakfast')}: ${menu.breakfast.join(', ')}`);
      if (show('lunch') && menu.lunch.length) lines.push(`${t(lang, 'lunch')}${hoursFor('lunch')}: ${menu.lunch.join(', ')}`);
      if (show('dinner') && menu.dinner.length) lines.push(`${t(lang, 'dinner')}${hoursFor('dinner')}: ${menu.dinner.join(', ')}`);
      if (meal !== 'breakfast' && menu.vegetarian.length) lines.push(`${t(lang, 'vegetarian')}: ${menu.vegetarian.join(', ')}`);
      if (meal !== 'breakfast' && menu.vegan.length) lines.push(`${t(lang, 'vegan')}: ${menu.vegan.join(', ')}`);
      if (meal === 'all' && menu.faculty_club.length) {
        lines.push(`${t(lang, 'faculty_club')}: ${menu.faculty_club.map((d) => `${d.name}${d.kcal ? ` ${d.kcal}` : ''}`).join(', ')}`);
      }
      if (prices.student_meal_try) {
        lines.push(
          lang === 'tr'
            ? `Öğrenci yemek ücreti: ${prices.student_meal_try} TL${prices.student_breakfast_try ? `, öğrenci kahvaltı (çorba): ${prices.student_breakfast_try} TL` : ''}`
            : `Student meal price: ${prices.student_meal_try} TRY${prices.student_breakfast_try ? `, student breakfast (soup): ${prices.student_breakfast_try} TRY` : ''}`,
        );
      }
      for (const n of menu.notes) lines.push(`${lang === 'tr' ? 'Not' : 'Note'}: ${n}`);
      const note = t(lang as Lang, 'dish_names_turkish');
      if (note) lines.push(note);
      return answer({ lang, text: lines.join('\n'), data: { menu, hours, prices }, freshness });
    },
  );
}
