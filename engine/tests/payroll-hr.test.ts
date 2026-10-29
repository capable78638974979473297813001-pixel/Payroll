import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { dollars } from '../src/money.ts';
import {
  CALIFORNIA_OVERTIME_RULE,
  FEDERAL_OVERTIME_RULE,
  classifyWeeklyHours,
  earningsFromWeeklyHours,
  overtimeRuleForState,
  pairPunchesIntoDailyHours,
} from '../payroll/timeAndAttendance.ts';
import type { DailyHours, TimePunch } from '../payroll/timeAndAttendance.ts';
import { accruePto, applyAnnualCarryover, emptyPtoBalance, ptoPayoutEarning, usePto } from '../payroll/pto.ts';
import type { PtoPolicy } from '../payroll/pto.ts';
import { buildNewHireReport, deadlineDaysForState, FEDERAL_DEFAULT_DEADLINE_DAYS, newHireReportingIssuesForCompany } from '../payroll/newHireReporting.ts';
import { checkMinimumWageCompliance, checkMinimumWageComplianceForCompany } from '../payroll/compliance.ts';
import { applyElection, canElectBenefit, deductionPlanFromElection, employeeMonthlyPremium, isElectionChangeAllowed, perPeriodDeductionAmount, renderCarrierEligibilityRoster } from '../payroll/benefits.ts';
import type { BenefitElection, BenefitPlan } from '../payroll/benefits.ts';
import { minimumWage } from '../src/minimum-wage.ts';
import type { Company, Employee } from '../payroll/types.ts';
import { freshYearToDate } from '../payroll/ytd.ts';
import { finalPayDueDate, finalPtoPayoutHours, isVacationPayoutMandatory, terminateEmployee } from '../payroll/termination.ts';
import { acceptOffer, advanceCandidate, declineOffer, directHire, extendOffer, hireCandidate } from '../payroll/onboarding.ts';
import type { Candidate, OfferDetails } from '../payroll/onboarding.ts';

function baseEmployee(overrides: Partial<Employee> = {}): Employee {
  return {
    id: 'e1',
    companyId: 'co-1',
    firstName: 'Jamie',
    lastName: 'Rivera',
    hireDate: '2024-01-01',
    employmentCategory: 'standard',
    payType: { kind: 'hourly', hourlyRate: dollars(20) },
    residenceState: { code: 'TX' },
    federalW4: { filingStatus: 'single', multipleJobs: false, dependentCredit: 0, otherIncome: 0, deductions: 0, extraWithholding: 0 },
    deductionPlans: [],
    directDepositAccounts: [],
    garnishmentOrders: [],
    ytd: freshYearToDate(),
    ytdYear: 2026,
    ...overrides,
  };
}

function baseCompany(overrides: Partial<Company> = {}): Company {
  return {
    id: 'co-1',
    legalName: 'Test Co',
    ein: '12-3456789',
    homeState: 'TX',
    paySchedule: { frequency: 'biweekly', anchorPeriodStart: '2026-01-04', checkDateLagDays: 5 },
    ...overrides,
  };
}

// ============================================================================
// Time & attendance: pairing punches
// ============================================================================

describe('pairing raw punches into daily hours (payroll/timeAndAttendance.ts)', () => {
  test('a clean 9-to-5 with an hour for lunch nets 7 worked hours, the lunch hour excluded automatically', () => {
    const punches: TimePunch[] = [
      { employeeId: 'e1', timestamp: '2026-01-05T09:00:00', type: 'clock_in' },
      { employeeId: 'e1', timestamp: '2026-01-05T12:00:00', type: 'clock_out' },
      { employeeId: 'e1', timestamp: '2026-01-05T13:00:00', type: 'clock_in' },
      { employeeId: 'e1', timestamp: '2026-01-05T17:00:00', type: 'clock_out' },
    ];
    const days = pairPunchesIntoDailyHours(punches);
    assert.deepEqual(days, [{ date: '2026-01-05', hoursWorked: 7 }]);
  });

  test('punches across multiple days are grouped by their own clock-in date, sorted', () => {
    const punches: TimePunch[] = [
      { employeeId: 'e1', timestamp: '2026-01-06T09:00:00', type: 'clock_in' },
      { employeeId: 'e1', timestamp: '2026-01-06T17:00:00', type: 'clock_out' },
      { employeeId: 'e1', timestamp: '2026-01-05T09:00:00', type: 'clock_in' },
      { employeeId: 'e1', timestamp: '2026-01-05T17:00:00', type: 'clock_out' },
    ];
    const days = pairPunchesIntoDailyHours(punches);
    assert.deepEqual(days.map((d) => d.date), ['2026-01-05', '2026-01-06']);
  });

  test('an odd number of punches (a missing clock-out) throws rather than guessing', () => {
    const punches: TimePunch[] = [{ employeeId: 'e1', timestamp: '2026-01-05T09:00:00', type: 'clock_in' }];
    assert.throws(() => pairPunchesIntoDailyHours(punches), /Unpaired punch/);
  });

  test('two clock_ins in a row (a broken alternation) throws rather than silently pairing wrong', () => {
    const punches: TimePunch[] = [
      { employeeId: 'e1', timestamp: '2026-01-05T09:00:00', type: 'clock_in' },
      { employeeId: 'e1', timestamp: '2026-01-05T10:00:00', type: 'clock_in' },
    ];
    assert.throws(() => pairPunchesIntoDailyHours(punches), /alternation/);
  });
});

// ============================================================================
// Overtime classification
// ============================================================================

describe('overtime rule lookup (payroll/timeAndAttendance.ts)', () => {
  test('California gets its own daily rule; every other state falls back to the federal weekly-only rule', () => {
    assert.deepEqual(overtimeRuleForState('CA'), CALIFORNIA_OVERTIME_RULE);
    assert.deepEqual(overtimeRuleForState('TX'), FEDERAL_OVERTIME_RULE);
    assert.deepEqual(overtimeRuleForState('ZZ'), FEDERAL_OVERTIME_RULE, 'an unknown code still gets the safe federal floor, not a throw');
  });
});

