import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { calculatePaycheck } from '../src/calculate.ts';
import { dollars } from '../src/money.ts';
import type { PaycheckInput } from '../src/types.ts';

/**
 * Oregon 150-206-436: "If single and wages are greater than $100,000 then
 * allowances = 0" and "If married and wages are greater than $200,000 then
 * allowances = 0". A married employee withholding at the single rate follows
 * the single line (the document's Example 4).
 */
const or = (weekly: number, certificate: Record<string, unknown>, checkDate = '2026-09-04'): PaycheckInput => ({
  checkDate,
  payFrequency: 'weekly',
  earnings: [{ code: 'REG', category: 'regular', amount: dollars(weekly) }],
  deductions: [],
  federalW4: { filingStatus: 'single', multipleJobs: false, dependentCredit: 0, otherIncome: 0, deductions: 0, extraWithholding: 0 },
  ytd: { socialSecurity: 0, medicare: 0, futa: 0 },
  workState: { code: 'OR', certificate },
});
const sit = (i: PaycheckInput) => calculatePaycheck(i).taxes.find((t) => t.id === 'OR_SIT')!.amount;

describe('Oregon allowances drop to zero at high wages', () => {
  for (const checkDate of ['2025-09-05', '2026-09-04']) {
    test(`${checkDate}: single, $156,000/yr — 2 allowances change nothing`, () => {
      assert.equal(sit(or(3000, { maritalStatus: 'single', allowances: 2 }, checkDate)), sit(or(3000, { maritalStatus: 'single', allowances: 0 }, checkDate)));
    });
  }
  test('single under $100,000 still gets the credit ($1,500/week = $78,000/yr)', () => {
    assert.ok(sit(or(1500, { maritalStatus: 'single', allowances: 2 })) < sit(or(1500, { maritalStatus: 'single', allowances: 0 })));
  });
  test('single threshold is exclusive: $100,000.16/yr drops the credit, $99,999.64/yr keeps it', () => {
    // 3 allowances moves a single filer to the married-column formula, so compare the credit line, not a 0-allowance run.
    const detail = (weekly: number) => calculatePaycheck(or(weekly, { maritalStatus: 'single', allowances: 3 })).taxes.find((t) => t.id === 'OR_SIT')!.detail;
    assert.match(detail(1923.08), /\(0 × \$263\)/);
    assert.match(detail(1923.07), /\(3 × \$263\)/);
  });
  test('married keeps allowances up to $200,000/yr ($3,000/week = $156,000)', () => {
    assert.ok(sit(or(3000, { maritalStatus: 'married', allowances: 3 })) < sit(or(3000, { maritalStatus: 'married', allowances: 0 })));
  });
  test('married above $200,000/yr gets no credit ($4,500/week = $234,000)', () => {
    assert.equal(sit(or(4500, { maritalStatus: 'married', allowances: 4 })), sit(or(4500, { maritalStatus: 'married', allowances: 0 })));
  });
});
