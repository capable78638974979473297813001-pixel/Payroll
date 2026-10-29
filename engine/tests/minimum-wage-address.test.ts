import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  minimumWageForAddress,
  normalizeCountyName,
  normalizePlaceName,
  regionFromCounty,
  resolveMinimumWageLocality,
} from '../src/minimum-wage-address.ts';

/**
 * The address→ordinance half of the minimum wage lookup.
 *
 * These are PURE tests: they take the place/county names a geocode
 * produces as input rather than calling Census, the same split
 * geocode/resolve.ts already uses. The names below are real Census output
 * shapes ("Seattle city", "King County"), not invented ones — that suffix
 * is exactly what the normalizer exists to handle.
 */

const D = '2026-08-15';

describe('place and county name normalization', () => {
  test('strips the Census type word that ordinance files do not carry', () => {
    assert.equal(normalizePlaceName('Seattle city'), 'Seattle');
    assert.equal(normalizePlaceName('Tukwila city'), 'Tukwila');
    assert.equal(normalizePlaceName('West Hollywood city'), 'West Hollywood');
    assert.equal(normalizeCountyName('King County'), 'King');
    assert.equal(normalizeCountyName('Montgomery County'), 'Montgomery');
  });

  test('a capitalised "City" inside a real name survives', () => {
    // The bug geocode/normalize.ts already learned the hard way: a
    // case-insensitive strip turns "Kansas City city" into "Kansas".
    assert.equal(normalizePlaceName('Kansas City city'), 'Kansas City');
    assert.equal(normalizePlaceName('Culver City city'), 'Culver City');
    assert.equal(normalizePlaceName('Daly City city'), 'Daly City');
    assert.equal(normalizePlaceName('Redwood City city'), 'Redwood City');
  });

  test('Census parentheticals are dropped', () => {
    assert.equal(normalizePlaceName('Indianapolis city (balance)'), 'Indianapolis');
  });
});

describe('locality resolution', () => {
  test('an incorporated place with its own ordinance matches it', () => {
    const r = resolveMinimumWageLocality('WA', ['Seattle city'], ['King County'], D);
    assert.equal(r.match?.id, 'seattle');
    assert.equal(r.match?.via, 'incorporated place');
  });

  test('a city ordinance beats the county it sits inside', () => {
    // Renton is inside King County, whose ordinance covers unincorporated
    // areas only. The city's own ordinance is the one that applies.
    const r = resolveMinimumWageLocality('WA', ['Renton city'], ['King County'], D);
    assert.equal(r.match?.id, 'renton');
    assert.equal(r.match?.via, 'incorporated place');
  });

  test('NO incorporated place means the unincorporated-county ordinance applies', () => {
    const r = resolveMinimumWageLocality('WA', [], ['King County'], D);
    assert.equal(r.match?.id, 'king_county_unincorporated');
    assert.equal(r.match?.via, 'unincorporated county');
  });

  test('an unincorporated-only county ordinance does NOT reach an incorporated city', () => {
    // Los Angeles County's ordinance is expressly unincorporated-only, and
    // Burbank has no ordinance of its own — so this correctly falls
    // through to the state floor rather than picking up the county rate.
    const r = resolveMinimumWageLocality('CA', ['Burbank city'], ['Los Angeles County'], D);
    assert.equal(r.match, null);
    assert.match(r.note, /No CA local ordinance covers Burbank/);
  });

  test('a city ordinance inside that same county still matches', () => {
    const r = resolveMinimumWageLocality('CA', ['Pasadena city'], ['Los Angeles County'], D);
    assert.equal(r.match?.id, 'pasadena');
  });

  test('a consolidated city-and-county matches either way', () => {
    const r = resolveMinimumWageLocality('CO', ['Denver city'], ['Denver County'], D);
    assert.equal(r.match?.id, 'denver');
    assert.equal(r.match?.via, 'city and county');
  });

  test('a state with locals, at an address none of them cover, is a clean miss', () => {
    const r = resolveMinimumWageLocality('WA', ['Spokane city'], ['Spokane County'], D);
    assert.equal(r.match, null);
    assert.ok(r.available.length > 0, 'the state\'s other ordinances are still offered');
  });

  test('a state with no local ordinances at all says so', () => {
    const r = resolveMinimumWageLocality('TX', ['Austin city'], ['Travis County'], D);
    assert.equal(r.match, null);
    assert.equal(r.available.length, 0);
    assert.match(r.note, /no local minimum wage ordinances/);
  });
});

