import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { calculatePaycheck } from '../src/calculate.ts';
import { capElectiveDeferrals } from '../src/wages.ts';
import { federalRuleset } from '../src/registry.ts';
import { calculateAlabamaPaycheck } from '../src/alabama/index.ts';
import type { PaycheckInput } from '../src/types.ts';

const W4 = { filingStatus: 'single', multipleJobs: false, dependentCredit: 0, otherIncome: 0, deductions: 0, extraWithholding: 0 } as const;
const input = (over: Partial<PaycheckInput> & { workCode?: string; certificate?: Record<string, unknown> } = {}): PaycheckInput => {
  const { workCode = 'TX', certificate = {}, ...rest } = over;
  return {
    checkDate: '2026-06-15',
    payFrequency: 'biweekly',
    earnings: [{ code: 'REG', category: 'regular', amount: 300_000 }],
    deductions: [],
    federalW4: { ...W4 },
    ytd: { socialSecurity: 0, medicare: 0, futa: 0 },
    workState: { code: workCode, certificate },
    ...rest,
  } as PaycheckInput;
};
const line = (r: ReturnType<typeof calculatePaycheck>, id: string) => r.taxes.find((t) => t.id === id);

describe('Minnesota employer paid-leave contribution', () => {
  test('a standard employer owes 0.44% on top of the employee\'s 0.44% ($13.20 each on $3,000)', () => {
    const r = calculatePaycheck(input({ workCode: 'MN' }));
    assert.equal(line(r, 'MN_PFML_EE')!.amount, 1_320);
    const er = line(r, 'MN_PFML_ER')!;
    assert.equal(er.payer, 'employer');
    assert.equal(er.amount, 1_320);
  });

  test('an employer DEED has designated small owes 0.22% ($6.60); the employee still pays 0.44%', () => {
    const r = calculatePaycheck(input({ workCode: 'MN', employer: { paidLeaveTier: { MN: 'small' } } }));
    assert.equal(line(r, 'MN_PFML_EE')!.amount, 1_320);
    assert.equal(line(r, 'MN_PFML_ER')!.amount, 660);
  });

  test('the employer share does not change what the employee is paid, and an exempt employee generates neither', () => {
    const plain = calculatePaycheck(input({ workCode: 'MN' }));
    const withoutEr = plain.employeeTaxTotal;
    assert.equal(plain.netPay, 300_000 - withoutEr);
    const exempt = calculatePaycheck(input({ workCode: 'MN', certificate: { paidLeaveExempt: true } }));
    assert.equal(line(exempt, 'MN_PFML_EE')!.amount, 0); // an explicit $0 line, as before
    assert.equal(line(exempt, 'MN_PFML_ER'), undefined); // no premium, so no employer share
  });

  test('it stops at the wage cap: $192,000 in 2027, $185,000 in 2026', () => {
    const annual = (checkDate: string) =>
      calculatePaycheck(input({ checkDate, workCode: 'MN', payFrequency: 'annual', earnings: [{ code: 'REG', category: 'regular', amount: 30_000_000 }] }));
    assert.equal(line(annual('2026-06-15'), 'MN_PFML_ER')!.amount, 81_400); // 185,000 x 0.44%
    assert.equal(line(annual('2027-06-15'), 'MN_PFML_ER')!.amount, 84_480); // 192,000 x 0.44%
  });

  test('a state with no tier configuration is unaffected by the new defaultTier/employeeRate fields', () => {
    const wa = calculatePaycheck(input({ workCode: 'WA', certificate: { employerLiableForPaidLeaveShare: true } }));
    assert.equal(line(wa, 'WA_PFML_ER')!.amount, 969); // 1.13% of $3,000 = 33.90, less employee 24.21
  });
});

describe('SIMPLE deferrals count toward the combined 402(g) limit', () => {
  const limits = { section402gAggregate: 24_500, deferral457: 24_500, simple: 17_000 };
  const cents = (d: number) => d * 100;

  test('with $20,000 already counted, only $4,500 of a $10,000 SIMPLE contribution is pretax', () => {
    const out = capElectiveDeferrals([{ code: 'S', category: 'deferral_simple', amount: cents(10_000) }], { section402gAggregate: cents(20_000) }, limits);
    assert.deepEqual(out.map((d) => [d.code, d.category, d.amount]), [['S', 'deferral_simple', cents(4_500)], ['S_OVER_LIMIT', null, cents(5_500)]]);
  });
  test('the SIMPLE plan\'s own lower limit still applies when the combined limit has room', () => {
    const out = capElectiveDeferrals([{ code: 'S', category: 'deferral_simple', amount: cents(20_000) }], {}, limits);
    assert.deepEqual(out.map((d) => [d.category, d.amount]), [['deferral_simple', cents(17_000)], [null, cents(3_000)]]);
  });
  test('a 457(b) deferral is not drawn from the combined limit', () => {
    const out = capElectiveDeferrals([{ code: 'G', category: 'deferral_457', amount: cents(10_000) }], { section402gAggregate: cents(24_500) }, limits);
    assert.deepEqual(out.map((d) => [d.category, d.amount]), [['deferral_457', cents(10_000)]]);
  });
});

