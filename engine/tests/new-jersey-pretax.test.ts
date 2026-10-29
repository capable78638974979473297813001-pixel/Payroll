import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { calculatePaycheck } from '../src/calculate.ts';
import type { PaycheckInput } from '../src/types.ts';

/**
 * NJ-WT (September 2025), "Compensation Not Subject to Withholding": 401(k)
 * contributions up to the federal limit and commuter transportation benefits.
 * Subject to withholding: contributions to retirement plans other than a
 * 401(k), cafeteria-plan salary reductions (TB-39(R)), HSA and dependent care.
 */
const pay = (checkDate: string, gross: number, deductions: PaycheckInput['deductions'] = []): PaycheckInput => ({
  checkDate,
  payFrequency: 'biweekly',
  earnings: [{ code: 'REG', category: 'regular', amount: gross }],
  deductions,
  federalW4: { filingStatus: 'single', multipleJobs: false, dependentCredit: 0, otherIncome: 0, deductions: 0, extraWithholding: 0 },
  ytd: { socialSecurity: 0, medicare: 0, futa: 0 },
  workState: { code: 'NJ' } as PaycheckInput['workState'],
});
const sit = (r: ReturnType<typeof calculatePaycheck>) => r.taxes.find((t) => t.id === 'NJ_SIT')!.amount;

for (const date of ['2025-06-13', '2026-10-16']) {
  describe(`New Jersey pre-tax treatment (${date.slice(0, 4)})`, () => {
    const full = sit(calculatePaycheck(pay(date, 300000)));
    const reduced = sit(calculatePaycheck(pay(date, 280000)));

    for (const category of ['deferral_401k', 'commuter'] as const) {
      test(`${category} comes out of the NJ withholding base`, () => {
        const r = calculatePaycheck(pay(date, 300000, [{ code: 'D', category, amount: 20000 }]));
        assert.equal(sit(r), reduced);
        assert.ok(sit(r) < full);
      });
    }

    for (const category of ['section125', 'fsa', 'hsa', 'dependent_care', 'deferral_403b', 'deferral_457', 'deferral_simple'] as const) {
      test(`${category} stays in the NJ withholding base`, () => {
        const r = calculatePaycheck(pay(date, 300000, [{ code: 'D', category, amount: 20000 }]));
        assert.equal(sit(r), full);
      });
    }
  });
}
