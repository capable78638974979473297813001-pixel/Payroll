import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { calculatePaycheck } from '../src/calculate.ts';
import type { PaycheckInput } from '../src/types.ts';

/**
 * The 2026-10-06 verification pass on state employer-side numbers: AR
 * new-employer rate, WV SB 1053 (from 2026-07-01), MA's COVID-19 Recovery
 * Assessment, plus the MN backup-withholding and SD range data. Wages are a
 * $1,000 weekly check, so 1% = 1000 cents.
 */

const pay = (state: string, checkDate: string, employer?: PaycheckInput['employer'], ytdSui = 0): PaycheckInput => ({
  checkDate,
  payFrequency: 'weekly',
  earnings: [{ code: 'REG', category: 'regular', amount: 100000 }],
  deductions: [],
  federalW4: { filingStatus: 'single', multipleJobs: false, dependentCredit: 0, otherIncome: 0, deductions: 0, extraWithholding: 0 },
  ytd: { socialSecurity: 0, medicare: 0, futa: 0, ...(ytdSui ? { stateUnemployment: { [state]: ytdSui } } : {}) },
  workState: { code: state },
  ...(employer ? { employer } : {}),
});
const line = (r: ReturnType<typeof calculatePaycheck>, id: string) => r.taxes.find((t) => t.id === id);
const json = (f: string) => JSON.parse(readFileSync(new URL(`../data/states/${f}`, import.meta.url), 'utf8'));

describe('Arkansas new-employer rate', () => {
  test('2.0% all-in for 2026 (stabilization rate included), not 2.2%', () => {
    assert.equal(line(calculatePaycheck(pay('AR', '2026-06-15')), 'AR_SUI_ER')?.amount, 2000);
  });
});

describe('West Virginia SB 1053 (2026-07-01)', () => {
  test('before the effective date: 2.7%, no fee notice', () => {
    const r = calculatePaycheck(pay('WV', '2026-06-26'));
    assert.equal(line(r, 'WV_SUI_ER')?.amount, 2700);
    assert.equal(r.notices, undefined);
  });

  test('from 2026-07-01 the new-employer rate is 2.7% x 0.93 = 2.511%', () => {
    assert.equal(line(calculatePaycheck(pay('WV', '2026-07-01')), 'WV_SUI_ER')?.amount, 2511);
    assert.equal(line(calculatePaycheck(pay('WV', '2026-10-05')), 'WV_SUI_ER')?.amount, 2511);
  });

  test('the annual automation fee is disclosed on the line, not guessed into an amount', () => {
    const r = calculatePaycheck(pay('WV', '2026-07-15'));
    assert.equal(r.notices?.[0].tier, 'not_modelled');
    assert.match(r.notices![0].note, /automation and administration fee/);
    assert.match(r.notices![0].note, /billed to the employer once a year/);
  });

  test("an employer's own supplied rate is used as given", () => {
    assert.equal(line(calculatePaycheck(pay('WV', '2026-07-15', { stateUnemploymentRate: { WV: 0.02 } })), 'WV_SUI_ER')?.amount, 2000);
  });
});

describe('Massachusetts unemployment and COVID-19 Recovery Assessment', () => {
  test('a new employer pays 2.42% and no assessment, with no notice', () => {
    const r = calculatePaycheck(pay('MA', '2026-06-15'));
    assert.equal(line(r, 'MA_SUI_ER')?.amount, 2420);
    assert.equal(line(r, 'MA_SUI_ASSESSMENT_ER'), undefined);
    assert.equal(r.notices, undefined);
  });

  test('a new construction employer pays 6.08%', () => {
    const r = calculatePaycheck(pay('MA', '2026-06-15', { suiIndustry: { MA: 'construction' } }));
    assert.equal(line(r, 'MA_SUI_ER')?.amount, 6080);
  });

  test('an experience-rated employer with its assessment rate gets its own line on the same $15,000 base', () => {
    const r = calculatePaycheck(
      pay('MA', '2026-06-15', { stateUnemploymentRate: { MA: 0.03 }, stateUnemploymentAssessmentRate: { MA: 0.01 } }),
    );
    assert.equal(line(r, 'MA_SUI_ER')?.amount, 3000);
    assert.equal(line(r, 'MA_SUI_ASSESSMENT_ER')?.amount, 1000);
    assert.equal(r.notices, undefined);
  });

  test('the assessment stops at the wage base', () => {
    const r = calculatePaycheck(
      pay('MA', '2026-06-15', { stateUnemploymentRate: { MA: 0.03 }, stateUnemploymentAssessmentRate: { MA: 0.01 } }, 14_500_00),
    );
    assert.equal(line(r, 'MA_SUI_ASSESSMENT_ER')?.amount, 500); // only $500 of the $1,000 is under $15,000
  });

  test('an experience rate with no assessment rate is flagged, not silently short', () => {
    const r = calculatePaycheck(pay('MA', '2026-06-15', { stateUnemploymentRate: { MA: 0.03 } }));
    assert.equal(line(r, 'MA_SUI_ASSESSMENT_ER'), undefined);
    assert.equal(r.notices?.[0].tier, 'not_modelled');
    assert.match(r.notices![0].note, /COVID-19 Recovery Assessment/);
  });

  test('an assessment rate outside the published 0.178%-2.716% range is flagged', () => {
    const r = calculatePaycheck(
      pay('MA', '2026-06-15', { stateUnemploymentRate: { MA: 0.03 }, stateUnemploymentAssessmentRate: { MA: 0.05 } }),
    );
    assert.equal(line(r, 'MA_SUI_ASSESSMENT_ER')?.amount, 5000);
    assert.equal(r.notices?.[0].tier, 'conflicting_sources');
  });
});

