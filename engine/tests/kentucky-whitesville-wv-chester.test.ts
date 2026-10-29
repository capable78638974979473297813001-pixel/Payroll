import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { calculatePaycheck } from '../src/calculate.ts';
import type { PaycheckInput } from '../src/types.ts';

/**
 * Two local jurisdictions the daily source watch (2026-10-25) found missing:
 * Whitesville KY (new 1.15% occupational tax from 2027-01-01, per the city's
 * Form E-1 / RU-1Q) and Chester WV ($2/week user fee on non-resident workers
 * employed 30+ days a year, per WVU Shared Services' ordinance list).
 */

const base = (checkDate: string, payFrequency: PaycheckInput['payFrequency'], amount: number, workState: PaycheckInput['workState']): PaycheckInput => ({
  checkDate,
  payFrequency,
  earnings: [{ code: 'REG', category: 'regular', amount }],
  deductions: [],
  federalW4: { filingStatus: 'single', multipleJobs: false, dependentCredit: 0, otherIncome: 0, deductions: 0, extraWithholding: 0 },
  ytd: { socialSecurity: 0, medicare: 0, futa: 0 },
  workState,
});

describe('Whitesville, Kentucky (Daviess County)', () => {
  const ky = (checkDate: string) => calculatePaycheck(base(checkDate, 'monthly', 300_000, { code: 'KY', certificate: { workCity: 'Whitesville' } } as PaycheckInput['workState']));
  const local = (r: ReturnType<typeof calculatePaycheck>) => r.taxes.find((t) => t.id === 'KY_LOCAL');

  test('no city occupational tax before 2027-01-01', () => {
    assert.equal(local(ky('2026-12-15'))?.amount ?? 0, 0);
  });

  test('1.15% from 2027-01-01 ($34.50 on $3,000)', () => {
    assert.equal(local(ky('2027-01-15'))?.amount, 3_450);
  });
});

describe('Chester, West Virginia user fee', () => {
  const wv = (certificate: Record<string, unknown>, year = '2026-10-16') =>
    calculatePaycheck(base(year, 'weekly', 80_000, { code: 'WV', certificate } as PaycheckInput['workState']));
  const fee = (r: ReturnType<typeof calculatePaycheck>) => r.taxes.find((t) => t.id === 'WV_LOCAL_FEE')?.amount;

  test('a non-resident working there is charged $2.00 a week', () => {
    assert.equal(fee(wv({ locality: 'Chester' })), 200);
    assert.equal(fee(wv({ locality: 'Chester', residenceCity: 'Weirton' })), 200);
  });

  test('a Chester resident is not charged', () => {
    assert.equal(fee(wv({ locality: 'Chester', residenceCity: 'Chester' })), undefined);
  });

  test('the fee attaches only after 30 days worked in the year', () => {
    assert.equal(fee(wv({ locality: 'Chester', daysWorkedInLocality: 29 })), undefined);
    assert.equal(fee(wv({ locality: 'Chester', daysWorkedInLocality: 30 })), 200);
  });

  test('2025 and 2027 files carry the same fee', () => {
    assert.equal(fee(wv({ locality: 'Chester' }, '2025-10-16')), 200);
    assert.equal(fee(wv({ locality: 'Chester' }, '2027-02-16')), 200);
  });
});
