import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { dollars } from '../src/money.ts';
import {
  ACA_AFFORDABILITY_PERCENTAGE_2025,
  ACA_AFFORDABILITY_PERCENTAGE_2026,
  ESRP_4980H_A_ANNUAL_PENALTY_2026,
  ESRP_4980H_B_ANNUAL_PENALTY_2026,
  FEDERAL_POVERTY_LINE_2025_ANNUAL,
  determineAleStatus,
  estimate4980hAAnnualExposure,
  estimate4980hBAnnualExposure,
  fplSafeHarborMonthlyCeiling,
  isAffordableUnderW2SafeHarbor,
  lineFourteenCode,
  lineSixteenCode,
  ratePayHourlySafeHarborMonthlyCeiling,
  ratePaySalariedSafeHarborMonthlyCeiling,
} from '../payroll/aca.ts';
import type { EmployeeMonthlyHours } from '../payroll/aca.ts';

function twelveMonths(year: number): string[] {
  return Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);
}

describe('ALE determination (payroll/aca.ts)', () => {
  test('an employer with 60 full-time employees every month is an ALE', () => {
    const hours: EmployeeMonthlyHours[] = [];
    for (const month of twelveMonths(2025)) {
      for (let i = 0; i < 60; i++) hours.push({ employeeId: `e${i}`, month, hoursOfService: 160 });
    }
    const result = determineAleStatus(hours);
    assert.equal(result.isApplicableLargeEmployer, true);
    assert.equal(result.averageMonthlyFullTimeEquivalent, 60);
  });

  test('an employer with 40 full-time employees and enough part-time hours to cross 50 FTE is an ALE', () => {
    const hours: EmployeeMonthlyHours[] = [];
    for (const month of twelveMonths(2025)) {
      for (let i = 0; i < 40; i++) hours.push({ employeeId: `ft${i}`, month, hoursOfService: 160 });
      // 20 part-time employees at 60 hours/month each = 1200 hours -> 1200/120 = 10 FTE
      for (let i = 0; i < 20; i++) hours.push({ employeeId: `pt${i}`, month, hoursOfService: 60 });
    }
    const result = determineAleStatus(hours);
    assert.equal(result.monthly[0].fullTimeEmployeeCount, 40);
    assert.equal(result.monthly[0].fullTimeEquivalentCount, 10);
    assert.equal(result.averageMonthlyFullTimeEquivalent, 50);
    assert.equal(result.isApplicableLargeEmployer, true);
  });

  test('a part-time employee\'s hours are capped at 120 for the FTE calculation even if they worked more', () => {
    const hours: EmployeeMonthlyHours[] = [];
    for (const month of twelveMonths(2025)) {
      // one part-timer at 129 hours (still under the 130 full-time threshold) should count as capped-120/120 = 1 FTE, not 129/120
      hours.push({ employeeId: 'pt1', month, hoursOfService: 129 });
    }
    const result = determineAleStatus(hours);
    assert.equal(result.monthly[0].fullTimeEquivalentCount, 1);
  });

  test('a small employer under the 50-FTE threshold is not an ALE', () => {
    const hours: EmployeeMonthlyHours[] = [];
    for (const month of twelveMonths(2025)) {
      for (let i = 0; i < 10; i++) hours.push({ employeeId: `e${i}`, month, hoursOfService: 160 });
    }
    const result = determineAleStatus(hours);
    assert.equal(result.isApplicableLargeEmployer, false);
  });

  test('rounds the final annual average DOWN, per the IRS\'s own rule, rather than to the nearest whole number', () => {
    const hours: EmployeeMonthlyHours[] = [];
    for (const month of twelveMonths(2025)) {
      for (let i = 0; i < 49; i++) hours.push({ employeeId: `e${i}`, month, hoursOfService: 160 });
      // one extra part-timer contributing 0.9 FTE most months would average just under 50 -- assert floor, not round
      hours.push({ employeeId: 'pt', month, hoursOfService: 108 }); // 108/120 = 0.9 FTE
    }
    const result = determineAleStatus(hours);
    assert.equal(result.averageMonthlyFullTimeEquivalent, 49); // 49.9 floors to 49
    assert.equal(result.isApplicableLargeEmployer, false);
  });

  test('throws rather than silently averaging over the wrong number of months', () => {
    const hours: EmployeeMonthlyHours[] = twelveMonths(2025).slice(0, 9).map((month) => ({ employeeId: 'e1', month, hoursOfService: 160 }));
    assert.throws(() => determineAleStatus(hours), /12 distinct months/);
  });
});

