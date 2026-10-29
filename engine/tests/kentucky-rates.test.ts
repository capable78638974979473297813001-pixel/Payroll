import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { calculatePaycheck } from '../src/calculate.ts';
import type { PaycheckInput } from '../src/types.ts';

/**
 * The 2026-09-28 pass on data/local/KY-occupational-2026.json: rates
 * corrected from the jurisdiction's own source or KACo's January 2026
 * county table, and mid-year changes that now depend on the check date.
 * $2,000 biweekly, so 1% = 2000 cents.
 */

const ky = (checkDate: string, certificate: Record<string, unknown>): PaycheckInput => ({
  checkDate,
  payFrequency: 'biweekly',
  earnings: [{ code: 'REG', category: 'regular', amount: 200000 }],
  deductions: [],
  federalW4: { filingStatus: 'single', multipleJobs: false, dependentCredit: 0, otherIncome: 0, deductions: 0, extraWithholding: 0 },
  ytd: { socialSecurity: 0, medicare: 0, futa: 0 },
  workState: { code: 'KY', certificate } as PaycheckInput['workState'],
});

const local = (r: ReturnType<typeof calculatePaycheck>) => r.taxes.find((t) => t.id === 'KY_LOCAL');

describe('Kentucky corrections', () => {
  for (const [where, cents] of [
    [{ workCity: 'Winchester' }, 4300], // 2.15% since 2024-10-01, not 2%
    [{ workCity: 'Middlesboro' }, 4900], // 2.45% since 2024-04-01, not 2%
    [{ workCity: 'Marion' }, 3000], // 1.5% since 2025-07-01, not 0.75%
    [{ workCounty: 'Simpson County' }, 2500], // 1.25% since 2026-01-01, not 1%
    [{ workCounty: 'Powell County' }, 3500], // 1.75% since 2025-07-01, not 1.25%
    [{ workCounty: 'Crittenden County' }, 3000], // 1.5% since 2025-07-01, not 0.5%
  ] as const) {
    test(`${Object.values(where)[0]}: ${cents} cents`, () => {
      assert.equal(local(calculatePaycheck(ky('2026-06-15', where)))?.amount, cents);
    });
  }

  test('a rate read from the city itself carries no notice (Paducah 2%)', () => {
    const r = calculatePaycheck(ky('2026-06-15', { workCity: 'Paducah' }));
    assert.equal(local(r)?.amount, 4000);
    assert.equal(r.notices, undefined);
  });

  test('a rate still unconfirmed keeps its notice (Adairville, inferred)', () => {
    const r = calculatePaycheck(ky('2026-06-15', { workCity: 'Adairville' }));
    assert.equal(r.notices?.[0].tier, 'inferred');
  });
});

describe('the 2026-09-30 pass', () => {
  test("Benton 0.6% per its own quarterly return, not 0.5%", () => {
    assert.equal(local(calculatePaycheck(ky('2026-06-15', { workCity: 'Benton' })))?.amount, 1200);
    assert.equal(local(calculatePaycheck(ky('2025-06-13', { workCity: 'Benton' })))?.amount, 1200);
  });

  test("Burkesville 2% per its own license application, not 1%", () => {
    assert.equal(local(calculatePaycheck(ky('2026-06-15', { workCity: 'Burkesville' })))?.amount, 4000);
  });

  for (const [city, cents] of [
    ['Vanceburg', 2000],
    ['West Liberty', 2000],
    ['Jackson', 3000],
    ['Perryville', 3000],
  ] as const) {
    test(`${city}: confirmed from its own form or code, so no notice`, () => {
      const r = calculatePaycheck(ky('2026-06-15', { workCity: city }));
      assert.equal(local(r)?.amount, cents);
      assert.equal(r.notices, undefined);
    });
  }
});