describe('region derived from county', () => {
  test('New York downstate is the four-county + NYC test its own ruleset states', () => {
    assert.equal(regionFromCounty('NY', ['New York County']), 'downstate');
    assert.equal(regionFromCounty('NY', ['Kings County']), 'downstate');
    assert.equal(regionFromCounty('NY', ['Westchester County']), 'downstate');
    assert.equal(regionFromCounty('NY', ['Nassau County']), 'downstate');
    assert.equal(regionFromCounty('NY', ['Erie County']), undefined, 'Buffalo is upstate');
  });

  test('Oregon non-urban counties resolve; Portland metro deliberately does not', () => {
    assert.equal(regionFromCounty('OR', ['Baker County']), 'nonurban');
    assert.equal(regionFromCounty('OR', ['Wheeler County']), 'nonurban');
    // Multnomah is neither non-urban nor automatically Portland metro: the
    // metro region is an urban growth boundary that cuts THROUGH the
    // county, so it can only come from the coordinate.
    assert.equal(regionFromCounty('OR', ['Multnomah County']), undefined);
    assert.equal(regionFromCounty('OR', ['Marion County']), undefined);
  });

  test('every other state has no regional split to derive', () => {
    assert.equal(regionFromCounty('WA', ['King County']), undefined);
    assert.equal(regionFromCounty('CA', ['Los Angeles County']), undefined);
  });
});

describe('end to end, from geocoded names', () => {
  const at = (state: string, places: string[], counties: string[], extra = {}) =>
    minimumWageForAddress({ checkDate: D, state, incorporatedPlaces: places, counties, ...extra });

  test('the highest applicable level binds, and the losers stay visible', () => {
    const a = at('WA', ['Seattle city'], ['King County']);
    assert.equal(a.wage.hourly, 21.3);
    assert.equal(a.wage.bindingLevel, 'local');
    assert.equal(a.wage.bindingJurisdiction, 'Seattle');
    assert.deepEqual(
      a.wage.considered.map((c) => c.level),
      ['federal', 'state', 'local'],
    );
  });

  test('no state or local floor above the federal one leaves the FLSA rate', () => {
    const a = at('TX', ['Austin city'], ['Travis County']);
    assert.equal(a.wage.hourly, 7.25);
    assert.equal(a.wage.bindingLevel, 'federal');
  });

  test('New York downstate is picked up from the county with no caller input', () => {
    const downstate = at('NY', ['New York city'], ['New York County']);
    const upstate = at('NY', ['Buffalo city'], ['Erie County']);
    assert.equal(downstate.query.region, 'downstate');
    assert.equal(downstate.wage.hourly, 17);
    assert.equal(upstate.query.region, undefined);
    assert.equal(upstate.wage.hourly, 16);
  });

  test('an explicit region always beats the county-derived one', () => {
    const a = at('OR', ['Portland city'], ['Multnomah County'], { region: 'portland_metro' });
    assert.equal(a.query.region, 'portland_metro');
    assert.equal(a.wage.hourly, 16.8);
  });

  test('a locality override replaces the address match', () => {
    const a = at('WA', ['Seattle city'], ['King County'], { localityOverride: 'tukwila' });
    assert.equal(a.query.locality, 'tukwila');
    assert.equal(a.wage.bindingJurisdiction, 'Tukwila');
  });

  test('the tipped cash wage is returned where a tip credit exists, and flagged where it does not', () => {
    const tx = at('TX', ['Austin city'], ['Travis County'], { tipped: true });
    assert.equal(tx.wage.hourly, 2.13);
    assert.equal(tx.wage.tipCreditAllowed, true);

    // Washington allows no tip credit at all, so the tipped answer is the
    // full rate — a real difference a naive "tipped = lower" model misses.
    const wa = at('WA', ['Spokane city'], ['Spokane County'], { tipped: true });
    assert.equal(wa.wage.tipCreditAllowed, false);
    assert.equal(wa.wage.hourly, 17.13);
  });

  test('a NaN employee count never silently satisfies a size tier', () => {
    const a = at('MN', ['Minneapolis city'], ['Hennepin County'], { employeeCount: Number('abc') });
    assert.ok(Number.isFinite(a.wage.hourly));
    assert.ok(a.wage.hourly > 0);
  });
});