describe('classifying a workweek (payroll/timeAndAttendance.ts)', () => {
  function days(hours: number[]): DailyHours[] {
    const dates = ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09', '2026-01-10', '2026-01-11'];
    return hours.map((h, i) => ({ date: dates[i], hoursWorked: h }));
  }

  test('federal rule: only the weekly 40-hour test applies, no daily concept at all', () => {
    // Six days at 7 hours each = 42 total; no single day is anywhere near
    // "long", so a daily-rule state would find zero overtime here — the
    // federal rule must still find the 2 hours over 40.
    const result = classifyWeeklyHours(days([7, 7, 7, 7, 7, 7]), FEDERAL_OVERTIME_RULE);
    assert.deepEqual(result, { regularHours: 40, overtimeHours: 2, doubleTimeHours: 0 });
  });

  test('California: a 10-hour day and a 13-hour day, each priced by ITS OWN daily thresholds, summed correctly', () => {
    // Day 1: 10h -> 8 regular + 2 OT. Day 2: 13h -> 8 regular + 4 OT (up to
    // the 12h mark) + 1 DT (past it). Three more plain 8h days. Week total
    // stays under 40 in the "regular" pool, so no weekly reclassification.
    const result = classifyWeeklyHours(days([10, 13, 8, 8, 8]), CALIFORNIA_OVERTIME_RULE);
    assert.deepEqual(result, { regularHours: 40, overtimeHours: 6, doubleTimeHours: 1 });
    // Every worked hour must be accounted for exactly once.
    assert.equal(result.regularHours + result.overtimeHours + result.doubleTimeHours, 10 + 13 + 8 + 8 + 8);
  });

  test('California: hours already paid at a DAILY premium are excluded from the weekly-40 regular pool, never double-counted into weekly OT too', () => {
    // 5 days at exactly 8h/day (the daily threshold itself, so no daily OT
    // triggers) = 40 hours total, landing EXACTLY on the weekly threshold
    // too. Nothing here should be overtime under either test.
    const result = classifyWeeklyHours(days([8, 8, 8, 8, 8]), CALIFORNIA_OVERTIME_RULE);
    assert.deepEqual(result, { regularHours: 40, overtimeHours: 0, doubleTimeHours: 0 });
  });

  test("California's 7th-consecutive-day rule: only fires when all 7 days of the workweek were worked, and reclassifies that day's own straight time into overtime", () => {
    // Six 8-hour days plus a 7th day at 10 hours. Worked out by hand:
    // days 1-6 contribute 8h "regular" each to the pool (48 total); the
    // weekly-40 cap reclassifies 8 of those 48 into overtime. The 7th day
    // itself is priced under the special rule regardless of the ordinary
    // 8/12 daily split: first 8h at 1.5x (added on top of the weekly-cap
    // overtime), the remaining 2h at 2x.
    const sevenDays = days([8, 8, 8, 8, 8, 8, 10]);
    const result = classifyWeeklyHours(sevenDays, CALIFORNIA_OVERTIME_RULE);
    assert.deepEqual(result, { regularHours: 40, overtimeHours: 16, doubleTimeHours: 2 });
    assert.equal(result.regularHours + result.overtimeHours + result.doubleTimeHours, 8 * 6 + 10);
  });

  test('a 6-day week (not 7) never triggers the 7th-consecutive-day rule, even under the California ruleset', () => {
    const sixDays = days([8, 8, 8, 8, 8, 12]);
    const result = classifyWeeklyHours(sixDays, CALIFORNIA_OVERTIME_RULE);
    // Day 6 at 12h -> 8 regular + 4 OT (exactly at the 12h double-time line, not past it).
    // Pool: 8*5 + 8 = 48 regular candidates -> capped at 40, 8 reclassified to weekly OT.
    assert.deepEqual(result, { regularHours: 40, overtimeHours: 12, doubleTimeHours: 0 });
  });
});

describe('pricing classified hours into Earnings (payroll/timeAndAttendance.ts)', () => {
  test('regular, overtime and double time are each their own line at the right multiplier', () => {
    const earnings = earningsFromWeeklyHours(dollars(20), { regularHours: 40, overtimeHours: 6, doubleTimeHours: 1 });
    assert.deepEqual(earnings, [
      { code: 'REG', category: 'regular', amount: dollars(800) },
      { code: 'OT', category: 'regular', amount: dollars(180) },
      { code: 'DT', category: 'regular', amount: dollars(40) },
    ]);
  });

  test('zero overtime/double-time produces no line for either, not a $0 line', () => {
    const earnings = earningsFromWeeklyHours(dollars(20), { regularHours: 40, overtimeHours: 0, doubleTimeHours: 0 });
    assert.deepEqual(earnings, [{ code: 'REG', category: 'regular', amount: dollars(800) }]);
  });
});

// ============================================================================
// PTO accrual
// ============================================================================

