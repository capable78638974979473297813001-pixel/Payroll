import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { dollars } from '../src/money.ts';
import { computeForm940, computeForm941, computeW2, computeW2FromEmployee } from '../payroll/filings.ts';
import { approvePayRun, draftPayRun, freshYearToDate, generatePayPeriods } from '../payroll/index.ts';
import type { Company, DeductionPlan, Employee, PayRun, PayRunLine } from '../payroll/types.ts';

/**
 * Two testing styles, same split this project uses elsewhere: hand-built
 * synthetic PayRun/PayRunLine fixtures prove the ROLLUP arithmetic itself
 * (which fields get summed into which box, dedup rules, quarter/year
 * filtering) with numbers chosen to make a wrong sum obvious; a real
 * multi-period run through the actual engine (below) proves the two
 * modules actually wire together correctly end to end.
 */

function line(overrides: Partial<PayRunLine> & { employeeId: string }): PayRunLine {
  return {
    grossPay: 0,
    netPay: 0,
    employeeTaxTotal: 0,
    employerTaxTotal: 0,
    pretaxDeductions: 0,
    posttaxDeductions: 0,
    garnishmentTotal: 0,
    netPayAfterGarnishment: 0,
    taxLines: [],
    garnishmentLines: [],
    depositAllocations: [],
    ...overrides,
  };
}

function run(overrides: Partial<PayRun> & { id: string; checkDate: string; lines: PayRunLine[] }): PayRun {
  return {
    companyId: 'co-1',
    periodStart: '2026-01-01',
    periodEnd: '2026-01-14',
    status: 'approved',
    createdAt: '2026-01-01T00:00:00Z',
    minimumWageIssues: [],
    ...overrides,
  };
}

