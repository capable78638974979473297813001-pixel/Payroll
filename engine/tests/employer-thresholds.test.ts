import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * data/employer-thresholds/ is a reference dataset, not wired into any
 * calculation this engine performs (see that folder's own README for why).
 * These tests exist for the same reason data/minimum-wage/'s own generic
 * tests do: catch a transcription error or a contradiction between two
 * entries, not verify legal correctness — that rests on each entry's own
 * cited sources.
 */

const FILE = join(import.meta.dirname, '..', 'data', 'employer-thresholds', 'NY-2026.json');

interface ThresholdEntry {
  id: string;
  law: string;
  level: 'state' | 'federal';
  sources: { title: string; url: string; verifiedOn: string }[];
  [key: string]: unknown;
}

interface EmployerThresholdsFile {
  state: string;
  year: number;
  asOf: string;
  thresholds: ThresholdEntry[];
  knownGaps: string[];
  [key: string]: unknown;
}

function load(): EmployerThresholdsFile {
  return JSON.parse(readFileSync(FILE, 'utf8')) as EmployerThresholdsFile;
}

describe('data/employer-thresholds/NY-2026.json', () => {
  test('parses, is a 2026 snapshot, and every entry carries a sourced trail', () => {
    const data = load();
    assert.equal(data.year, 2026);
    assert.ok(data.thresholds.length >= 10, `expected at least 10 threshold entries, found ${data.thresholds.length}`);
    const ids = data.thresholds.map((t) => t.id);
    assert.equal(new Set(ids).size, ids.length, 'threshold ids must be unique');
    for (const t of data.thresholds) {
      assert.ok(t.law, `${t.id} carries no law citation`);
      assert.ok(['state', 'federal'].includes(t.level), `${t.id} has an unrecognised level: ${t.level}`);
      assert.ok(t.sources?.length > 0, `${t.id} carries no sources`);
      for (const s of t.sources) {
        for (const key of ['title', 'url', 'verifiedOn'] as const) {
          assert.ok(s[key], `${t.id} has a source missing '${key}'`);
        }
      }
    }
  });

  test('NY Paid Sick Leave: the 4-tier ladder matches the statute, including the net-income test the smallest tier depends on', () => {
    const data = load();
    const psl = data.thresholds.find((t) => t.id === 'ny_paid_sick_leave')!;
    const tiers = psl.tiers as { employeeCountMax?: number; employeeCountMin?: number; condition?: string; entitlement: string }[];
    assert.equal(tiers.length, 4);
    assert.ok(tiers.some((t) => t.employeeCountMax === 4 && /<= \$1,000,000/.test(t.condition ?? '') && /UNPAID/.test(t.entitlement)));
    assert.ok(tiers.some((t) => t.employeeCountMax === 4 && /> \$1,000,000/.test(t.condition ?? '') && /PAID/.test(t.entitlement)));
    assert.ok(tiers.some((t) => t.employeeCountMin === 5 && t.employeeCountMax === 99 && /40 hours/.test(t.entitlement)));
    assert.ok(tiers.some((t) => t.employeeCountMin === 100 && /56 hours/.test(t.entitlement)));
  });

  test('NY Paid Family Leave has NO size floor, unlike Paid Sick Leave — the contrast this entry exists to document', () => {
    const data = load();
    const pfl = data.thresholds.find((t) => t.id === 'ny_paid_family_leave')!;
    const tiers = pfl.tiers as { employeeCountMin: number }[];
    assert.equal(tiers.length, 1);
    assert.equal(tiers[0]!.employeeCountMin, 1);
  });

  test('NY WARN Act: 50-employee floor, 90-day notice — both stricter than federal WARN', () => {
    const data = load();
    const warn = data.thresholds.find((t) => t.id === 'ny_warn_act')!;
    assert.equal((warn.employerCoverage as { employeeCountMin: number }).employeeCountMin, 50);
    assert.equal(warn.noticePeriod, '90 days -- 50% longer than the federal WARN Act\'s 60 days.');
    const events = warn.triggeringEvents as { id: string }[];
    assert.ok(events.some((e) => e.id === 'mass_layoff_absolute'));
  });

  test('NY mini-COBRA covers exactly what federal COBRA (20+) leaves out (<20)', () => {
    const data = load();
    const mini = data.thresholds.find((t) => t.id === 'ny_mini_cobra')!;
    const federal = data.thresholds.find((t) => t.id === 'federal_cobra')!;
    const miniTiers = mini.tiers as { employeeCountMax?: number; employeeCountMin?: number }[];
    const federalMin = (federal.tiers as { employeeCountMin: number }[])[0]!.employeeCountMin;
    assert.equal(federalMin, 20);
    assert.ok(miniTiers.some((t) => t.employeeCountMax === federalMin - 1));
    assert.ok(miniTiers.some((t) => t.employeeCountMin === federalMin));
  });

  test('federal thresholds a NY employer must separately track are all present with their long-stable figures', () => {
    const data = load();
    const byId = Object.fromEntries(data.thresholds.map((t) => [t.id, t]));
    assert.equal(
      (byId.federal_aca_employer_mandate!.tiers as { employeeCountMin: number }[])[0]!.employeeCountMin,
      50,
    );
    assert.equal((byId.federal_fmla!.tiers as { employeeCountMin: number }[])[0]!.employeeCountMin, 50);
    assert.equal((byId.federal_cobra!.tiers as { employeeCountMin: number }[])[0]!.employeeCountMin, 20);
    const eeo = byId.federal_eeo_thresholds!.tiers as { employeeCountMin: number }[];
    assert.ok(eeo.some((t) => t.employeeCountMin === 15), 'Title VII/ADA floor (15) missing');
    assert.ok(eeo.some((t) => t.employeeCountMin === 20), 'ADEA floor (20) missing');
    assert.equal(
      (byId.federal_flsa_enterprise_coverage!.tiers as { revenueThreshold: number }[])[0]!.revenueThreshold,
      500000,
    );
  });

  test('NY Human Rights Law: the 4-employee floor was eliminated, not merely lowered', () => {
    const data = load();
    const nyshrl = data.thresholds.find((t) => t.id === 'ny_human_rights_law')!;
    const tiers = nyshrl.tiers as { employeeCountMin: number }[];
    assert.equal(tiers.length, 1);
    assert.equal(tiers[0]!.employeeCountMin, 1);
  });
});