describe('PTO accrual and usage (payroll/pto.ts)', () => {
  test('perPayPeriod accrual adds a fixed amount regardless of hours worked', () => {
    const policy: PtoPolicy = { id: 'p1', name: 'Standard PTO', accrual: { kind: 'perPayPeriod', hoursPerPeriod: 4 } };
    let balance = emptyPtoBalance('e1', 'p1');
    balance = accruePto(balance, policy, 0);
    assert.equal(balance.balanceHours, 4);
    assert.equal(balance.ytdAccruedHours, 4);
  });

  test('perHourWorked accrual scales with the hours passed in', () => {
    const policy: PtoPolicy = { id: 'p1', name: 'Accrued PTO', accrual: { kind: 'perHourWorked', hoursAccruedPerHourWorked: 0.04 } }; // ~1hr per 25 worked
    let balance = emptyPtoBalance('e1', 'p1');
    balance = accruePto(balance, policy, 80); // a biweekly full-time period
    assert.equal(balance.balanceHours, 3.2);
  });

  test('accrual stops crediting past maxBalanceHours — the balance caps, and ytdAccrued only counts what actually fit', () => {
    const policy: PtoPolicy = { id: 'p1', name: 'Capped PTO', accrual: { kind: 'perPayPeriod', hoursPerPeriod: 10 }, maxBalanceHours: 15 };
    let balance = emptyPtoBalance('e1', 'p1');
    balance = accruePto(balance, policy); // 0 -> 10
    balance = accruePto(balance, policy); // would be 20, capped to 15
    assert.equal(balance.balanceHours, 15);
    assert.equal(balance.ytdAccruedHours, 15, 'only the 15 that actually landed in the balance counts as accrued');
  });

  test('using PTO within the balance succeeds and reduces it exactly', () => {
    const policy: PtoPolicy = { id: 'p1', name: 'PTO', accrual: { kind: 'perPayPeriod', hoursPerPeriod: 20 } };
    const balance = accruePto(emptyPtoBalance('e1', 'p1'), policy);
    const result = usePto(balance, 8);
    assert.equal(result.approved, true);
    assert.equal(result.shortfallHours, 0);
    assert.equal(result.balance.balanceHours, 12);
    assert.equal(result.balance.ytdUsedHours, 8);
  });

  test('requesting more than the balance is refused outright, not partially granted, and the balance is untouched', () => {
    const policy: PtoPolicy = { id: 'p1', name: 'PTO', accrual: { kind: 'perPayPeriod', hoursPerPeriod: 5 } };
    const balance = accruePto(emptyPtoBalance('e1', 'p1'), policy);
    const result = usePto(balance, 12);
    assert.equal(result.approved, false);
    assert.equal(result.shortfallHours, 7);
    assert.equal(result.balance.balanceHours, 5, 'an unapproved request must not touch the balance at all');
  });

  test('annual carryover clamps to the policy cap and resets YTD counters, leaving the balance itself alone below the cap', () => {
    const policy: PtoPolicy = { id: 'p1', name: 'PTO', accrual: { kind: 'perPayPeriod', hoursPerPeriod: 1 }, annualCarryoverCapHours: 40 };
    const overCap = { employeeId: 'e1', policyId: 'p1', balanceHours: 60, ytdAccruedHours: 26, ytdUsedHours: 10 };
    const rolled = applyAnnualCarryover(overCap, policy);
    assert.equal(rolled.balanceHours, 40);
    assert.equal(rolled.ytdAccruedHours, 0);
    assert.equal(rolled.ytdUsedHours, 0);

    const underCap = { employeeId: 'e1', policyId: 'p1', balanceHours: 12, ytdAccruedHours: 26, ytdUsedHours: 10 };
    assert.equal(applyAnnualCarryover(underCap, policy).balanceHours, 12);
  });

  test('a PTO payout is an ordinary Earning at the hourly rate, and does not itself touch the balance', () => {
    const earning = ptoPayoutEarning(dollars(25), 16);
    assert.deepEqual(earning, { code: 'PTO_PAYOUT', category: 'regular', amount: dollars(400) });
  });
});

// ============================================================================
// New-hire reporting
// ============================================================================

describe('new-hire reporting (payroll/newHireReporting.ts)', () => {
  function company(): Company {
    return { id: 'co-1', legalName: 'Acme LLC', ein: '12-3456789', homeState: 'TX', address: '1 Main St, Austin, TX 78701', paySchedule: { frequency: 'biweekly', anchorPeriodStart: '2026-01-04', checkDateLagDays: 5 } };
  }
  function employee(overrides: Partial<Employee> = {}): Employee {
    return {
      id: 'e1',
      companyId: 'co-1',
      firstName: 'Jordan',
      lastName: 'Lee',
      hireDate: '2026-03-01',
      employmentCategory: 'standard',
      payType: { kind: 'hourly', hourlyRate: dollars(20) },
      residenceState: { code: 'TX' },
      federalW4: { filingStatus: 'single', multipleJobs: false, dependentCredit: 0, otherIncome: 0, deductions: 0, extraWithholding: 0 },
      deductionPlans: [],
      directDepositAccounts: [],
      garnishmentOrders: [],
      ytd: freshYearToDate(),
      ytdYear: 2026,
      ssn: '123-45-6789',
      mailingAddress: '2 Oak Ave, Austin, TX 78702',
      ...overrides,
    };
  }

  test('the federal default deadline is 20 days, applied to every state absent a researched override', () => {
    assert.equal(FEDERAL_DEFAULT_DEADLINE_DAYS, 20);
    assert.equal(deadlineDaysForState('TX'), 20);
    assert.equal(deadlineDaysForState('CA'), 20);
  });

  test('builds a complete report with the employee\'s own work state as the reporting destination and hireDate + 20 days as the due date', () => {
    const report = buildNewHireReport(company(), employee({ workState: { code: 'CA' } }));
    assert.equal(report.reportToState, 'CA');
    assert.equal(report.dueBy, '2026-03-21');
    assert.equal(report.employee.ssn, '123-45-6789');
    assert.equal(report.employer.ein, '12-3456789');
  });

  test('an employee with no explicit workState reports to the company\'s own home state', () => {
    const report = buildNewHireReport(company(), employee());
    assert.equal(report.reportToState, 'TX');
  });

  test('refuses to build a report for an employee missing an SSN or mailing address, rather than filing an incomplete one', () => {
    assert.throws(() => buildNewHireReport(company(), employee({ ssn: undefined })), /SSN/);
    assert.throws(() => buildNewHireReport(company(), employee({ mailingAddress: undefined })), /mailing address/);
  });
});