describe('Form 941 quarterly rollup (payroll/filings.ts)', () => {
  test('sums FIT/SS/Medicare wages and taxes ONLY from runs whose check date falls in the requested quarter', () => {
    const q1Run = run({
      id: 'r1',
      checkDate: '2026-02-15', // Q1
      periodStart: '2026-02-01',
      periodEnd: '2026-02-14',
      lines: [
        line({
          employeeId: 'e1',
          taxLines: [
            { id: 'US_FIT', name: 'Federal Income Tax', payer: 'employee', jurisdiction: 'federal', taxableWages: dollars(2_000), amount: dollars(200) },
            { id: 'US_SS_EE', name: 'Social Security', payer: 'employee', jurisdiction: 'federal', taxableWages: dollars(2_000), amount: dollars(124) },
            { id: 'US_SS_ER', name: 'Social Security (Employer)', payer: 'employer', jurisdiction: 'federal', taxableWages: dollars(2_000), amount: dollars(124) },
            { id: 'US_MED_EE', name: 'Medicare', payer: 'employee', jurisdiction: 'federal', taxableWages: dollars(2_000), amount: dollars(29) },
            { id: 'US_MED_ER', name: 'Medicare (Employer)', payer: 'employer', jurisdiction: 'federal', taxableWages: dollars(2_000), amount: dollars(29) },
          ],
        }),
      ],
    });
    const q2Run = run({
      id: 'r2',
      checkDate: '2026-04-15', // Q2 — must NOT be counted
      lines: [
        line({
          employeeId: 'e1',
          taxLines: [{ id: 'US_FIT', name: 'Federal Income Tax', payer: 'employee', jurisdiction: 'federal', taxableWages: dollars(999_999), amount: dollars(999_999) }],
        }),
      ],
    });

    const summary = computeForm941('co-1', 2026, 1, [q1Run, q2Run]);
    assert.equal(summary.wagesTipsOtherCompensation, dollars(2_000));
    assert.equal(summary.federalIncomeTaxWithheld, dollars(200));
    assert.equal(summary.taxableSocialSecurityWages, dollars(2_000), 'wages come from the EE line only, not doubled by the ER line');
    assert.equal(summary.socialSecurityTax, dollars(248), 'tax is the COMBINED employee + employer 12.4%');
    assert.equal(summary.medicareTax, dollars(58));
    assert.equal(summary.totalTaxesBeforeAdjustments, dollars(200) + dollars(248) + dollars(58));
  });

  test('Additional Medicare adds its own withheld amount to the total without inflating taxable Medicare wages', () => {
    const q1Run = run({
      id: 'r1',
      checkDate: '2026-03-15',
      lines: [
        line({
          employeeId: 'e1',
          taxLines: [
            { id: 'US_MED_EE', name: 'Medicare', payer: 'employee', jurisdiction: 'federal', taxableWages: dollars(250_000), amount: dollars(3_625) },
            { id: 'US_MED_ER', name: 'Medicare (Employer)', payer: 'employer', jurisdiction: 'federal', taxableWages: dollars(250_000), amount: dollars(3_625) },
            { id: 'US_MED_ADDL', name: 'Additional Medicare', payer: 'employee', jurisdiction: 'federal', taxableWages: dollars(50_000), amount: dollars(450) },
          ],
        }),
      ],
    });
    const summary = computeForm941('co-1', 2026, 1, [q1Run]);
    assert.equal(summary.taxableMedicareWages, dollars(250_000));
    assert.equal(summary.taxableAdditionalMedicareWages, dollars(50_000));
    assert.equal(summary.additionalMedicareTaxWithheld, dollars(450));
    assert.equal(summary.medicareTax, dollars(7_250));
    assert.equal(summary.totalTaxesBeforeAdjustments, dollars(7_250) + dollars(450));
  });

  test('line 1 headcount comes from the specific run whose period covers the 12th of the quarter\'s LAST month', () => {
    const marchRun = run({
      id: 'march',
      checkDate: '2026-03-13',
      periodStart: '2026-03-01',
      periodEnd: '2026-03-14',
      lines: [line({ employeeId: 'e1' }), line({ employeeId: 'e2' }), line({ employeeId: 'e3' })],
    });
    const februaryRun = run({
      id: 'february',
      checkDate: '2026-02-14',
      periodStart: '2026-02-01',
      periodEnd: '2026-02-14',
      lines: [line({ employeeId: 'e1' })], // only 1 — must NOT be what line 1 reports
    });
    const summary = computeForm941('co-1', 2026, 1, [marchRun, februaryRun]);
    assert.equal(summary.numberOfEmployees, 3);
  });

  test('a company with no approved runs covering March 12th reports numberOfEmployees: null, not zero or a guess', () => {
    const summary = computeForm941('co-1', 2026, 1, []);
    assert.equal(summary.numberOfEmployees, null);
  });

  test('a run belonging to a DIFFERENT company is never counted', () => {
    const otherCompanyRun = run({ id: 'r1', companyId: 'co-OTHER', checkDate: '2026-01-15', lines: [line({ employeeId: 'e1', grossPay: dollars(5_000) })] });
    const summary = computeForm941('co-1', 2026, 1, [otherCompanyRun]);
    assert.equal(summary.wagesTipsOtherCompensation, 0);
    assert.equal(summary.numberOfEmployees, null);
  });

  test('a DRAFT run (not yet approved) is never counted, even if its check date is in range', () => {
    const draft = run({
      id: 'r1',
      checkDate: '2026-01-15',
      status: 'draft',
      lines: [line({ employeeId: 'e1', taxLines: [{ id: 'US_FIT', name: 'FIT', payer: 'employee', jurisdiction: 'federal', taxableWages: dollars(1_000), amount: dollars(100) }] })],
    });
    const summary = computeForm941('co-1', 2026, 1, [draft]);
    assert.equal(summary.wagesTipsOtherCompensation, 0);
  });
});

