import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { dollars } from '../src/money.ts';
import { freshYearToDate } from '../payroll/ytd.ts';
import { generatePayPeriods } from '../payroll/schedule.ts';
import { approvePayRun, draftPayRun } from '../payroll/run.ts';
import type { Company, Employee } from '../payroll/types.ts';

/**
 * The annual 402(g)/457/SIMPLE caps only bind if each approved pay run adds
 * its deferrals to the employee's year-to-date. Without that, every period
 * looks like the first of the year and an over-limit deferral stays pretax.
 */

const company: Company = {
  id: 'co-1', legalName: 'Test Co LLC', ein: '12-3456789', homeState: 'TX',
  paySchedule: { frequency: 'biweekly', anchorPeriodStart: '2025-12-28', checkDateLagDays: 5 },
};

const employee = (over: Partial<Employee> = {}): Employee => ({
  id: 'e1', companyId: 'co-1', firstName: 'Dee', lastName: 'Ferral', hireDate: '2020-01-01',
  employmentCategory: 'standard', payType: { kind: 'salary', annualSalary: dollars(260_000) },
  residenceState: { code: 'TX' },
  federalW4: { filingStatus: 'single', multipleJobs: false, dependentCredit: 0, otherIncome: 0, deductions: 0, extraWithholding: 0 },
  deductionPlans: [{ id: 'p1', code: '401K', category: 'deferral_401k', amount: { kind: 'flat', cents: dollars(2_500) }, active: true }],
  directDepositAccounts: [], garnishmentOrders: [], ytd: freshYearToDate(), ytdYear: 2026,
  ...over,
});

/** Run every 2026 pay period in order, rolling each approved run into the employee's YTD. */
function runYear(start: Employee, periods = 14) {
  let emp = start;
  const pretax: number[] = [];
  const posttax: number[] = [];
  for (const p of generatePayPeriods(company.paySchedule, 2026).slice(0, periods)) {
    const run = draftPayRun(company, [emp], p.periodStart, p.periodEnd, p.checkDate, [{ employeeId: emp.id, regularHours: 80, overtimeHours: 0 }]);
    pretax.push(run.lines[0]!.pretaxDeductions);
    posttax.push(run.lines[0]!.posttaxDeductions);
    emp = approvePayRun(run, [emp]).updatedEmployees[0]!;
  }
  return { emp, pretax, posttax };
}

describe('retirement deferrals accumulate across approved pay runs', () => {
  test('$2,500 a check hits the $24,500 limit on the tenth check and the rest is taxed as pay', () => {
    const { emp, pretax, posttax } = runYear(employee());
    assert.deepEqual(pretax.slice(0, 9), Array(9).fill(dollars(2_500)));
    assert.equal(pretax[9], dollars(2_000), 'the tenth check has only $2,000 of room: 9 x $2,500 = $22,500');
    assert.equal(posttax[9], dollars(500), 'the other $500 still leaves the paycheck, after tax');
    for (const later of pretax.slice(10)) assert.equal(later, 0, 'nothing more is pretax once the limit is reached');
    assert.equal(emp.ytd.electiveDeferrals?.section402gAggregate, dollars(24_500));
  });

  test('an employee 50 or over keeps deferring up to $32,500', () => {
    const { emp, pretax } = runYear(employee({ ageAtYearEnd: 55 }), 14);
    const total = pretax.reduce((a, b) => a + b, 0);
    assert.equal(total, dollars(32_500));
    assert.equal(emp.ytd.electiveDeferrals?.section402gAggregate, dollars(32_500));
  });

  test('457(b) and SIMPLE are tracked in their own buckets', () => {
    const f457 = runYear(employee({ deductionPlans: [{ id: 'p', code: '457', category: 'deferral_457', amount: { kind: 'flat', cents: dollars(2_500) }, active: true }] }));
    assert.equal(f457.emp.ytd.electiveDeferrals?.deferral457, dollars(24_500));
    assert.equal(f457.emp.ytd.electiveDeferrals?.section402gAggregate ?? 0, 0, '457(b) is not part of the 402(g) total');

    const simple = runYear(employee({ deductionPlans: [{ id: 'p', code: 'SIMP', category: 'deferral_simple', amount: { kind: 'flat', cents: dollars(2_000) }, active: true }] }));
    assert.equal(simple.emp.ytd.electiveDeferrals?.simple, dollars(17_000));
    assert.equal(simple.emp.ytd.electiveDeferrals?.section402gAggregate, dollars(17_000), 'SIMPLE counts toward the 402(g) total as well');
  });

  test('a new calendar year starts the deferral totals over', () => {
    const emp = employee({ ytdYear: 2025, ytd: { ...freshYearToDate(), electiveDeferrals: { section402gAggregate: dollars(23_500) } } });
    const run = draftPayRun(company, [emp], '2025-12-28', '2026-01-10', '2026-01-15', [{ employeeId: emp.id, regularHours: 80, overtimeHours: 0 }]);
    assert.equal(run.lines[0]!.pretaxDeductions, dollars(2_500), '2025 deferrals do not use up 2026 room');
  });
});