describe('new-hire reporting compliance worklist (payroll/newHireReporting.ts)', () => {
  function company(): Company {
    return { id: 'co-1', legalName: 'Acme LLC', ein: '12-3456789', homeState: 'TX', paySchedule: { frequency: 'biweekly', anchorPeriodStart: '2026-01-04', checkDateLagDays: 5 } };
  }
  function employee(overrides: Partial<Employee> = {}): Employee {
    return {
      id: 'e1',
      companyId: 'co-1',
      firstName: 'Jordan',
      lastName: 'Lee',
      hireDate: '2026-03-01',
      employmentCategory: 'standard',
      payType: { kind: 'hourly', hourlyRate: dollars(20) },
      residenceState: { code: 'TX' },
      federalW4: { filingStatus: 'single', multipleJobs: false, dependentCredit: 0, otherIncome: 0, deductions: 0, extraWithholding: 0 },
      deductionPlans: [],
      directDepositAccounts: [],
      garnishmentOrders: [],
      ytd: freshYearToDate(),
      ytdYear: 2026,
      ssn: '123-45-6789',
      mailingAddress: '2 Oak Ave, Austin, TX 78702',
      ...overrides,
    };
  }

  test('an employee missing an SSN or mailing address is a missing_data finding, not silently skipped', () => {
    const issues = newHireReportingIssuesForCompany(company(), [employee({ ssn: undefined })], new Set(), '2026-03-10');
    assert.equal(issues.length, 1);
    assert.equal(issues[0].kind, 'missing_data');
    assert.deepEqual(issues[0].missingFields, ['ssn']);
  });

  test('missing BOTH fields lists both', () => {
    const issues = newHireReportingIssuesForCompany(company(), [employee({ ssn: undefined, mailingAddress: undefined })], new Set(), '2026-03-10');
    assert.deepEqual(issues[0].missingFields, ['ssn', 'mailingAddress']);
  });

  test('a deadline already in the past is an overdue finding', () => {
    // hireDate 2026-03-01 + 20 days = 2026-03-21; asOfDate well after that.
    const issues = newHireReportingIssuesForCompany(company(), [employee()], new Set(), '2026-04-01');
    assert.equal(issues.length, 1);
    assert.equal(issues[0].kind, 'overdue');
    assert.equal(issues[0].dueBy, '2026-03-21');
  });

  test('a deadline within the due-soon window (default 5 days) but not yet passed is due_soon', () => {
    const issues = newHireReportingIssuesForCompany(company(), [employee()], new Set(), '2026-03-18');
    assert.equal(issues.length, 1);
    assert.equal(issues[0].kind, 'due_soon');
  });

  test('a deadline safely in the future produces no finding at all', () => {
    const issues = newHireReportingIssuesForCompany(company(), [employee()], new Set(), '2026-03-01');
    assert.deepEqual(issues, []);
  });

  test('an employee already recorded as filed is skipped entirely, even if overdue', () => {
    const issues = newHireReportingIssuesForCompany(company(), [employee()], new Set(['e1']), '2026-04-01');
    assert.deepEqual(issues, []);
  });

  test('the due-soon window is configurable', () => {
    const issues = newHireReportingIssuesForCompany(company(), [employee()], new Set(), '2026-03-01', 30);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].kind, 'due_soon');
  });
});

// ============================================================================
// Minimum wage compliance
// ============================================================================

describe('minimum wage compliance checking (payroll/compliance.ts)', () => {
  test('flags an hourly employee paid below the binding floor for their work state, with the exact shortfall', () => {
    const answer = minimumWage({ checkDate: '2026-01-15', state: 'CA' });
    const employee = baseEmployee({ payType: { kind: 'hourly', hourlyRate: answer.cents - 100 }, workState: { code: 'CA' } });
    const issue = checkMinimumWageCompliance(baseCompany({ homeState: 'CA' }), employee, '2026-01-15');
    assert.ok(issue);
    assert.equal(issue!.applicableRateCents, answer.cents);
    assert.equal(issue!.employeeRateCents, answer.cents - 100);
    assert.equal(issue!.shortfallCents, 100);
    assert.equal(issue!.jurisdiction, answer.bindingJurisdiction);
  });

  test('an hourly employee paid AT OR ABOVE the binding floor produces no issue at all', () => {
    const answer = minimumWage({ checkDate: '2026-01-15', state: 'TX' });
    const employee = baseEmployee({ payType: { kind: 'hourly', hourlyRate: answer.cents + 500 }, workState: { code: 'TX' } });
    assert.equal(checkMinimumWageCompliance(baseCompany({ homeState: 'TX' }), employee, '2026-01-15'), null);
  });

  test('a salaried employee is never evaluated, however low the implied rate might be', () => {
    const employee = baseEmployee({ payType: { kind: 'salary', annualSalary: 1 } });
    assert.equal(checkMinimumWageCompliance(baseCompany(), employee, '2026-01-15'), null);
  });

  test('an employee with no explicit workState is checked against the COMPANY\'s own home state', () => {
    const answer = minimumWage({ checkDate: '2026-01-15', state: 'CA' });
    const employee = baseEmployee({ payType: { kind: 'hourly', hourlyRate: answer.cents - 50 } }); // no workState set
    const issue = checkMinimumWageCompliance(baseCompany({ homeState: 'CA' }), employee, '2026-01-15');
    assert.ok(issue);
  });

  test('checking a whole company returns only the real violations, never a clean-bill entry for a compliant employee', () => {
    const answer = minimumWage({ checkDate: '2026-01-15', state: 'TX' });
    const violator = baseEmployee({ id: 'low', payType: { kind: 'hourly', hourlyRate: answer.cents - 200 } });
    const compliant = baseEmployee({ id: 'ok', payType: { kind: 'hourly', hourlyRate: answer.cents + 200 } });
    const salaried = baseEmployee({ id: 'salaried', payType: { kind: 'salary', annualSalary: dollars(50_000) } });
    const issues = checkMinimumWageComplianceForCompany(baseCompany(), [violator, compliant, salaried], '2026-01-15');
    assert.deepEqual(issues.map((i) => i.employeeId), ['low']);
  });
});