describe('affordability safe harbors (payroll/aca.ts)', () => {
  test('FPL safe harbor monthly ceiling for 2026 compliance year matches hand calculation', () => {
    // 15,650 * 0.0996 / 12 = 129.895 -> rounds to $129.90/month
    const ceiling = fplSafeHarborMonthlyCeiling(FEDERAL_POVERTY_LINE_2025_ANNUAL, ACA_AFFORDABILITY_PERCENTAGE_2026);
    assert.equal(ceiling, dollars(129.9));
  });

  test('rate of pay safe harbor (hourly) always uses a fixed 130 hours, never actual hours worked', () => {
    const ceiling = ratePayHourlySafeHarborMonthlyCeiling(dollars(15), ACA_AFFORDABILITY_PERCENTAGE_2025);
    // 15.00 * 130 * 0.0902 = 175.89
    assert.equal(ceiling, dollars(175.89));
  });

  test('rate of pay safe harbor (salaried) is simply monthly salary times the percentage', () => {
    const ceiling = ratePaySalariedSafeHarborMonthlyCeiling(dollars(5000), ACA_AFFORDABILITY_PERCENTAGE_2026);
    assert.equal(ceiling, dollars(498));
  });

  test('W-2 safe harbor is a full-year test against Box 1 wages, not a monthly test', () => {
    const affordable = isAffordableUnderW2SafeHarbor(dollars(1500), dollars(50_000), ACA_AFFORDABILITY_PERCENTAGE_2026);
    // 9.96% of 50,000 = 4,980 >= 1,500 -> affordable
    assert.equal(affordable, true);
    const notAffordable = isAffordableUnderW2SafeHarbor(dollars(6000), dollars(50_000), ACA_AFFORDABILITY_PERCENTAGE_2026);
    assert.equal(notAffordable, false);
  });
});

describe('§4980H ESRP exposure estimates (payroll/aca.ts)', () => {
  test('4980H(a) exposure excludes the first 30 full-time employees', () => {
    const exposure = estimate4980hAAnnualExposure(80);
    assert.equal(exposure, 50 * ESRP_4980H_A_ANNUAL_PENALTY_2026);
  });

  test('4980H(a) exposure is zero for an employer at or under the 30-employee exclusion', () => {
    assert.equal(estimate4980hAAnnualExposure(30), 0);
    assert.equal(estimate4980hAAnnualExposure(10), 0);
  });

  test('4980H(b) exposure is a flat per-affected-employee penalty with no exclusion', () => {
    assert.equal(estimate4980hBAnnualExposure(5), 5 * ESRP_4980H_B_ANNUAL_PENALTY_2026);
    assert.equal(estimate4980hBAnnualExposure(0), 0);
  });
});