describe('Washington Court House local tax follows the year\'s rate', () => {
  const wch = (checkDate: string) =>
    line(calculatePaycheck(input({ checkDate, workCode: 'OH', certificate: { workCity: 'Washington' } })), 'OH_LOCAL')!.amount;
  test('1.95% in 2025, 1.75% from 2026-01-01', () => {
    assert.equal(wch('2025-06-15'), 5_850);
    assert.equal(wch('2026-06-15'), 5_250);
    assert.equal(wch('2027-06-15'), 5_250);
  });
});

describe('2027 figures published since the carry-forward', () => {
  test('Social Security: $192,300 base, so $11,922.60 on a large annual wage', () => {
    const ruleset = federalRuleset('2027-06-15');
    assert.equal(ruleset.socialSecurity.wageBase, 192_300);
    const r = calculatePaycheck(input({ checkDate: '2027-06-15', payFrequency: 'annual', earnings: [{ code: 'REG', category: 'regular', amount: 30_000_000 }] }));
    assert.equal(line(r, 'US_SS_EE')!.amount, 1_192_260);
    assert.equal(line(r, 'US_SS_ER')!.amount, 1_192_260);
  });

  test('household $3,100 and election-worker $2,700 coverage thresholds; railroad Tier II $142,800', () => {
    const f = federalRuleset('2027-06-15') as unknown as {
      employmentCategories: { coverageThresholds: { household: { annualCashWages: number }; electionWorker: { annualCashWages: number } } };
      railroadRetirement: { tier2: { wageBase: number }; ruia: { monthlyCompensationBase: number } };
    };
    assert.equal(f.employmentCategories.coverageThresholds.household.annualCashWages, 3_100);
    assert.equal(f.employmentCategories.coverageThresholds.electionWorker.annualCashWages, 2_700);
    assert.equal(f.railroadRetirement.tier2.wageBase, 142_800);
    assert.equal(f.railroadRetirement.ruia.monthlyCompensationBase, 2_235);
  });

  test('2026 is untouched by the 2027 updates', () => {
    const f = federalRuleset('2026-06-15') as unknown as {
      socialSecurity: { wageBase: number };
      employmentCategories: { coverageThresholds: { household: { annualCashWages: number } } };
      railroadRetirement: { tier2: { wageBase: number } };
    };
    assert.equal(f.socialSecurity.wageBase, 184_500);
    assert.equal(f.employmentCategories.coverageThresholds.household.annualCashWages, 3_000);
    assert.equal(f.railroadRetirement.tier2.wageBase, 137_100);
  });

  test('Washington paid leave: 1.2% total, employee 70.7% (2027) against 1.13% / 71.43% (2026)', () => {
    const wa = (checkDate: string) => {
      const r = calculatePaycheck(input({ checkDate, workCode: 'WA', certificate: { employerLiableForPaidLeaveShare: true } }));
      return [line(r, 'WA_PFML_EE')!.amount, line(r, 'WA_PFML_ER')!.amount];
    };
    assert.deepEqual(wa('2026-06-15'), [2_421, 969]); // 33.90 total
    assert.deepEqual(wa('2027-06-15'), [2_545, 1_055]); // 36.00 total: 25.452 employee -> 25.45, 10.55 employer
  });

  test('Kentucky: the 2027 standard deduction is $3,470', () => {
    const ky = (checkDate: string) =>
      line(calculatePaycheck(input({ checkDate, workCode: 'KY', payFrequency: 'annual', earnings: [{ code: 'REG', category: 'regular', amount: 5_000_000 }] })), 'KY_SIT')!.amount;
    assert.equal(ky('2026-06-15'), Math.round((5_000_000 - 336_000) * 0.035));
    assert.equal(ky('2027-06-15'), Math.round((5_000_000 - 347_000) * 0.035));
  });

  test('the Alabama "no YTD" notice quotes the check date\'s own Social Security base, not a fixed figure', () => {
    const warn = (checkDate: string) =>
      calculateAlabamaPaycheck({ checkDate, payFrequency: 'weekly', earnings: { regular: 1000 } } as never).warnings.find((w) => /year-to-date/.test(w)) ?? '';
    assert.match(warn('2026-03-13'), /\$184,500 base/);
    assert.match(warn('2027-03-12'), /\$192,300 base/);
  });
});
