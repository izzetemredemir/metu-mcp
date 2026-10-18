import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import * as z from 'zod/v4';
import type { IstanbulClock } from './lib/time.js';
import { parseHm } from './lib/time.js';
import { foldTr } from './lib/text.js';

const Localized = z.object({ en: z.string(), tr: z.string() });

const PermitSchema = z.object({
  name: Localized,
  allow: z.array(z.string()).default([]),
  allow_all: z.boolean().default(false),
  deny: z.array(z.string()).default([]),
  off_hours_allow: z.array(z.string()).default([]),
  off_hours: z
    .object({ weekday_from: z.string(), weekday_to: z.string(), weekends: z.boolean(), semester_breaks: z.boolean() })
    .optional(),
  notes: Localized,
  rule_text: Localized,
});

const RulesSchema = z.object({
  source_url: z.string(),
  source_updated: z.union([z.string(), z.date()]),
  verified_on: z.union([z.string(), z.date()]).transform((v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v)),
  zones: z.array(z.object({ id: z.string(), name: Localized, patterns: z.array(z.string()) })),
  permits: z.record(z.string(), PermitSchema),
  general_rules: z.object({ en: z.array(z.string()), tr: z.array(z.string()) }),
});
export type ParkingRules = z.infer<typeof RulesSchema>;
export const PERMIT_TYPES = ['yellow', 'brown', 'graduate', 'staff', 'none'] as const;
export type PermitType = (typeof PERMIT_TYPES)[number];

const RULES_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data/parking_rules.yaml');
let rules: ParkingRules | undefined;

export function loadParkingRules(): ParkingRules {
  rules ??= RulesSchema.parse(parse(readFileSync(RULES_FILE, 'utf8')));
  return rules;
}

/** Classifies a map parking-lot name into a rule zone (first matching zone wins). */
export function zoneOf(lotName: string, r: ParkingRules = loadParkingRules()): ParkingRules['zones'][number] | undefined {
  const f = foldTr(lotName);
  return r.zones.find((z) => z.patterns.some((p) => new RegExp(p).test(f)));
}

export type Verdict = 'yes' | 'no' | 'only-off-hours' | 'not-listed';

export interface Evaluation {
  verdict: Verdict;
  /** Whether the verdict holds at the evaluated moment (for time-dependent rules). */
  allowed_now: boolean | null;
  zone_id: string | null;
}

function isOffHours(clock: IstanbulClock, oh: NonNullable<z.infer<typeof PermitSchema>['off_hours']>): boolean {
  if (oh.weekends && (clock.weekday === 0 || clock.weekday === 6)) return true;
  const from = parseHm(oh.weekday_from) ?? 18 * 60;
  const to = parseHm(oh.weekday_to) ?? 7 * 60;
  return clock.minutes >= from || clock.minutes < to;
}

/** Can a car with `permit` park in the lot called `lotName` at `clock`? */
export function evaluate(permit: PermitType, lotName: string, clock: IstanbulClock, r: ParkingRules = loadParkingRules()): Evaluation {
  const p = r.permits[permit];
  const zone = zoneOf(lotName, r);
  const zoneId = zone?.id ?? null;
  if (!p) return { verdict: 'not-listed', allowed_now: null, zone_id: zoneId };
  if (p.allow_all) return { verdict: 'yes', allowed_now: true, zone_id: zoneId };
  if (!zoneId) return { verdict: 'not-listed', allowed_now: null, zone_id: null };
  if (p.deny.includes(zoneId) && !p.off_hours_allow.includes(zoneId)) return { verdict: 'no', allowed_now: false, zone_id: zoneId };
  if (p.allow.includes(zoneId)) return { verdict: 'yes', allowed_now: true, zone_id: zoneId };
  if (p.off_hours_allow.includes(zoneId) && p.off_hours) {
    return { verdict: 'only-off-hours', allowed_now: isOffHours(clock, p.off_hours), zone_id: zoneId };
  }
  return { verdict: 'no', allowed_now: false, zone_id: zoneId };
}