// ============================================================================
// Benefits administration
// ============================================================================

describe('benefits: plans, elections, and the deduction they produce (payroll/benefits.ts)', () => {
  function medicalPlan(overrides: Partial<BenefitPlan> = {}): BenefitPlan {
    return {
      id: 'plan-medical',
      companyId: 'co-1',
      name: 'PPO Medical',
      category: 'section125',
      monthlyPremiumByTier: { employee_only: dollars(500), employee_spouse: dollars(900), family: dollars(1_200) },
      employerContributionFraction: 0.8,
      ...overrides,
    };
  }

  test('the employee\'s own monthly cost is the tier\'s full premium less the employer\'s contribution', () => {
    const plan = medicalPlan();
    assert.equal(employeeMonthlyPremium(plan, 'employee_only'), dollars(100)); // 500 * (1 - 0.8)
    assert.equal(employeeMonthlyPremium(plan, 'family'), dollars(240)); // 1200 * 0.2
  });

  test('a plan with no premium defined for the requested tier throws rather than silently charging $0', () => {
    const plan = medicalPlan({ monthlyPremiumByTier: { employee_only: dollars(500) } });
    assert.throws(() => employeeMonthlyPremium(plan, 'family'), /no premium defined/);
  });

  test('a monthly cost is annualized (x12) before being sliced per period, matching hand-computed cents exactly', () => {
    // $120/month = $14,400 cents/year. Biweekly (26/yr): 14400/26 =
    // 553.84... -> 554 cents ($5.54)? No — dollars(120) is already CENTS
    // (12,000), so the annual figure is 144,000 cents: 144,000/26 =
    // 5538.46... -> 5538 cents ($55.38). Semimonthly (24/yr): 144,000/24 =
    // exactly 6,000 cents ($60.00).
    assert.equal(perPeriodDeductionAmount(dollars(120), 26), 5_538);
    assert.equal(perPeriodDeductionAmount(dollars(120), 24), dollars(60));
  });

  test('an active election produces an active DeductionPlan; a superseded one (endDate set) produces an inactive one', () => {
    const plan = medicalPlan();
    const active: BenefitElection = { id: 'el-1', employeeId: 'e1', planId: plan.id, coverageTier: 'employee_only', effectiveDate: '2026-01-01' };
    const ended: BenefitElection = { ...active, id: 'el-2', endDate: '2026-06-30' };

    const activeDeduction = deductionPlanFromElection(plan, active, 26);
    assert.equal(activeDeduction.active, true);
    assert.equal(activeDeduction.category, 'section125');
    // Employee cost is $100/month (500 * 0.2) = 10,000 cents/yr *12 =
    // 120,000 cents; /26 periods = 4615.38... -> 4615 cents.
    assert.equal(activeDeduction.amount.kind === 'flat' && activeDeduction.amount.cents, 4_615);

    assert.equal(deductionPlanFromElection(plan, ended, 26).active, false);
  });

  test('election changes are allowed inside the open enrollment window, or anytime with a qualifying life event, and refused otherwise', () => {
    const window = { start: '2026-11-01', end: '2026-11-15' };
    assert.equal(isElectionChangeAllowed('2026-11-10', window, false), true);
    assert.equal(isElectionChangeAllowed('2026-06-01', window, false), false);
    assert.equal(isElectionChangeAllowed('2026-06-01', window, true), true, 'a genuine qualifying life event overrides the window');
  });

  test('canElectBenefit: a brand-new hire\'s first-ever election is always allowed, regardless of window or life event', () => {
    const result = canElectBenefit([], '2026-06-01', undefined, false);
    assert.equal(result.allowed, true);
    assert.equal(result.reason, undefined);
  });

  test('canElectBenefit: a change with no open enrollment window configured at all is refused, not silently allowed', () => {
    const existing: BenefitElection = { id: 'el-1', employeeId: 'e1', planId: 'plan-medical', coverageTier: 'employee_only', effectiveDate: '2026-01-01' };
    const result = canElectBenefit([existing], '2026-06-01', undefined, false);
    assert.equal(result.allowed, false);
    assert.match(result.reason!, /No open enrollment window is configured/);
  });

  test('canElectBenefit: a change inside a configured window is allowed', () => {
    const existing: BenefitElection = { id: 'el-1', employeeId: 'e1', planId: 'plan-medical', coverageTier: 'employee_only', effectiveDate: '2026-01-01' };
    const window = { start: '2026-11-01', end: '2026-11-15' };
    const result = canElectBenefit([existing], '2026-11-10', window, false);
    assert.equal(result.allowed, true);
  });

  test('canElectBenefit: a change outside the window with no qualifying life event is refused with a specific reason', () => {
    const existing: BenefitElection = { id: 'el-1', employeeId: 'e1', planId: 'plan-medical', coverageTier: 'employee_only', effectiveDate: '2026-01-01' };
    const window = { start: '2026-11-01', end: '2026-11-15' };
    const result = canElectBenefit([existing], '2026-06-01', window, false);
    assert.equal(result.allowed, false);
    assert.match(result.reason!, /falls outside the open enrollment window/);
  });

  test('canElectBenefit: a genuine qualifying life event overrides the window even with one configured', () => {
    const existing: BenefitElection = { id: 'el-1', employeeId: 'e1', planId: 'plan-medical', coverageTier: 'employee_only', effectiveDate: '2026-01-01' };
    const window = { start: '2026-11-01', end: '2026-11-15' };
    const result = canElectBenefit([existing], '2026-06-01', window, true);
    assert.equal(result.allowed, true);
  });

  test('applyElection: re-electing the SAME plan (a tier change) ends the prior election and its deduction, leaving exactly one deduction for that plan', () => {
    const plan = medicalPlan();
    const employeeWithPriorElection = baseEmployee({
      deductionPlans: [{ id: 'benefit-el-1', code: 'PPO Medical', category: 'section125', amount: { kind: 'flat', cents: dollars(100) }, active: true }],
    });
    const priorElection: BenefitElection = { id: 'el-1', employeeId: 'e1', planId: plan.id, coverageTier: 'employee_only', effectiveDate: '2026-01-01' };

    const result = applyElection(employeeWithPriorElection, [priorElection], plan, 'family', '2026-07-01', 26);

    assert.equal(result.endedElections.length, 1);
    assert.equal(result.endedElections[0].endDate, '2026-07-01');
    const planDeductions = result.employee.deductionPlans.filter((d) => d.code === 'PPO Medical');
    assert.equal(planDeductions.length, 1, 'the old tier\'s deduction must be gone, not left running alongside the new one');
    assert.equal(planDeductions[0].id, `benefit-${result.election.id}`);
  });

  test('applyElection: electing a DIFFERENT plan never touches an existing election for an unrelated plan — both run concurrently', () => {
    const medical = medicalPlan();
    const dental = medicalPlan({ id: 'plan-dental', name: 'Dental PPO', monthlyPremiumByTier: { employee_only: dollars(40) } });
    const employeeWithMedical = baseEmployee({
      deductionPlans: [{ id: 'benefit-el-medical', code: 'PPO Medical', category: 'section125', amount: { kind: 'flat', cents: dollars(100) }, active: true }],
    });
    const medicalElection: BenefitElection = { id: 'el-medical', employeeId: 'e1', planId: medical.id, coverageTier: 'employee_only', effectiveDate: '2026-01-01' };

    const result = applyElection(employeeWithMedical, [medicalElection], dental, 'employee_only', '2026-07-01', 26);

    assert.equal(result.endedElections.length, 0, 'a different plan must never end an unrelated one');
    assert.equal(result.employee.deductionPlans.find((d) => d.code === 'PPO Medical')?.active, true, 'the existing medical deduction must be untouched');
    assert.ok(result.employee.deductionPlans.find((d) => d.code === 'Dental PPO'), 'the new dental deduction must be added');
  });
});