describe('W-2 annual rollup (payroll/filings.ts)', () => {
  test('boxes 1-6 sum across every approved run in the year, and box 6 folds in Additional Medicare', () => {
    const runs: PayRun[] = [
      run({
        id: 'r1',
        checkDate: '2026-01-15',
        lines: [
          line({
            employeeId: 'e1',
            taxLines: [
              { id: 'US_FIT', name: 'FIT', payer: 'employee', jurisdiction: 'federal', taxableWages: dollars(3_000), amount: dollars(300) },
              { id: 'US_SS_EE', name: 'SS', payer: 'employee', jurisdiction: 'federal', taxableWages: dollars(3_000), amount: dollars(186) },
              { id: 'US_MED_EE', name: 'Medicare', payer: 'employee', jurisdiction: 'federal', taxableWages: dollars(3_000), amount: dollars(43.5) },
            ],
          }),
        ],
      }),
      run({
        id: 'r2',
        checkDate: '2026-02-15',
        lines: [
          line({
            employeeId: 'e1',
            taxLines: [
              { id: 'US_FIT', name: 'FIT', payer: 'employee', jurisdiction: 'federal', taxableWages: dollars(3_000), amount: dollars(300) },
              { id: 'US_SS_EE', name: 'SS', payer: 'employee', jurisdiction: 'federal', taxableWages: dollars(3_000), amount: dollars(186) },
              { id: 'US_MED_EE', name: 'Medicare', payer: 'employee', jurisdiction: 'federal', taxableWages: dollars(3_000), amount: dollars(43.5) },
              { id: 'US_MED_ADDL', name: 'Additional Medicare', payer: 'employee', jurisdiction: 'federal', taxableWages: dollars(500), amount: dollars(4.5) },
            ],
          }),
        ],
      }),
      run({
        id: 'r3-next-year',
        checkDate: '2027-01-15', // must NOT be counted in the 2026 W-2
        lines: [line({ employeeId: 'e1', taxLines: [{ id: 'US_FIT', name: 'FIT', payer: 'employee', jurisdiction: 'federal', taxableWages: dollars(999_999), amount: dollars(999_999) }] })],
      }),
    ];

    const w2 = computeW2('e1', 2026, runs);
    assert.equal(w2.box1_wages, dollars(6_000));
    assert.equal(w2.box2_federalIncomeTaxWithheld, dollars(600));
    assert.equal(w2.box3_socialSecurityWages, dollars(6_000));
    assert.equal(w2.box4_socialSecurityTaxWithheld, dollars(372));
    assert.equal(w2.box5_medicareWages, dollars(6_000));
    assert.equal(w2.box6_medicareTaxWithheld, dollars(87) + dollars(4.5), 'box 6 includes Additional Medicare withheld');
  });

  test('state income tax lines (_SIT) roll into box 15-17, keyed by state, and non-SIT state-level taxes (SUI/SDI/PFML) are excluded', () => {
    const runs: PayRun[] = [
      run({
        id: 'r1',
        checkDate: '2026-01-15',
        lines: [
          line({
            employeeId: 'e1',
            taxLines: [
              { id: 'CA_SIT', name: 'California Income Tax', payer: 'employee', jurisdiction: 'state', taxableWages: dollars(3_000), amount: dollars(150) },
              { id: 'CA_SDI_EE', name: 'California SDI', payer: 'employee', jurisdiction: 'state', taxableWages: dollars(3_000), amount: dollars(33) },
            ],
          }),
        ],
      }),
    ];
    const w2 = computeW2('e1', 2026, runs);
    assert.deepEqual(w2.box15to17_state, [{ state: 'CA', wages: dollars(3_000), incomeTaxWithheld: dollars(150) }]);
  });

  test('local tax lines roll into box 18-20, keyed by the tax\'s own name, and employer-paid local taxes are excluded', () => {
    const runs: PayRun[] = [
      run({
        id: 'r1',
        checkDate: '2026-01-15',
        lines: [
          line({
            employeeId: 'e1',
            taxLines: [
              { id: 'OH_LOCAL', name: 'Columbus Municipal Income Tax', payer: 'employee', jurisdiction: 'local', taxableWages: dollars(3_000), amount: dollars(75) },
              { id: 'SEATTLE_PAYROLL_ER', name: 'Seattle Payroll Expense Tax (Employer)', payer: 'employer', jurisdiction: 'local', taxableWages: dollars(3_000), amount: dollars(20) },
            ],
          }),
        ],
      }),
    ];
    const w2 = computeW2('e1', 2026, runs);
    assert.deepEqual(w2.box18to20_local, [{ localityLabel: 'Columbus Municipal Income Tax', wages: dollars(3_000), incomeTaxWithheld: dollars(75) }]);
  });

  test('a different employee\'s lines in the same run never leak into this employee\'s W-2', () => {
    const runs: PayRun[] = [
      run({
        id: 'r1',
        checkDate: '2026-01-15',
        lines: [
          line({ employeeId: 'e1', taxLines: [{ id: 'US_FIT', name: 'FIT', payer: 'employee', jurisdiction: 'federal', taxableWages: dollars(3_000), amount: dollars(300) }] }),
          line({ employeeId: 'e2', taxLines: [{ id: 'US_FIT', name: 'FIT', payer: 'employee', jurisdiction: 'federal', taxableWages: dollars(50_000), amount: dollars(9_999) }] }),
        ],
      }),
    ];
    const w2 = computeW2('e1', 2026, runs);
    assert.equal(w2.box1_wages, dollars(3_000));
  });
});

