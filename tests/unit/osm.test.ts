import { describe, expect, it } from 'vitest';
import { insideOutline, linkPlace, overpassQuery, type OsmFeature } from '../../src/collectors/osm.js';
import { OSM_CAMPUS_BBOX } from '../../src/config.js';

// A square building outline around (39.900, 32.780), about 110 m × 85 m.
const square: [number, number][] = [
  [39.8995, 32.7795],
  [39.8995, 32.7805],
  [39.9005, 32.7805],
  [39.9005, 32.7795],
  [39.8995, 32.7795],
];
const building: OsmFeature = { id: 'way/1', name: 'Kütüphane', name_en: null, other_names: [], kind: 'building', lat: 39.9, lng: 32.78, outline: square };

describe('OpenStreetMap enrichment', () => {
  it('tests points against an outline', () => {
    expect(insideOutline(39.9, 32.78, square)).toBe(true);
    expect(insideOutline(39.9012, 32.78, square)).toBe(false);
  });

  it('links an outline to the map place inside it, never to a parking lot or bus stop', () => {
    const places = [
      { id: 'map:lot', lat: 39.9, lng: 32.7801, category_id: 7 },
      { id: 'map:stop', lat: 39.9001, lng: 32.78, category_id: 23 },
      { id: 'map:far', lat: 39.902, lng: 32.78, category_id: 16 },
      { id: 'map:library', lat: 39.9003, lng: 32.7799, category_id: 16 },
    ];
    expect(linkPlace(building, places)).toBe('map:library');
    expect(linkPlace(building, places.filter((p) => p.id !== 'map:library'))).toBeNull();
  });

  it('links a point only to a place a few metres away', () => {
    const point: OsmFeature = { ...building, id: 'node/2', outline: null, lat: 39.9, lng: 32.78 };
    expect(linkPlace(point, [{ id: 'near', lat: 39.90005, lng: 32.78, category_id: 8 }])).toBe('near');
    expect(linkPlace(point, [{ id: 'far', lat: 39.9006, lng: 32.78, category_id: 8 }])).toBeNull();
  });

  it('asks Overpass only for named features inside the campus box', () => {
    const q = overpassQuery();
    expect(q).toContain(`(${OSM_CAMPUS_BBOX.join(',')})`);
    expect(q.match(/\["name"\]/g)!.length).toBe(5);
    expect(q).toMatch(/out tags geom;$/);
  });
});