describe('carrier eligibility roster export (payroll/benefits.ts)', () => {
  function medicalPlan(overrides: Partial<BenefitPlan> = {}): BenefitPlan {
    return {
      id: 'plan-medical',
      companyId: 'co-1',
      name: 'PPO Medical',
      category: 'section125',
      monthlyPremiumByTier: { employee_only: dollars(500), employee_spouse: dollars(900), family: dollars(1_200) },
      employerContributionFraction: 0.8,
      ...overrides,
    };
  }
  const plan = medicalPlan();
  const alice = baseEmployee({ id: 'alice', firstName: 'Alice', lastName: 'Anders' });
  const bob = baseEmployee({ id: 'bob', firstName: 'Bob', lastName: 'Baxter' });

  test('renders a header row plus one row per election for the given plan, sorted by employee name', () => {
    const elections: BenefitElection[] = [
      { id: 'el-2', employeeId: 'bob', planId: plan.id, coverageTier: 'employee_only', effectiveDate: '2026-01-01' },
      { id: 'el-1', employeeId: 'alice', planId: plan.id, coverageTier: 'family', effectiveDate: '2026-01-01' },
    ];
    const csv = renderCarrierEligibilityRoster([alice, bob], plan, elections);
    const lines = csv.trim().split('\n');
    assert.equal(lines.length, 3); // header + 2 rows
    assert.equal(lines[0], 'Employee Name,Coverage Tier,Effective Date,End Date,Status,Employee Monthly Cost,Employer Monthly Cost');
    assert.ok(lines[1].startsWith('Alice Anders,'), 'Alice must sort before Bob');
    assert.ok(lines[2].startsWith('Bob Baxter,'));
  });

  test('an election for a DIFFERENT plan is excluded entirely', () => {
    const elections: BenefitElection[] = [
      { id: 'el-1', employeeId: 'alice', planId: 'some-other-plan', coverageTier: 'employee_only', effectiveDate: '2026-01-01' },
    ];
    const csv = renderCarrierEligibilityRoster([alice], plan, elections);
    assert.equal(csv.trim().split('\n').length, 1); // header only
  });

  test('a since-ended election is included with its own end date and a Terminated status, not dropped', () => {
    const elections: BenefitElection[] = [
      { id: 'el-1', employeeId: 'alice', planId: plan.id, coverageTier: 'employee_only', effectiveDate: '2026-01-01', endDate: '2026-06-30' },
    ];
    const csv = renderCarrierEligibilityRoster([alice], plan, elections);
    const row = csv.trim().split('\n')[1];
    assert.match(row, /2026-06-30,Terminated/);
  });

  test('an active election has an empty end date and an Active status', () => {
    const elections: BenefitElection[] = [
      { id: 'el-1', employeeId: 'alice', planId: plan.id, coverageTier: 'employee_only', effectiveDate: '2026-01-01' },
    ];
    const csv = renderCarrierEligibilityRoster([alice], plan, elections);
    const row = csv.trim().split('\n')[1];
    assert.match(row, /,,Active,/);
  });

  test('employee and employer monthly cost columns split the full premium correctly', () => {
    // medicalPlan(): employee_only $500/mo, 80% employer-paid -> employee $100, employer $400.
    const elections: BenefitElection[] = [
      { id: 'el-1', employeeId: 'alice', planId: plan.id, coverageTier: 'employee_only', effectiveDate: '2026-01-01' },
    ];
    const csv = renderCarrierEligibilityRoster([alice], plan, elections);
    const row = csv.trim().split('\n')[1];
    assert.ok(row.endsWith('100.00,400.00'), `expected costs 100.00,400.00, got: ${row}`);
  });

  test('an election for an employee not in the supplied employee list falls back to the raw employee id', () => {
    const elections: BenefitElection[] = [
      { id: 'el-1', employeeId: 'unknown-emp', planId: plan.id, coverageTier: 'employee_only', effectiveDate: '2026-01-01' },
    ];
    const csv = renderCarrierEligibilityRoster([], plan, elections);
    assert.ok(csv.includes('unknown-emp'));
  });

  test('no elections for this plan produces just the header row', () => {
    const csv = renderCarrierEligibilityRoster([alice], plan, []);
    assert.equal(csv.trim(), 'Employee Name,Coverage Tier,Effective Date,End Date,Status,Employee Monthly Cost,Employer Monthly Cost');
  });
});

