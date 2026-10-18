import { checkLinks } from '../links.js';
import { collectAnnouncements } from './announcements.js';
import { collectCalendar } from './calendar.js';
import { collectCatalog, collectCatalogDetails, collectSyllabi } from './catalog.js';
import { collectClassrooms } from './classrooms.js';
import { collectCurricula } from './curriculum.js';
import { collectDining } from './dining.js';
import { collectDoctors } from './doctors.js';
import { collectEvents } from './events.js';
import { collectFaqAnswers, collectFaqIndex } from './faq.js';
import { collectOsm } from './osm.js';
import { collectPages } from './pages.js';
import { collectPlaces } from './places.js';
import { runMaintenance } from '../maintenance.js';
import type { CollectorContext } from './runner.js';
import { collectTheses } from './theses.js';
import { collectTrainingDetails, collectTrainings } from './trainings.js';

/** Every collector the worker schedules, by name (see SCHEDULES in config.ts). */
export const COLLECTORS: Record<string, (ctx: CollectorContext, only?: string[]) => Promise<void>> = {
  announcements: (ctx, only) => collectAnnouncements(ctx, only, 'frequent'),
  'announcements-hourly': (ctx, only) => collectAnnouncements(ctx, only, 'hourly'),
  calendar: (ctx) => collectCalendar(ctx),
  dining: (ctx) => collectDining(ctx),
  pages: collectPages,
  places: (ctx) => collectPlaces(ctx),
  links: (ctx) => checkLinks(ctx),
  catalog: (ctx) => collectCatalog(ctx),
  'catalog-details': (ctx) => collectCatalogDetails(ctx),
  syllabus: (ctx) => collectSyllabi(ctx),
  curriculum: (ctx) => collectCurricula(ctx),
  classrooms: (ctx) => collectClassrooms(ctx),
  maintenance: (ctx) => runMaintenance(ctx),
  doctors: (ctx) => collectDoctors(ctx),
  events: (ctx) => collectEvents(ctx),
  faq: (ctx) => collectFaqIndex(ctx),
  'faq-answers': (ctx) => collectFaqAnswers(ctx),
  trainings: (ctx) => collectTrainings(ctx),
  'trainings-details': (ctx) => collectTrainingDetails(ctx),
  theses: (ctx) => collectTheses(ctx),
  osm: (ctx) => collectOsm(ctx),
};
