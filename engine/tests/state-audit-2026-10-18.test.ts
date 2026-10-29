import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { calculatePaycheck } from '../src/calculate.ts';
import { dollars } from '../src/money.ts';
import type { PaycheckInput } from '../src/types.ts';

/** Arkansas flat bonus method and Pennsylvania commuter deductions. */
const base = (state: string, checkDate: string, over: Partial<PaycheckInput> = {}): PaycheckInput => ({
  checkDate,
  payFrequency: 'weekly',
  earnings: [{ code: 'REG', category: 'regular', amount: dollars(1000) }],
  deductions: [],
  federalW4: { filingStatus: 'single', multipleJobs: false, dependentCredit: 0, otherIncome: 0, deductions: 0, extraWithholding: 0 },
  ytd: { socialSecurity: 0, medicare: 0, futa: 0 },
  workState: { code: state, certificate: {} },
  ...over,
});
const amt = (r: ReturnType<typeof calculatePaycheck>, id: string) => r.taxes.find((t) => t.id === id)?.amount;

describe('Arkansas bonus (DFA Withholding Tax Instructions, rev. 4/27/26)', () => {
  test('a $1,000 bonus paid with regular wages is withheld at a flat 3.7%', () => {
    const r = calculatePaycheck(
      base('AR', '2026-09-04', {
        earnings: [
          { code: 'REG', category: 'regular', amount: dollars(1000) },
          { code: 'BON', category: 'supplemental', amount: dollars(1000) },
        ],
      }),
    );
    assert.equal(amt(r, 'AR_SIT_SUPP'), dollars(37));
  });
  test('2025 used the 3.9% top rate', () => {
    const r = calculatePaycheck(base('AR', '2025-09-05', { earnings: [{ code: 'BON', category: 'supplemental', amount: dollars(1000) }] }));
    assert.equal(amt(r, 'AR_SIT_SUPP'), dollars(39));
  });
});

describe('Pennsylvania commuter deductions (REV-415)', () => {
  test('a salary-reduction commuter deduction does not lower PA taxable wages; an HSA one does', () => {
    const plain = amt(calculatePaycheck(base('PA', '2026-09-04')), 'PA_SIT')!;
    const commuter = amt(calculatePaycheck(base('PA', '2026-09-04', { deductions: [{ code: 'TRN', category: 'commuter', amount: dollars(100) }] })), 'PA_SIT')!;
    const hsa = amt(calculatePaycheck(base('PA', '2026-09-04', { deductions: [{ code: 'HSA', category: 'hsa', amount: dollars(100) }] })), 'PA_SIT')!;
    assert.equal(commuter, plain);
    assert.equal(plain, dollars(30.7));
    assert.equal(hsa, dollars(27.63));
  });
});

describe('Alaska new-employer rate (labor.alaska.gov 2026 industry table)', () => {
  test('employer pays 1.00% and the employee 0.50% (1.50% total)', () => {
    const r = calculatePaycheck(base('AK', '2026-09-04'));
    assert.equal(amt(r, 'AK_SUI_ER'), dollars(10));
    assert.equal(amt(r, 'AK_UC_EE'), dollars(5));
  });
});