// ============================================================================
// Termination / offboarding
// ============================================================================

describe('final pay timing (payroll/termination.ts)', () => {
  test('California: involuntary termination and layoff are due IMMEDIATELY, same day', () => {
    assert.equal(finalPayDueDate('CA', '2026-06-10', 'involuntary', '2026-06-20').dueDate, '2026-06-10');
    assert.equal(finalPayDueDate('CA', '2026-06-10', 'layoff', '2026-06-20').dueDate, '2026-06-10');
  });

  test('California: a termination for gross misconduct is still employer-initiated, so it follows the same immediate-pay rule as an ordinary involuntary termination', () => {
    assert.equal(finalPayDueDate('CA', '2026-06-10', 'gross_misconduct', '2026-06-20').dueDate, '2026-06-10');
  });

  test('California: resignation WITH 72+ hours notice is due on the last day worked', () => {
    assert.equal(finalPayDueDate('CA', '2026-06-10', 'voluntary_with_notice', '2026-06-20').dueDate, '2026-06-10');
  });

  test('California: resignation WITHOUT notice is due within 72 hours (approximated as 3 calendar days)', () => {
    assert.equal(finalPayDueDate('CA', '2026-06-10', 'voluntary_without_notice', '2026-06-20').dueDate, '2026-06-13');
  });

  test('every other state falls back to the federal floor: no later than the next regular payday', () => {
    const result = finalPayDueDate('TX', '2026-06-10', 'involuntary', '2026-06-20');
    assert.equal(result.dueDate, '2026-06-20');
    assert.match(result.rule, /federal floor/);
  });
});

describe('mandatory PTO/vacation payout at termination (payroll/termination.ts)', () => {
  const balance = { employeeId: 'e1', policyId: 'p1', balanceHours: 40, ytdAccruedHours: 40, ytdUsedHours: 0 };

  test('California NEVER allows forfeiture — the full balance is owed regardless of the employer\'s own policy', () => {
    assert.equal(isVacationPayoutMandatory('CA'), true);
    assert.equal(finalPtoPayoutHours(balance, 'CA', false), 40, 'even an employer policy of NOT paying it out is overridden in California');
  });

  test('elsewhere, payout follows the employer\'s own policy', () => {
    assert.equal(finalPtoPayoutHours(balance, 'TX', true), 40);
    assert.equal(finalPtoPayoutHours(balance, 'TX', false), 0);
  });

  test('no balance on file at all means no payout, anywhere', () => {
    assert.equal(finalPtoPayoutHours(null, 'CA', true), 0);
  });
});

describe('the full termination workflow (payroll/termination.ts)', () => {
  test('sets the employee\'s terminationDate and resolves both the final-pay deadline and the PTO payout together', () => {
    const employee = baseEmployee({ workState: { code: 'CA' } });
    const balance = { employeeId: 'e1', policyId: 'p1', balanceHours: 12, ytdAccruedHours: 12, ytdUsedHours: 0 };
    const result = terminateEmployee(employee, '2026-06-10', 'involuntary', '2026-06-20', balance, false);
    assert.equal(result.employee.terminationDate, '2026-06-10');
    assert.equal(result.finalPay.dueDate, '2026-06-10');
    assert.equal(result.ptoPayoutHours, 12);
  });

  test('falls back to the employee\'s own residenceState when no workState is set', () => {
    const employee = baseEmployee({ residenceState: { code: 'CA' } });
    const result = terminateEmployee(employee, '2026-06-10', 'involuntary', '2026-06-20', null, false);
    assert.equal(result.finalPay.dueDate, '2026-06-10');
  });
});

// ============================================================================
// Recruiting / onboarding pipeline
// ============================================================================

describe('candidate pipeline stage transitions (payroll/onboarding.ts)', () => {
  function candidate(overrides: Partial<Candidate> = {}): Candidate {
    return { id: 'cand-1', jobPostingId: 'job-1', firstName: 'Sam', lastName: 'Okafor', email: 's@example.com', stage: 'applied', appliedAt: '2026-01-01', ...overrides };
  }

  test('a normal forward path (applied -> screening -> interviewing -> offer -> accepted -> hired) is allowed step by step', () => {
    let c = candidate();
    c = advanceCandidate(c, 'screening');
    c = advanceCandidate(c, 'interviewing');
    const offer: OfferDetails = { payType: { kind: 'hourly', hourlyRate: dollars(25) }, startDate: '2026-03-01', workState: { code: 'TX' } };
    c = extendOffer(c, offer);
    assert.equal(c.stage, 'offer_extended');
    c = acceptOffer(c);
    assert.equal(c.stage, 'offer_accepted');
  });

  test('rejecting a candidate is allowed from any active (non-terminal) stage', () => {
    assert.equal(advanceCandidate(candidate({ stage: 'applied' }), 'rejected').stage, 'rejected');
    assert.equal(advanceCandidate(candidate({ stage: 'interviewing' }), 'rejected').stage, 'rejected');
  });

  test('an impossible jump (applied straight to interviewing, skipping screening) throws', () => {
    assert.throws(() => advanceCandidate(candidate({ stage: 'applied' }), 'interviewing'));
  });

  test('a terminal stage (rejected, hired, offer_declined) can never move again', () => {
    assert.throws(() => advanceCandidate(candidate({ stage: 'rejected' }), 'screening'));
    assert.throws(() => acceptOffer(candidate({ stage: 'offer_declined' })));
  });

  test('declining an offer is a real, distinct outcome from rejection', () => {
    const offer: OfferDetails = { payType: { kind: 'salary', annualSalary: dollars(90_000) }, startDate: '2026-03-01', workState: { code: 'TX' } };
    const c = declineOffer(extendOffer(candidate({ stage: 'interviewing' }), offer));
    assert.equal(c.stage, 'offer_declined');
  });
});

