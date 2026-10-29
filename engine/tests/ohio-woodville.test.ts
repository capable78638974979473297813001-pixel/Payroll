import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { calculatePaycheck } from '../src/calculate.ts';
import { dollars } from '../src/money.ts';
import { ohMunicipalityRuleset } from '../src/registry.ts';
import type { PaycheckInput } from '../src/types.ts';

/**
 * Village of Woodville, Ohio (Sandusky County). Ordinance passed 2026-02-09,
 * effective 2026-07-01, rate 1%. The 2026 file uses rateHistory — a 0 rate
 * from 2026-01-01, then 1% from 2026-07-01 — the same mid-year mechanism as
 * North Hampton's July 2025 start. effectiveFrom is stored but not read for
 * municipalities. Tax year 2027 carries the 1% rate with no in-year history.
 *
 * Biweekly $4,000 of qualifying wages. 1% withholds $40.00.
 */

const paycheck = (checkDate: string): PaycheckInput => ({
  checkDate,
  payFrequency: 'biweekly',
  earnings: [{ code: 'REG', category: 'regular', amount: dollars(4000) }],
  deductions: [],
  federalW4: {
    filingStatus: 'single',
    multipleJobs: false,
    dependentCredit: 0,
    otherIncome: 0,
    deductions: 0,
    extraWithholding: 0,
  },
  ytd: { socialSecurity: 0, medicare: 0, futa: 0 },
  workState: {
    code: 'OH',
    certificate: { workCity: 'Woodville', residenceCity: 'Woodville' },
  } as PaycheckInput['workState'],
});

const local = (checkDate: string) =>
  calculatePaycheck(paycheck(checkDate)).taxes.find((t) => t.id === 'OH_LOCAL');

describe('Woodville, Ohio municipal income tax', () => {
  test('withholds nothing on a 2026 pay date before July 1', () => {
    const entry = ohMunicipalityRuleset('Woodville', '2026-06-30');
    assert.ok(entry, 'Woodville is on the 2026 municipality list');
    assert.equal(entry.rate, 0);
    const line = local('2026-06-30');
    assert.equal(line?.amount ?? 0, 0);
    if (line) {
      assert.match(line.detail, /Woodville/);
      assert.match(line.detail, /0\.00%/);
    }
  });

  test('withholds 1% on a pay date of 2026-07-01 and later in 2026', () => {
    assert.equal(ohMunicipalityRuleset('Woodville', '2026-07-01')?.rate, 0.01);
    const on = local('2026-07-01');
    assert.ok(on, 'expected an OH_LOCAL line on the effective date');
    assert.equal(on.amount, dollars(40));
    assert.match(on.detail, /Woodville/);
    assert.match(on.detail, /1\.00%/);

    assert.equal(ohMunicipalityRuleset('Woodville', '2026-12-18')?.rate, 0.01);
    assert.equal(local('2026-12-18')?.amount, dollars(40));
  });

  test('has no Woodville line in tax year 2025, before the tax existed', () => {
    assert.equal(ohMunicipalityRuleset('Woodville', '2025-08-15'), undefined);
    assert.equal(local('2025-08-15'), undefined);
  });

  test('is present at 1% for tax year 2027', () => {
    assert.equal(ohMunicipalityRuleset('Woodville', '2027-01-15')?.rate, 0.01);
    const line = local('2027-01-15');
    assert.ok(line, 'expected an OH_LOCAL line in 2027');
    assert.equal(line.amount, dollars(40));
    assert.match(line.detail, /Woodville/);
    assert.match(line.detail, /1\.00%/);
  });
});