describe('Form 1095-C Line 14 offer codes (payroll/aca.ts)', () => {
  test('no offer of MEC at all is code 1H', () => {
    const code = lineFourteenCode(
      { offeredMinimumEssentialCoverage: false, offeredMinimumValue: false, offeredToSpouse: false, offeredToDependents: false, employeeEnrolled: false, employeeMonthlyContribution: 0 },
      dollars(130),
    );
    assert.equal(code, '1H');
  });

  test('MEC offered but not minimum value is code 1F', () => {
    const code = lineFourteenCode(
      { offeredMinimumEssentialCoverage: true, offeredMinimumValue: false, offeredToSpouse: true, offeredToDependents: true, employeeEnrolled: true, employeeMonthlyContribution: dollars(50) },
      dollars(130),
    );
    assert.equal(code, '1F');
  });

  test('MV to employee only is code 1B', () => {
    const code = lineFourteenCode(
      { offeredMinimumEssentialCoverage: true, offeredMinimumValue: true, offeredToSpouse: false, offeredToDependents: false, employeeEnrolled: true, employeeMonthlyContribution: dollars(50) },
      dollars(130),
    );
    assert.equal(code, '1B');
  });

  test('MV to employee + dependents (not spouse) is code 1C', () => {
    const code = lineFourteenCode(
      { offeredMinimumEssentialCoverage: true, offeredMinimumValue: true, offeredToSpouse: false, offeredToDependents: true, employeeEnrolled: true, employeeMonthlyContribution: dollars(50) },
      dollars(130),
    );
    assert.equal(code, '1C');
  });

  test('MV to employee + spouse (not dependents) is code 1D', () => {
    const code = lineFourteenCode(
      { offeredMinimumEssentialCoverage: true, offeredMinimumValue: true, offeredToSpouse: true, offeredToDependents: false, employeeEnrolled: true, employeeMonthlyContribution: dollars(50) },
      dollars(130),
    );
    assert.equal(code, '1D');
  });

  test('a full family offer under the qualifying-offer ceiling is code 1A, not 1E', () => {
    const code = lineFourteenCode(
      { offeredMinimumEssentialCoverage: true, offeredMinimumValue: true, offeredToSpouse: true, offeredToDependents: true, employeeEnrolled: true, employeeMonthlyContribution: dollars(100) },
      dollars(130),
    );
    assert.equal(code, '1A');
  });

  test('a full family offer above the qualifying-offer ceiling is the ordinary code 1E', () => {
    const code = lineFourteenCode(
      { offeredMinimumEssentialCoverage: true, offeredMinimumValue: true, offeredToSpouse: true, offeredToDependents: true, employeeEnrolled: true, employeeMonthlyContribution: dollars(200) },
      dollars(130),
    );
    assert.equal(code, '1E');
  });
});

describe('Form 1095-C Line 16 safe harbor codes (payroll/aca.ts)', () => {
  test('not employed that month is code 2A, checked before anything else', () => {
    const code = lineSixteenCode({ employedThisMonth: false, fullTimeThisMonth: false, enrolledInOffer: false, inLimitedNonAssessmentPeriod: false });
    assert.equal(code, '2A');
  });

  test('enrollment (2C) takes priority even over a part-time status that would otherwise be 2B', () => {
    const code = lineSixteenCode({ employedThisMonth: true, fullTimeThisMonth: false, enrolledInOffer: true, inLimitedNonAssessmentPeriod: false });
    assert.equal(code, '2C');
  });

  test('not full-time and not enrolled is code 2B', () => {
    const code = lineSixteenCode({ employedThisMonth: true, fullTimeThisMonth: false, enrolledInOffer: false, inLimitedNonAssessmentPeriod: false });
    assert.equal(code, '2B');
  });

  test('a limited non-assessment period is code 2D', () => {
    const code = lineSixteenCode({ employedThisMonth: true, fullTimeThisMonth: true, enrolledInOffer: false, inLimitedNonAssessmentPeriod: true });
    assert.equal(code, '2D');
  });

  test('an affordability safe harbor maps to its own code when the employer passed the 95% offer test', () => {
    assert.equal(lineSixteenCode({ employedThisMonth: true, fullTimeThisMonth: true, enrolledInOffer: false, inLimitedNonAssessmentPeriod: false, affordabilitySafeHarborUsed: 'fpl' }), '2G');
    assert.equal(lineSixteenCode({ employedThisMonth: true, fullTimeThisMonth: true, enrolledInOffer: false, inLimitedNonAssessmentPeriod: false, affordabilitySafeHarborUsed: 'rate-of-pay' }), '2H');
    assert.equal(lineSixteenCode({ employedThisMonth: true, fullTimeThisMonth: true, enrolledInOffer: false, inLimitedNonAssessmentPeriod: false, affordabilitySafeHarborUsed: 'w2' }), '2F');
  });

  test('a safe harbor code must never be entered for a month the ALE failed the 95% offer test outright', () => {
    const code = lineSixteenCode({
      employedThisMonth: true,
      fullTimeThisMonth: true,
      enrolledInOffer: false,
      inLimitedNonAssessmentPeriod: false,
      affordabilitySafeHarborUsed: 'fpl',
      aleFailed95PercentOfferTest: true,
    });
    assert.equal(code, undefined);
  });

  test('no code applies when nothing else matches (a genuine, valid blank line 16)', () => {
    const code = lineSixteenCode({ employedThisMonth: true, fullTimeThisMonth: true, enrolledInOffer: false, inLimitedNonAssessmentPeriod: false });
    assert.equal(code, undefined);
  });
});
