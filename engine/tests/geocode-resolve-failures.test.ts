import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { resolveAddress } from '../geocode/index.ts';
import { clearVintageLayerCache } from '../geocode/census.ts';

/**
 * resolveAddress() end to end with every network call stubbed, to show that a
 * failed boundary lookup is REPORTED instead of reading as a clean, complete
 * answer. Each service answers with the shape the real one uses; a test turns
 * one of them into an ArcGIS error returned with HTTP 200.
 */

const realFetch = globalThis.fetch;
const realIndexPath = process.env.ADDRESS_INDEX_PATH;
let identifyMode: 'ok' | 'error' = 'ok';
let identifyCalls = 0;

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

const censusMatch = {
  result: {
    addressMatches: [
      {
        matchedAddress: '90 W BROAD ST, COLUMBUS, OH, 43215',
        coordinates: { x: -83.0, y: 39.96 },
        addressComponents: { fromAddress: '1', toAddress: '99' },
        geographies: {
          States: [{ STUSAB: 'OH' }],
          'Incorporated Places': [{ NAME: 'Columbus city' }],
          'County Subdivisions': [],
          Counties: [{ NAME: 'Franklin County' }],
        },
      },
    ],
  },
};

before(() => {
  process.env.ADDRESS_INDEX_PATH = '/nonexistent/address-points.db';
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url.includes('geocoding.geo.census.gov')) return json(censusMatch);
    if (url.includes('/identify')) {
      identifyCalls++;
      return identifyMode === 'error' ? json({ error: { code: 500, message: 'Service temporarily unavailable' } }) : json({ results: [] });
    }
    if (url.includes('tigerweb.geo.census.gov')) {
      return json({ layers: [
        { id: 1, name: 'Unified School Districts' }, { id: 2, name: 'County Subdivisions' },
        { id: 3, name: 'Incorporated Places' }, { id: 4, name: 'States' }, { id: 5, name: 'Counties' },
      ] });
    }
    if (url.includes('nominatim')) return json([]);
    return json({ features: [], elements: [], results: [] });
  }) as unknown as typeof fetch;
});
after(() => {
  globalThis.fetch = realFetch;
  if (realIndexPath === undefined) delete process.env.ADDRESS_INDEX_PATH;
  else process.env.ADDRESS_INDEX_PATH = realIndexPath;
});
beforeEach(() => {
  clearVintageLayerCache();
  identifyCalls = 0;
});

describe('resolveAddress() reports a failed boundary lookup', () => {
  test('a school-district lookup that fails (ArcGIS error in an HTTP 200) is not "fully resolved"', { timeout: 60_000 }, async () => {
    identifyMode = 'error';
    const r = await resolveAddress('90 W Broad St, Columbus, OH 43215', 'work', '2026-08-15', { useLocalIndex: false });
    assert.equal(r.matched, true);
    assert.ok(identifyCalls > 0, 'the school-district identify call was attempted');
    assert.equal(r.fullyResolved, false);
    assert.ok(r.lowConfidenceReasons.some((x) => /school-district lookup/i.test(x)), r.lowConfidenceReasons.join(' | '));
  });

  test('the same address with a healthy service has no such reason', { timeout: 60_000 }, async () => {
    identifyMode = 'ok';
    const r = await resolveAddress('90 W Broad St, Columbus, OH 43215', 'work', '2026-08-15', { useLocalIndex: false });
    assert.ok(!r.lowConfidenceReasons.some((x) => /school-district lookup/i.test(x)), r.lowConfidenceReasons.join(' | '));
  });

  test('a failed lookup of the check date\'s own boundary vintage says current boundaries were used', { timeout: 60_000 }, async () => {
    identifyMode = 'error';
    const r = await resolveAddress('90 W Broad St, Columbus, OH 43215', 'work', '2025-06-15', { useLocalIndex: false });
    assert.equal(r.matched, true);
    assert.equal(r.fullyResolved, false);
    assert.ok(r.lowConfidenceReasons.some((x) => /CURRENT boundaries/.test(x)), r.lowConfidenceReasons.join(' | '));
  });
});