describe('W-2 box 10/12 from deduction plans, replayed against each period\'s real gross (payroll/filings.ts)', () => {
  function employeeWithPlans(plans: DeductionPlan[]): Employee {
    return {
      id: 'e1',
      companyId: 'co-1',
      firstName: 'Test',
      lastName: 'Employee',
      hireDate: '2020-01-01',
      employmentCategory: 'standard',
      payType: { kind: 'salary', annualSalary: dollars(78_000) },
      residenceState: { code: 'TX' },
      federalW4: { filingStatus: 'single', multipleJobs: false, dependentCredit: 0, otherIncome: 0, deductions: 0, extraWithholding: 0 },
      deductionPlans: plans,
      directDepositAccounts: [],
      garnishmentOrders: [],
      ytd: freshYearToDate(),
      ytdYear: 2026,
    };
  }

  test('a flat 401(k) deduction sums to a fixed per-period amount times the number of periods paid', () => {
    const employee = employeeWithPlans([
      { id: 'p1', code: '401K', category: 'deferral_401k', amount: { kind: 'flat', cents: dollars(200) }, active: true },
    ]);
    const runs: PayRun[] = [
      run({ id: 'r1', checkDate: '2026-01-15', lines: [line({ employeeId: 'e1', grossPay: dollars(3_000) })] }),
      run({ id: 'r2', checkDate: '2026-02-15', lines: [line({ employeeId: 'e1', grossPay: dollars(3_000) })] }),
    ];
    const w2 = computeW2FromEmployee(employee, 2026, runs);
    assert.deepEqual(w2.box12, [{ code: 'D', amount: dollars(400) }]);
  });

  test('a percentOfGross plan is replayed against each period\'s OWN actual gross, not an averaged figure', () => {
    const employee = employeeWithPlans([
      { id: 'p1', code: '401K', category: 'deferral_401k', amount: { kind: 'percentOfGross', percent: 10 }, active: true },
    ]);
    // Two periods with DIFFERENT gross pay (a raise mid-year, say) — a
    // flawed average-based estimate would get this wrong; replaying each
    // period's real gross must not.
    const runs: PayRun[] = [
      run({ id: 'r1', checkDate: '2026-01-15', lines: [line({ employeeId: 'e1', grossPay: dollars(3_000) })] }),
      run({ id: 'r2', checkDate: '2026-02-15', lines: [line({ employeeId: 'e1', grossPay: dollars(4_000) })] }),
    ];
    const w2 = computeW2FromEmployee(employee, 2026, runs);
    assert.deepEqual(w2.box12, [{ code: 'D', amount: dollars(300) + dollars(400) }]);
  });

  test('an inactive plan contributes nothing, and dependent care goes to box 10, not box 12', () => {
    const employee = employeeWithPlans([
      { id: 'p1', code: 'DCA', category: 'dependent_care', amount: { kind: 'flat', cents: dollars(200) }, active: true },
      { id: 'p2', code: 'OLD_401K', category: 'deferral_401k', amount: { kind: 'flat', cents: dollars(999) }, active: false },
    ]);
    const runs: PayRun[] = [run({ id: 'r1', checkDate: '2026-01-15', lines: [line({ employeeId: 'e1', grossPay: dollars(3_000) })] })];
    const w2 = computeW2FromEmployee(employee, 2026, runs);
    assert.equal(w2.box10_dependentCareBenefits, dollars(200));
    assert.deepEqual(w2.box12, []);
  });

  test('section125/FSA/commuter plans get no box 12 code at all', () => {
    const employee = employeeWithPlans([
      { id: 'p1', code: 'HEALTH', category: 'section125', amount: { kind: 'flat', cents: dollars(150) }, active: true },
      { id: 'p2', code: 'COMMUTER', category: 'commuter', amount: { kind: 'flat', cents: dollars(50) }, active: true },
    ]);
    const runs: PayRun[] = [run({ id: 'r1', checkDate: '2026-01-15', lines: [line({ employeeId: 'e1', grossPay: dollars(3_000) })] })];
    const w2 = computeW2FromEmployee(employee, 2026, runs);
    assert.deepEqual(w2.box12, []);
  });
});