describe('hiring a candidate produces a real Employee record (payroll/onboarding.ts)', () => {
  function acceptedCandidate(): Candidate {
    const offer: OfferDetails = {
      payType: { kind: 'salary', annualSalary: dollars(85_000) },
      startDate: '2026-04-01',
      workState: { code: 'NY' },
      jobTitle: 'Software Engineer',
      department: 'Engineering',
    };
    return {
      id: 'cand-2',
      jobPostingId: 'job-2',
      firstName: 'Priya',
      lastName: 'Menon',
      email: 'p@example.com',
      stage: 'offer_accepted',
      appliedAt: '2026-01-01',
      offer,
    };
  }

  test('builds an Employee whose hireDate, pay, work state, title and department all come from the accepted offer', () => {
    const w4: import('../src/types.ts').FederalW4 = { filingStatus: 'single', multipleJobs: false, dependentCredit: 0, otherIncome: 0, deductions: 0, extraWithholding: 0 };
    const { employee, candidate: hired } = hireCandidate(acceptedCandidate(), 'co-1', w4, { code: 'NY' });

    assert.equal(hired.stage, 'hired');
    assert.equal(employee.hireDate, '2026-04-01');
    assert.equal(employee.jobTitle, 'Software Engineer');
    assert.equal(employee.department, 'Engineering');
    assert.deepEqual(employee.payType, { kind: 'salary', annualSalary: dollars(85_000) });
    assert.equal(employee.workState?.code, 'NY');
    assert.equal(employee.ytdYear, 2026);
    assert.deepEqual(employee.ytd, freshYearToDate());
    assert.deepEqual(employee.deductionPlans, []);
  });

  test('refuses to hire a candidate whose offer was never accepted', () => {
    const notYetAccepted = { ...acceptedCandidate(), stage: 'offer_extended' as const };
    const w4: import('../src/types.ts').FederalW4 = { filingStatus: 'single', multipleJobs: false, dependentCredit: 0, otherIncome: 0, deductions: 0, extraWithholding: 0 };
    assert.throws(() => hireCandidate(notYetAccepted, 'co-1', w4, { code: 'NY' }));
  });
});

describe('directHire: onboarding an existing employee outside the recruiting pipeline (payroll/onboarding.ts)', () => {
  const w4: import('../src/types.ts').FederalW4 = { filingStatus: 'single', multipleJobs: false, dependentCredit: 0, otherIncome: 0, deductions: 0, extraWithholding: 0 };

  test('builds a real Employee record with a fresh id, YTD, and empty deduction/deposit/garnishment lists', () => {
    const employee = directHire('co-1', {
      firstName: 'Dana',
      lastName: 'Ortiz',
      hireDate: '2026-05-01',
      jobTitle: 'Shift Lead',
      department: 'Kitchen',
      payType: { kind: 'hourly', hourlyRate: dollars(22) },
      residenceState: { code: 'IL' },
      federalW4: w4,
    });

    assert.equal(employee.companyId, 'co-1');
    assert.equal(employee.firstName, 'Dana');
    assert.equal(employee.lastName, 'Ortiz');
    assert.equal(employee.hireDate, '2026-05-01');
    assert.equal(employee.jobTitle, 'Shift Lead');
    assert.equal(employee.department, 'Kitchen');
    assert.deepEqual(employee.payType, { kind: 'hourly', hourlyRate: dollars(22) });
    assert.equal(employee.ytdYear, 2026);
    assert.deepEqual(employee.ytd, freshYearToDate());
    assert.deepEqual(employee.deductionPlans, []);
    assert.deepEqual(employee.directDepositAccounts, []);
    assert.deepEqual(employee.garnishmentOrders, []);
    assert.ok(employee.id.length > 0);
  });

  test('two direct hires get distinct ids', () => {
    const input = {
      firstName: 'A', lastName: 'B', hireDate: '2026-01-01',
      payType: { kind: 'hourly' as const, hourlyRate: dollars(20) },
      residenceState: { code: 'TX' }, federalW4: w4,
    };
    const first = directHire('co-1', input);
    const second = directHire('co-1', input);
    assert.notEqual(first.id, second.id);
  });

  test('defaults employmentCategory to standard when not supplied', () => {
    const employee = directHire('co-1', {
      firstName: 'A', lastName: 'B', hireDate: '2026-01-01',
      payType: { kind: 'salary', annualSalary: dollars(60_000) },
      residenceState: { code: 'TX' }, federalW4: w4,
    });
    assert.equal(employee.employmentCategory, 'standard');
  });

  test('an explicit employmentCategory overrides the default', () => {
    const employee = directHire('co-1', {
      firstName: 'A', lastName: 'B', hireDate: '2026-01-01',
      employmentCategory: 'household',
      payType: { kind: 'hourly', hourlyRate: dollars(18) },
      residenceState: { code: 'TX' }, federalW4: w4,
    });
    assert.equal(employee.employmentCategory, 'household');
  });

  test('workState is optional and omitted defaults to undefined, matching hireCandidate\'s own convention', () => {
    const employee = directHire('co-1', {
      firstName: 'A', lastName: 'B', hireDate: '2026-01-01',
      payType: { kind: 'hourly', hourlyRate: dollars(18) },
      residenceState: { code: 'TX' }, federalW4: w4,
    });
    assert.equal(employee.workState, undefined);
  });
});