describe('data corrections that no engine path reads yet', () => {
  test("Minnesota backup withholding is the state's own 9.85% in both years", () => {
    assert.equal(json('MN-2026.json').otherMinnesotaWithholdingTypes.backupWithholding.rate, 0.0985);
    assert.equal(json('MN-2025.json').otherMinnesotaWithholdingTypes.backupWithholding.rate, 0.0985);
  });

  test('South Dakota 2026 experience range is all-in: 0.08% admin fee floor, 9.39% + 0.08% + 0.53% = 10.00% ceiling', () => {
    const r = json('SD-2026.json').suiEmployer.experienceRange;
    assert.equal(r.min, 0.0008);
    assert.equal(r.max, 0.1);
  });

  test("Hawaii's experience minimum is Schedule C's 0.0%, not the 2.4% new-employer rate", () => {
    const s = json('HI-2026.json').suiEmployer;
    assert.equal(s.experienceRange.min, 0);
    assert.equal(s.newEmployerRate, 0.024);
  });

  test('West Virginia out-of-state construction: 7.5% base + 1% surtax = 8.5% total', () => {
    const c = json('WV-2026.json').unemploymentInsurance.outOfStateConstructionRate;
    assert.equal(c.rate, 0.075);
    assert.equal(c.surtax, 0.01);
    assert.equal(c.total, 0.085);
    assert.match(c.note, /8.5% is the TOTAL/);
  });
});

describe('new-employer rates that are all-in, not the base alone (2026-10-06)', () => {
  test('South Carolina: class 30 total effective rate 1.06% (1.000% + 0.060% contingency)', () => {
    assert.equal(line(calculatePaycheck(pay('SC', '2026-06-15')), 'SC_SUI_ER')?.amount, 1060);
  });

  test('New Jersey: Table C current rate 2.8% (UI 2.6825% + WFD/SWF 0.1175%)', () => {
    assert.equal(line(calculatePaycheck(pay('NJ', '2026-06-15')), 'NJ_SUI_ER')?.amount, 2800);
    assert.equal(line(calculatePaycheck(pay('NJ', '2026-10-05')), 'NJ_SUI_ER')?.amount, 2800);
  });

  test('Virginia: 2.5% base + 0.2% fund building + 0.03% pool cost = 2.73%, with a secondary-source notice', () => {
    const r = calculatePaycheck(pay('VA', '2026-06-15'));
    assert.equal(line(r, 'VA_SUI_ER')?.amount, 2730);
    assert.equal(r.notices?.[0].tier, 'secondary_source');
    assert.match(r.notices![0].note, /fund building/);
  });

  test("Virginia: an employer's own rate-notice total is used as given, with no notice", () => {
    const r = calculatePaycheck(pay('VA', '2026-06-15', { stateUnemploymentRate: { VA: 0.031 } }));
    assert.equal(line(r, 'VA_SUI_ER')?.amount, 3100);
    assert.equal(r.notices, undefined);
  });
});

