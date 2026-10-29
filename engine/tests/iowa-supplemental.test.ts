import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { calculatePaycheck } from '../src/calculate.ts';
import { dollars } from '../src/money.ts';
import type { PaycheckInput } from '../src/types.ts';

/**
 * Iowa Department of Revenue: "If federal income tax is withheld on a flat
 * rate basis, Iowa income tax is required to be withheld at the highest rate
 * applicable to individuals (3.8%). However, if the supplemental wage payment
 * is included with the regular wage payment, the two are combined and the
 * withholding tables or formulas are used." (IAC 701-307.2(1)"c")
 */
const iowa = (checkDate: string, earnings: PaycheckInput['earnings']): PaycheckInput => ({
  checkDate,
  payFrequency: 'weekly',
  earnings,
  deductions: [],
  federalW4: { filingStatus: 'single', multipleJobs: false, dependentCredit: 0, otherIncome: 0, deductions: 0, extraWithholding: 0 },
  ytd: { socialSecurity: 0, medicare: 0, futa: 0 },
  workState: { code: 'IA', certificate: {} },
});
const line = (r: ReturnType<typeof calculatePaycheck>, id: string) => r.taxes.find((t) => t.id === id)?.amount;

describe('Iowa supplemental wages', () => {
  for (const date of ['2025-09-05', '2026-09-04']) {
    test(`${date}: a bonus paid on its own cheque is withheld at a flat 3.8%`, () => {
      const r = calculatePaycheck(iowa(date, [{ code: 'BON', category: 'supplemental', amount: dollars(1000) }]));
      assert.equal(line(r, 'IA_SIT_SUPP'), dollars(38));
    });
  }
  test('a bonus paid with regular wages goes through the withholding formula, not the flat rate', () => {
    const r = calculatePaycheck(
      iowa('2026-09-04', [
        { code: 'REG', category: 'regular', amount: dollars(1000) },
        { code: 'BON', category: 'supplemental', amount: dollars(1000) },
      ]),
    );
    assert.equal(line(r, 'IA_SIT_SUPP'), undefined);
    // (2,000 - 250 standard deduction) x 3.8% = 66.50
    assert.equal(line(r, 'IA_SIT'), dollars(66.5));
  });
});
