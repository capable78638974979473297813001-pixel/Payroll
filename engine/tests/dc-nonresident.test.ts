import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { calculatePaycheck } from '../src/calculate.ts';
import type { PaycheckInput } from '../src/types.ts';

/**
 * DC does not tax nonresidents' wages at all (Home Rule Act of 1973). A worker
 * whose home state is any other state is a nonresident, with or without the
 * explicit certificate flag.
 */
const pay = (certificate: Record<string, unknown>, residence?: string): PaycheckInput => ({
  checkDate: '2026-10-16',
  payFrequency: 'biweekly',
  earnings: [{ code: 'REG', category: 'regular', amount: 300000 }],
  deductions: [],
  federalW4: { filingStatus: 'single', multipleJobs: false, dependentCredit: 0, otherIncome: 0, deductions: 0, extraWithholding: 0 },
  ytd: { socialSecurity: 0, medicare: 0, futa: 0 },
  workState: { code: 'DC', certificate } as PaycheckInput['workState'],
  ...(residence ? { residenceState: { code: residence } as PaycheckInput['residenceState'] } : {}),
});
const sit = (i: PaycheckInput) => calculatePaycheck(i).taxes.find((t) => t.id === 'DC_SIT')!.amount;

describe('DC withholding and residence', () => {
  test('a worker living in another state is not withheld DC tax, flag or no flag', () => {
    for (const st of ['MD', 'VA', 'NY', 'CA']) {
      assert.equal(sit(pay({}, st)), 0, st);
      assert.equal(sit(pay({ nonresident: true }, st)), 0, st);
    }
  });

  test('a DC resident is withheld DC tax', () => {
    assert.ok(sit(pay({}, 'DC')) > 0);
    assert.ok(sit(pay({})) > 0, 'no residenceState given: treated as a DC resident, as before');
  });

  test('the inferred case says so on the line', () => {
    const line = calculatePaycheck(pay({}, 'MD')).taxes.find((t) => t.id === 'DC_SIT')!;
    assert.match(line.detail ?? '', /inferred from residenceState MD/);
  });
});
