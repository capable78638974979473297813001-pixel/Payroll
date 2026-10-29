import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { calculatePaycheck } from '../src/calculate.ts';
import { AlabamaInputError, calculateAlabamaPaycheck } from '../src/alabama/index.ts';
import { yearOf } from '../src/registry.ts';
import type { PaycheckInput } from '../src/types.ts';

const W4 = { filingStatus: 'single', multipleJobs: false, dependentCredit: 0, otherIncome: 0, deductions: 0, extraWithholding: 0 } as const;

function paycheck(overrides: Partial<PaycheckInput> = {}): PaycheckInput {
  return {
    checkDate: '2026-06-15',
    payFrequency: 'biweekly',
    earnings: [{ code: 'REG', category: 'regular', amount: 300_000 }],
    deductions: [],
    federalW4: { ...W4 },
    ytd: { socialSecurity: 0, medicare: 0, futa: 0 },
    workState: { code: 'TX', certificate: {} },
    ...overrides,
  };
}

const federalTotal = (input: PaycheckInput) =>
  calculatePaycheck(input).taxes.filter((t) => t.jurisdiction === 'federal').reduce((s, t) => s + t.amount, 0);
const stateLines = (input: PaycheckInput, prefix: string) =>
  calculatePaycheck(input).taxes.filter((t) => t.id.startsWith(prefix));

describe('employmentCategory is validated', () => {
  test('a misspelled category is refused instead of inheriting the clergy exemption', () => {
    assert.equal(federalTotal(paycheck()), 79_738);
    assert.throws(
      () => calculatePaycheck(paycheck({ employmentCategory: 'typo' as never })),
      /Unrecognized employmentCategory "typo"/,
    );
  });

  test('every real category still calculates', () => {
    for (const c of ['standard', 'clergy', 'statutory_employee', 'household', 'agricultural', 'railroad', 'election_worker'] as const) {
      assert.doesNotThrow(() => calculatePaycheck(paycheck({ employmentCategory: c })), c);
    }
    assert.equal(federalTotal(paycheck({ employmentCategory: 'clergy' })), 0);
  });
});

describe('check dates must be real days', () => {
  test('2026-02-30 and 2026-99-99 are refused; real dates, including a leap day, are accepted', () => {
    assert.throws(() => calculatePaycheck(paycheck({ checkDate: '2026-02-30' })), /real calendar date/);
    assert.throws(() => calculatePaycheck(paycheck({ checkDate: '2026-99-99' })), /real calendar date/);
    assert.throws(() => calculatePaycheck(paycheck({ checkDate: '2026-02-29' })), /real calendar date/);
    assert.doesNotThrow(() => calculatePaycheck(paycheck({ checkDate: '2026-02-28' })));
    assert.equal(yearOf('2028-02-29'), 2028); // a real leap day
    assert.throws(() => yearOf('2100-02-29'), /real calendar date/); // 2100 is not a leap year
  });
});

describe('residence-state withholding', () => {
  test('a Kansas resident working in Texas with nexus is withheld once, not twice', () => {
    const base = paycheck({ residenceState: { code: 'KS', certificate: {} } });
    const without = stateLines(base, 'KS');
    const withNexus = stateLines({ ...base, residenceStateWithholding: { nexus: true } }, 'KS');
    assert.equal(without.length, 1);
    assert.equal(withNexus.length, 1);
    assert.equal(withNexus[0].amount, without[0].amount);
  });

  test('residence-state elections (additional withholding, exempt) apply to the residence line', () => {
    const ca = (certificate: Record<string, unknown>) =>
      stateLines(
        paycheck({ residenceState: { code: 'CA', certificate }, residenceStateWithholding: { nexus: true } }),
        'CA_SIT',
      )[0].amount;
    const plain = ca({});
    assert.ok(plain > 0);
    assert.equal(ca({ additionalWithholding: 5_000 }), plain + 5_000);
    assert.equal(ca({ exempt: true }), 0);
  });
});

describe('Alabama adapter', () => {
  const alabama = (extra: Record<string, unknown> = {}) => ({
    checkDate: '2026-03-13',
    payFrequency: 'weekly' as const,
    earnings: { regular: 1000 },
    ...extra,
  });

  test('a string "false" for an exempt flag is refused, not read as true', () => {
    for (const extra of [
      { federalW4: { exempt: 'false' } },
      { a4: { exempt: 'false' } },
      { federalW4: { nonresidentAlien: 'false' } },
      { federalW4: { multipleJobs: 'true' } },
      { employer: { useFivePercentSupplementalRate: 'false' } },
    ]) {
      assert.throws(() => calculateAlabamaPaycheck(alabama(extra) as never), AlabamaInputError, JSON.stringify(extra));
    }
    const plain = calculateAlabamaPaycheck(alabama() as never);
    const explicit = calculateAlabamaPaycheck(alabama({ federalW4: { exempt: false } }) as never);
    assert.equal(explicit.netPay.cents, plain.netPay.cents);
    const exempt = calculateAlabamaPaycheck(alabama({ federalW4: { exempt: true } }) as never);
    assert.ok(exempt.netPay.cents > plain.netPay.cents);
  });

  test('an impossible check date is refused', () => {
    assert.throws(() => calculateAlabamaPaycheck(alabama({ checkDate: '2026-02-30' }) as never), AlabamaInputError);
  });

  test('the engine\'s warnings reach the Alabama output (provisional rules, negative net pay)', () => {
    const out = calculateAlabamaPaycheck(alabama({ checkDate: '2027-03-12' }) as never);
    assert.ok(out.warnings.some((w) => /provisional/i.test(w)), out.warnings.join(' | '));

    const negative = calculateAlabamaPaycheck(
      alabama({ earnings: { regular: 100 }, deductions: [{ code: 'LOAN', category: 'posttax', amount: 500 }] }) as never,
    );
    assert.ok(negative.warnings.some((w) => /Net pay is negative/.test(w)), negative.warnings.join(' | '));
  });
});
