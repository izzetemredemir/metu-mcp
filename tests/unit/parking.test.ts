import { describe, expect, it } from 'vitest';
import { istanbulClock } from '../../src/lib/time.js';
import { evaluate, zoneOf } from '../../src/parking.js';

const at = (iso: string) => istanbulClock(new Date(iso));
const TUE_14 = at('2026-10-06T14:00:00+03:00');
const TUE_19 = at('2026-10-06T19:00:00+03:00');
const TUE_06 = at('2026-10-06T06:30:00+03:00');
const SAT_11 = at('2026-10-10T11:00:00+03:00');

describe('zone classification of map lot names', () => {
  it.each([
    ['Department of Physics Parking Lot', 'restricted-department'],
    ['Department of Industrial Engineering Parking Lot', 'restricted-department'],
    ['Human Sciences Parking Lot', 'restricted-department'],
    ['Department of Computer Education and Instructional Technology Parking Lot', 'department'],
    ['Library Parking Lot', 'library'],
    ['Cafeteria Parking Lot', 'cafeteria'],
    ['Cultural and Convention Center Parking Lot', 'kkm'],
    ['A2 Gate Parking Lot', 'satellite-a2'],
    ['1st Dormitory Parking Lot', 'dormitory'],
    ['Shopping Center Parking Lot', 'shopping'],
  ])('%s → %s', (name, zone) => {
    expect(zoneOf(name)?.id).toBe(zone);
  });

  it('leaves unknown lots unclassified', () => {
    expect(zoneOf('Havelsan Parking Lot')).toBeUndefined();
  });
});

describe('permit × lot × time', () => {
  it.each([
    ['brown', 'Department of Computer Education and Instructional Technology Parking Lot', TUE_14, 'only-off-hours', false],
    ['brown', 'Department of Computer Education and Instructional Technology Parking Lot', TUE_19, 'only-off-hours', true],
    ['brown', 'Department of Computer Education and Instructional Technology Parking Lot', TUE_06, 'only-off-hours', true],
    ['brown', 'Department of Physics Parking Lot', SAT_11, 'only-off-hours', true],
    ['brown', 'Cultural and Convention Center Parking Lot', TUE_14, 'yes', true],
    ['brown', 'Library Parking Lot', TUE_14, 'no', false],
    ['yellow', 'Library Parking Lot', TUE_14, 'yes', true],
    ['yellow', 'Department of Physics Parking Lot', TUE_19, 'no', false],
    ['yellow', 'Department of Mechanical Engineering Parking Lot-1', TUE_14, 'yes', true],
    ['graduate', 'Cafeteria Parking Lot', TUE_14, 'no', false],
    ['graduate', 'A2 Gate Parking Lot', TUE_14, 'yes', true],
    ['staff', 'Department of Physics Parking Lot', TUE_14, 'yes', true],
    ['none', 'Library Parking Lot', TUE_14, 'no', false],
    ['yellow', 'Havelsan Parking Lot', TUE_14, 'not-listed', null],
  ] as const)('%s at %s', (permit, lot, clock, verdict, allowedNow) => {
    const e = evaluate(permit, lot, clock);
    expect(e.verdict).toBe(verdict);
    expect(e.allowed_now).toBe(allowedNow);
  });
});