describe('New Mexico new employers: the greater of the industry average or 1%', () => {
  test('no industry given: the 1% floor, with a notice that the industry rate can be higher', () => {
    const r = calculatePaycheck(pay('NM', '2026-06-15'));
    assert.equal(line(r, 'NM_SUI_ER')?.amount, 1000);
    assert.equal(r.notices?.[0].tier, 'not_modelled');
    assert.match(r.notices![0].note, /greater of its industry/);
  });

  for (const [sector, cents] of [
    ['23', 1210], // construction
    ['construction', 1210],
    ['11', 1190], // agriculture
    ['48-49', 1150],
    ['51', 1080],
    ['92', 1280], // public administration
    ['54', 1000], // professional services: the average is 1.00%
  ] as const) {
    test(`NAICS sector ${sector}: ${cents} cents, no notice`, () => {
      const r = calculatePaycheck(pay('NM', '2026-06-15', { suiIndustry: { NM: sector } }));
      assert.equal(line(r, 'NM_SUI_ER')?.amount, cents);
      assert.equal(r.notices, undefined);
    });
  }
});

describe('employer assessments next to the unemployment tax (2026 data)', () => {
  const tech = 'HI_UI_TECH_ER';
  const et = 'HI_ET_ER';

  test('Hawaii new employer: 2.40% + 0.01% technology + 0.01% employment and training', () => {
    const r = calculatePaycheck(pay('HI', '2026-06-15'));
    assert.equal(line(r, 'HI_SUI_ER')?.amount, 2400);
    assert.equal(line(r, tech)?.amount, 10);
    assert.equal(line(r, et)?.amount, 10);
    assert.equal(r.employerTaxTotal - (r.taxes.filter((t) => t.payer === 'employer' && !t.id.startsWith('HI_')).reduce((s, t) => s + t.amount, 0)), 2420);
  });

  test("Hawaii: an employer at the 0% minimum owes the technology assessment but not E&T", () => {
    const r = calculatePaycheck(pay('HI', '2026-06-15', { stateUnemploymentRate: { HI: 0 } }));
    assert.equal(line(r, 'HI_SUI_ER')?.amount, 0);
    assert.equal(line(r, tech)?.amount, 10);
    assert.equal(line(r, et), undefined);
  });

  test("Hawaii: an employer at the schedule maximum (5.6%) owes the technology assessment but not E&T", () => {
    const r = calculatePaycheck(pay('HI', '2026-06-15', { stateUnemploymentRate: { HI: 0.056 } }));
    assert.equal(line(r, 'HI_SUI_ER')?.amount, 5600);
    assert.equal(line(r, tech)?.amount, 10);
    assert.equal(line(r, et), undefined);
  });

  test('Hawaii: an employer in between owes both', () => {
    const r = calculatePaycheck(pay('HI', '2026-06-15', { stateUnemploymentRate: { HI: 0.012 } }));
    assert.equal(line(r, tech)?.amount, 10);
    assert.equal(line(r, et)?.amount, 10);
  });

  test('Hawaii: the assessments stop at the $64,500 wage base', () => {
    const r = calculatePaycheck(pay('HI', '2026-06-15', undefined, 64_500_00));
    assert.equal(line(r, tech)?.amount, 0);
    assert.equal(line(r, et)?.amount, 0);
  });

  test('New Jersey new employer: UI + WF/SWF 2.8% plus disability insurance 0.5%', () => {
    const r = calculatePaycheck(pay('NJ', '2026-06-15'));
    assert.equal(line(r, 'NJ_SUI_ER')?.amount, 2800);
    assert.equal(line(r, 'NJ_DI_ER')?.amount, 500);
    assert.equal(r.notices, undefined);
  });

  test("New Jersey: with the employer's own unemployment rate the disability rate isn't assumed, and the line says so", () => {
    const r = calculatePaycheck(pay('NJ', '2026-06-15', { stateUnemploymentRate: { NJ: 0.015 } }));
    assert.equal(line(r, 'NJ_SUI_ER')?.amount, 1500);
    assert.equal(line(r, 'NJ_DI_ER'), undefined);
    assert.equal(r.notices?.[0].tier, 'not_modelled');
    assert.match(r.notices![0].note, /Disability Insurance/);
  });

  test('a state without assessments is unchanged (South Carolina: one employer line)', () => {
    const r = calculatePaycheck(pay('SC', '2026-06-15'));
    assert.deepEqual(r.taxes.filter((t) => t.id.startsWith('SC_') && t.payer === 'employer').map((t) => t.id), ['SC_SUI_ER']);
  });
});