describe('filings computed from a REAL year of approved pay runs (integration)', () => {
  test('a full biweekly year for one employee produces internally-consistent Form 941 and W-2 figures', () => {
    const company: Company = {
      id: 'co-int',
      legalName: 'Integration Test Co',
      ein: '11-1111111',
      homeState: 'TX',
      paySchedule: { frequency: 'biweekly', anchorPeriodStart: '2026-01-04', checkDateLagDays: 5 },
    };
    let employee: Employee = {
      id: 'emp-int',
      companyId: company.id,
      firstName: 'Casey',
      lastName: 'Doe',
      hireDate: '2020-01-01',
      employmentCategory: 'standard',
      payType: { kind: 'salary', annualSalary: dollars(130_000) },
      residenceState: { code: 'TX' },
      federalW4: { filingStatus: 'single', multipleJobs: false, dependentCredit: 0, otherIncome: 0, deductions: 0, extraWithholding: 0 },
      deductionPlans: [{ id: 'p1', code: '401K', category: 'deferral_401k', amount: { kind: 'percentOfGross', percent: 8 }, active: true }],
      directDepositAccounts: [],
      garnishmentOrders: [],
      ytd: freshYearToDate(),
      ytdYear: 2026,
    };

    // Every period this schedule ACTUALLY produces for 2026 (see
    // payroll/schedule.ts's own tests: an anchor this close to the target
    // year's own start doesn't necessarily yield a full 26 — the anchor
    // itself is the earliest possible period). Driving the loop off the
    // real schedule, rather than assuming 26 and hand-stepping dates,
    // means this test's own expectations below are never out of sync with
    // what draftPayRun() actually sees.
    const periods = generatePayPeriods(company.paySchedule, 2026);
    const approvedRuns: PayRun[] = [];
    for (const period of periods) {
      const drafted = draftPayRun(company, [employee], period.periodStart, period.periodEnd, period.checkDate);
      const { run: approved, updatedEmployees } = approvePayRun(drafted, [employee]);
      employee = updatedEmployees[0];
      approvedRuns.push(approved);
    }

    const q1 = computeForm941(company.id, 2026, 1, approvedRuns);
    const q2 = computeForm941(company.id, 2026, 2, approvedRuns);
    const q3 = computeForm941(company.id, 2026, 3, approvedRuns);
    const q4 = computeForm941(company.id, 2026, 4, approvedRuns);
    const w2 = computeW2FromEmployee(employee, 2026, approvedRuns);

    // Every quarter found a headcount snapshot (the schedule's periods cover all four 12ths).
    for (const q of [q1, q2, q3, q4]) assert.equal(q.numberOfEmployees, 1);

    // The four quarters' federal income tax withheld must sum to the W-2's box 2 exactly —
    // same tax lines, sliced by quarter vs. by year.
    const summedFit = q1.federalIncomeTaxWithheld + q2.federalIncomeTaxWithheld + q3.federalIncomeTaxWithheld + q4.federalIncomeTaxWithheld;
    assert.equal(summedFit, w2.box2_federalIncomeTaxWithheld);

    // This schedule doesn't necessarily land a full 26 periods in 2026 (see
    // payroll/schedule.ts's own tests) — the true annual total is whatever
    // number of periods actually ran, each at annualSalary/26 per the
    // engine's own PERIODS_PER_YEAR convention, not the full $130,000.
    const perPeriodSalary = Math.round(dollars(130_000) / 26);
    const totalWagesPaid = perPeriodSalary * periods.length;

    // Social Security wages across the whole year must land exactly on the
    // true total paid — this employee's total is comfortably below the
    // 2026 wage base, so nothing should be capped.
    assert.equal(w2.box3_socialSecurityWages, totalWagesPaid);

    // The 8% 401(k) deferral is exactly 8% of the true annual total paid.
    assert.deepEqual(w2.box12, [{ code: 'D', amount: Math.round(totalWagesPaid * 0.08) }]);
  });
});

