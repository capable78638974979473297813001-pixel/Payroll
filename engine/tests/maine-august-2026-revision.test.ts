import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { calculatePaycheck } from '../src/calculate.ts';
import { dollars } from '../src/money.ts';
import type { PaycheckInput } from '../src/types.ts';

/**
 * Maine Revenue Services' 2026 withholding booklet, revised August 2026:
 * standard deduction for withholding $12,850 / $28,550 and a 2% surcharge on
 * annualized income over $1,000,000 (single) / $1,500,000 (married). Examples
 * 2 and 3 are the booklet's own worked examples.
 */
const me = (checkDate: string, weekly: number, certificate: Record<string, unknown>): PaycheckInput => ({
  checkDate,
  payFrequency: 'weekly',
  earnings: [{ code: 'REG', category: 'regular', amount: dollars(weekly) }],
  deductions: [],
  federalW4: { filingStatus: 'single', multipleJobs: false, dependentCredit: 0, otherIncome: 0, deductions: 0, extraWithholding: 0 },
  ytd: { socialSecurity: 0, medicare: 0, futa: 0 },
  workState: { code: 'ME', certificate },
});
const sit = (i: PaycheckInput) => calculatePaycheck(i).taxes.find((t) => t.id === 'ME_SIT')!.amount;

describe('Maine August 2026 booklet', () => {
  test('Example 2: single $1,000/week, 2 allowances -> $32', () => {
    assert.equal(sit(me('2026-09-04', 1000, { maritalStatus: 'single', allowances: 2 })), dollars(32));
  });
  test('Example 3: married $4,500/week, 2 allowances, phase-out band -> $256', () => {
    assert.equal(sit(me('2026-09-04', 4500, { maritalStatus: 'married', allowances: 2 })), dollars(256));
  });
  test('checks before 2026-08-01 keep the earlier booklet ($12,450 deduction)', () => {
    // 52,000 - 10,600 - 12,450 = 28,950 -> 1,589 + 6.75% x 1,550 = 1,694 -> /52 = 32.58 -> $33
    assert.equal(sit(me('2026-07-31', 1000, { maritalStatus: 'single', allowances: 2 })), dollars(33));
  });
  test('single surcharge: $30,000/week -> 2% on annualized income above $1,000,000', () => {
    // 1,560,000 annualized, no deduction: 4,117 + 7.15% x 1,495,150 = 111,020.6; surcharge 2% x 560,000 = 11,200
    // total 122,220.6 -> 122,221; / 52 = 2,350.4 -> $2,350
    assert.equal(sit(me('2026-09-04', 30000, { maritalStatus: 'single', allowances: 0 })), dollars(2350));
  });
  test('married threshold is $1,500,000: $30,000/week married pays surcharge only on the excess over it', () => {
    // 8,237 + 7.15% x 1,430,250 = 110,500.9; surcharge 2% x 60,000 = 1,200 -> 111,700.9 -> 111,701; / 52 = 2,148.1 -> $2,148
    assert.equal(sit(me('2026-09-04', 30000, { maritalStatus: 'married', allowances: 0 })), dollars(2148));
  });
  test('no surcharge below the threshold', () => {
    // $10,000/week -> 520,000: 4,117 + 7.15% x 455,150 = 36,659.2... -> 36,660? whole-dollar rounding; /52
    const base = sit(me('2026-09-04', 10000, { maritalStatus: 'single', allowances: 0 }));
    assert.equal(base, dollars(Math.round(Math.round(4117 + 0.0715 * (520000 - 64850)) / 52)));
  });
});