describe('the 2026-10-05 verification report', () => {
  for (const [where, cents, why] of [
    [{ workCity: 'Shively' }, 6900, '2% of wages (s. 112.03(A)(1)) stacked on Louisville Metro 1.45%; 2.25% is net profits'],
    [{ workCity: 'Hillview' }, 3600, '1.8% (s. 110.22)'],
    [{ workCity: 'Ludlow' }, 4000, '2.0% (Kenton County 2026 rates)'],
    [{ workCity: 'Stanford' }, 2300, '1.15% (city Form 541)'],
    [{ workCity: 'Shepherdsville' }, 4000, '2% (code s. 111.03, city form and portal)'],
  ] as const) {
    test(`${Object.values(where)[0]}: ${why}`, () => {
      const r = calculatePaycheck(ky('2026-06-15', where));
      assert.equal(local(r)?.amount, cents);
      assert.equal(r.notices, undefined);
    });
  }

  test('Marshall County Schools: 0.5% for a district resident working in the county, nothing for anyone else, in 2025 and 2026', () => {
    const school = 'Marshall County Occupational License Tax For Schools';
    const both = { workSchoolDistrict: school, residenceSchoolDistrict: school };
    assert.equal(local(calculatePaycheck(ky('2026-06-15', both)))?.amount, 1000);
    assert.equal(local(calculatePaycheck(ky('2025-06-13', both)))?.amount, 1000);
    assert.equal(local(calculatePaycheck(ky('2026-06-15', { workSchoolDistrict: school, residenceSchoolDistrict: 'Boone County School Board' })))?.amount ?? 0, 0);
  });
});

describe('Kentucky rates that change on 2026-07-01', () => {
  test('Grant County: 2.5% through June, 2.0% from July', () => {
    assert.equal(local(calculatePaycheck(ky('2026-06-30', { workCounty: 'Grant County' })))?.amount, 5000);
    assert.equal(local(calculatePaycheck(ky('2026-07-01', { workCounty: 'Grant County' })))?.amount, 4000);
  });

  test('Elsmere: 1.25% through June, 1.75% from July', () => {
    assert.equal(local(calculatePaycheck(ky('2026-06-15', { workCity: 'Elsmere' })))?.amount, 2500);
    assert.equal(local(calculatePaycheck(ky('2026-08-15', { workCity: 'Elsmere' })))?.amount, 3500);
  });

  test('Falmouth: no wage tax before July, 1.5% from July', () => {
    assert.equal(local(calculatePaycheck(ky('2026-06-15', { workCity: 'Falmouth' }))), undefined);
    assert.equal(local(calculatePaycheck(ky('2026-07-15', { workCity: 'Falmouth' })))?.amount, 3000);
  });
});

describe('Kentucky cities the SOS scrape lacked', () => {
  test('Williamstown 1%, confirmed by two independent sources, so no notice', () => {
    const r = calculatePaycheck(ky('2026-06-15', { workCity: 'Williamstown' }));
    assert.equal(local(r)?.amount, 2000);
    assert.equal(r.notices, undefined);
  });
});

describe('Louisville/Jefferson County Metro and the cities inside it', () => {
  // $2,000 biweekly: Metro 1.45% nonresident = 2900, 2.2% resident = 4400.
  test('Jeffersontown: its 1% stacks on Metro 1.45% (no KRS 68.197 credit in Jefferson County)', () => {
    assert.equal(local(calculatePaycheck(ky('2026-06-15', { workCity: 'Jeffersontown' })))?.amount, 2000 + 2900);
  });

  test('the same with workCounty set, as the geocoder sends it', () => {
    assert.equal(local(calculatePaycheck(ky('2026-06-15', { workCity: 'Jeffersontown', workCounty: 'Jefferson County' })))?.amount, 4900);
  });

  test("Lyndon's own 0.75% (not Metro's rates copied)", () => {
    assert.equal(local(calculatePaycheck(ky('2026-06-15', { workCity: 'Lyndon' })))?.amount, 1500 + 2900);
  });

  test("Middletown's own 1% since 2024, and St. Matthews' 0.75%", () => {
    assert.equal(local(calculatePaycheck(ky('2026-06-15', { workCity: 'Middletown' })))?.amount, 2000 + 2900);
    assert.equal(local(calculatePaycheck(ky('2026-06-15', { workCity: 'St. Matthews' })))?.amount, 1500 + 2900);
  });

  test('a Jefferson County resident pays the resident rate wherever in the county they live', () => {
    const r = calculatePaycheck(ky('2026-06-15', { workCity: 'Louisville', residenceCity: 'Lyndon' }));
    assert.equal(local(r)?.amount, 4400);
    assert.equal(local(calculatePaycheck(ky('2026-06-15', { workCity: 'Louisville', residenceCounty: 'Jefferson' })))?.amount, 4400);
  });

  test('a Jefferson County city with no tax of its own: Metro only', () => {
    assert.equal(local(calculatePaycheck(ky('2026-06-15', { workCity: 'Lynnview' })))?.amount, 2900);
  });

  test('Augusta corrected to its code\'s 1.30%', () => {
    assert.equal(local(calculatePaycheck(ky('2026-06-15', { workCity: 'Augusta' })))?.amount, 2600);
  });
});