describe('Form 940 annual FUTA rollup (payroll/filings.ts)', () => {
  test('sums total payments and taxable FUTA wages/tax across the whole year, ignoring a different year and a different company', () => {
    const thisYear = run({
      id: 'r1',
      checkDate: '2026-03-15',
      lines: [
        line({
          employeeId: 'e1',
          grossPay: dollars(5_000),
          taxLines: [{ id: 'US_FUTA', name: 'FUTA', payer: 'employer', jurisdiction: 'federal', taxableWages: dollars(5_000), amount: dollars(30) }],
        }),
      ],
    });
    const laterInYear = run({
      id: 'r2',
      checkDate: '2026-09-15',
      lines: [
        line({
          employeeId: 'e1',
          grossPay: dollars(5_000),
          // The FUTA wage base ($7,000/yr) has already been met by this
          // point — the engine itself would report $0 taxable, exactly
          // like this fixture does, and the rollup must not invent more.
          taxLines: [{ id: 'US_FUTA', name: 'FUTA', payer: 'employer', jurisdiction: 'federal', taxableWages: 0, amount: 0 }],
        }),
      ],
    });
    const otherYear = run({ id: 'r3', checkDate: '2027-01-15', lines: [line({ employeeId: 'e1', grossPay: dollars(999_999) })] });
    const otherCompany = run({ id: 'r4', companyId: 'co-OTHER', checkDate: '2026-04-15', lines: [line({ employeeId: 'e1', grossPay: dollars(999_999) })] });

    const summary = computeForm940('co-1', 2026, [thisYear, laterInYear, otherYear, otherCompany]);
    assert.equal(summary.totalPayments, dollars(10_000));
    assert.equal(summary.totalTaxableFutaWages, dollars(5_000));
    assert.equal(summary.futaTax, dollars(30));
    assert.equal(summary.exemptPaymentsAndExcessOverWageBase, dollars(5_000), 'the $5,000 paid after the wage base was already met');
  });

  test('a company with no approved runs for the year reports all zeros, not a missing/undefined summary', () => {
    const summary = computeForm940('co-1', 2026, []);
    assert.deepEqual(summary, {
      companyId: 'co-1',
      year: 2026,
      totalPayments: 0,
      exemptPaymentsAndExcessOverWageBase: 0,
      totalTaxableFutaWages: 0,
      futaTax: 0,
    });
  });
});
