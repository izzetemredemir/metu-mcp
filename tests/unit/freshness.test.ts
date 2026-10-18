import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeFreshness, freshnessLine } from '../../src/store/freshness.js';
import { getRecord, hasRecords, recentChanges, upsertRecord } from '../../src/store/records.js';
import { recordRunFailure, recordRunSuccess } from '../../src/store/runs.js';
import { memoryDb } from '../helpers.js';

describe('freshness and change tracking', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-30T09:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('is fresh right after a fetch and stale after the threshold', () => {
    const db = memoryDb();
    recordRunSuccess(db, 'announcements:oidb:tr', 10);
    const input = { kind: 'announcement' as const, collector: 'announcements:oidb:tr', source_url: 'https://oidb.metu.edu.tr/tr/announcements' };
    expect(computeFreshness(db, input, 'tr').status).toBe('fresh');
    vi.setSystemTime(new Date('2026-09-30T12:00:00Z'));
    const stale = computeFreshness(db, input, 'tr');
    expect(stale.status).toBe('stale');
    expect(stale.warning).toContain('3 saattir doğrulanamadı');
    expect(computeFreshness(db, input, 'en').warning).toContain('not been re-verified for 3 hour(s)');
    expect(freshnessLine(stale, 'tr')).toMatch(/^— Kaynak: oidb\.metu\.edu\.tr · son kontrol 2026-09-30 12:00/);
  });

  it('reports an unreachable source after repeated failures', () => {
    const db = memoryDb();
    recordRunSuccess(db, 'dining', 7);
    for (let i = 0; i < 3; i++) recordRunFailure(db, 'dining', 'HTTP 503');
    const f = computeFreshness(db, { kind: 'menu', collector: 'dining', source_url: 'https://kafeterya.metu.edu.tr/' }, 'en');
    expect(f.status).toBe('source_unreachable');
    expect(f.warning).toContain('3 failed attempts');
  });

  it('says so when a source was never fetched', () => {
    const db = memoryDb();
    expect(computeFreshness(db, { kind: 'page', collector: 'page:x', source_url: 'https://ihm.metu.edu.tr/tr/ogrenci' }, 'en').status).toBe('no_data');
  });

  it('touches unchanged records and versions changed ones', () => {
    const db = memoryDb();
    const base = { id: 'page:ihm-parking-by-permit:tr', kind: 'page' as const, source: 'ihm-parking-by-permit', lang: 'tr' as const, title: 'Park yerleri', url: 'https://ihm.metu.edu.tr/tr/x' };
    expect(upsertRecord(db, { ...base, body: 'a) kural bir\nb) kural iki' })).toBe('new');
    const first = getRecord(db, base.id)!;

    vi.setSystemTime(new Date('2026-10-01T09:00:00Z'));
    expect(upsertRecord(db, { ...base, body: 'a) kural bir\nb) kural iki' })).toBe('unchanged');
    const touched = getRecord(db, base.id)!;
    expect(touched.fetched_at).toBe('2026-10-01T09:00:00.000Z');
    expect(touched.last_changed_at).toBe(first.last_changed_at);

    vi.setSystemTime(new Date('2026-10-02T09:00:00Z'));
    expect(upsertRecord(db, { ...base, body: 'a) kural bir\nb) kural iki (değişti)' })).toBe('changed');
    expect(getRecord(db, base.id)!.last_changed_at).toBe('2026-10-02T09:00:00.000Z');

    const changes = recentChanges(db, { since: '2026-09-01T00:00:00Z' });
    expect(changes).toHaveLength(1);
    expect(changes[0]!.summary.tr).toContain('kural iki (değişti)');
    expect(changes[0]!.summary.en).toContain('Content updated');
  });

  it('does not report the first load of a source as "new"', () => {
    const db = memoryDb();
    const rec = (n: number) => ({ id: `announcement:https://x.metu.edu.tr/${n}`, kind: 'announcement' as const, source: 'oidb', lang: 'tr' as const, title: `Duyuru ${n}`, url: `https://x.metu.edu.tr/${n}` });
    // First run: the collector sees no prior records, so nothing is "new".
    let known = hasRecords(db, 'announcement', 'oidb', 'tr');
    upsertRecord(db, rec(1), undefined, { trackNew: known });
    upsertRecord(db, rec(2), undefined, { trackNew: known });
    expect(recentChanges(db, { since: '2026-01-01T00:00:00Z' })).toHaveLength(0);
    // Next run: a later announcement from the same source is news.
    known = hasRecords(db, 'announcement', 'oidb', 'tr');
    upsertRecord(db, rec(2), undefined, { trackNew: known });
    upsertRecord(db, rec(3), undefined, { trackNew: known });
    expect(recentChanges(db, { since: '2026-01-01T00:00:00Z' }).map((c) => c.title)).toEqual(['Duyuru 3']);
  });
});
