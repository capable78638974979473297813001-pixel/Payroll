import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  CA_SICK_LEAVE_ACCRUAL_CAP_HOURS,
  CA_SICK_LEAVE_ANNUAL_USAGE_CAP_HOURS,
  caSickLeaveUseEligibleDate,
  isEligibleToUseCaSickLeave,
  accrueCaSickLeaveHours,
  maxUsableCaSickLeaveHours,
  caSickLeaveReinstatementDeadline,
  isCaSickLeaveReinstatementRequired,
  caSickLeaveBalanceToReinstate,
  caPaidSickLeavePolicyComplianceIssues,
} from '../payroll/paidSickLeave.ts';
import type { PtoPolicy } from '../payroll/pto.ts';

describe('California paid sick leave (payroll/paidSickLeave.ts)', () => {
  test('the 90th day of employment is 89 days after hire (hire date itself is day 1)', () => {
    assert.equal(caSickLeaveUseEligibleDate('2026-01-01'), '2026-03-31');
  });

  test('an employee cannot use sick leave before their 90th day of employment', () => {
    assert.equal(isEligibleToUseCaSickLeave('2026-01-01', '2026-03-30'), false);
    assert.equal(isEligibleToUseCaSickLeave('2026-01-01', '2026-03-31'), true);
    assert.equal(isEligibleToUseCaSickLeave('2026-01-01', '2026-06-01'), true);
  });

  test('accrual is 1 hour per 30 hours worked', () => {
    assert.equal(accrueCaSickLeaveHours(0, 30), 1);
    assert.equal(accrueCaSickLeaveHours(0, 300), 10);
    assert.equal(accrueCaSickLeaveHours(5, 60), 7);
  });

  test('accrual is capped at 80 hours even when hours worked would produce more', () => {
    assert.equal(accrueCaSickLeaveHours(75, 300), CA_SICK_LEAVE_ACCRUAL_CAP_HOURS);
    assert.equal(accrueCaSickLeaveHours(80, 30), CA_SICK_LEAVE_ACCRUAL_CAP_HOURS);
  });

  test('usable hours are capped at 40/year even when the balance is higher', () => {
    assert.equal(maxUsableCaSickLeaveHours(80, 0), CA_SICK_LEAVE_ANNUAL_USAGE_CAP_HOURS);
    assert.equal(maxUsableCaSickLeaveHours(80, 35), 5);
    assert.equal(maxUsableCaSickLeaveHours(80, 40), 0);
    assert.equal(maxUsableCaSickLeaveHours(80, 45), 0); // never negative
  });

  test('usable hours are capped by the balance itself when the balance is below the usage cap', () => {
    assert.equal(maxUsableCaSickLeaveHours(10, 0), 10);
    assert.equal(maxUsableCaSickLeaveHours(0, 0), 0);
  });

  test('reinstatement deadline is 12 calendar months after separation', () => {
    assert.equal(caSickLeaveReinstatementDeadline('2026-06-15'), '2027-06-15');
  });

  test('a rehire on or before the 12-month deadline requires reinstatement; after it does not', () => {
    assert.equal(isCaSickLeaveReinstatementRequired('2026-06-15', '2027-06-15'), true);
    assert.equal(isCaSickLeaveReinstatementRequired('2026-06-15', '2027-06-16'), false);
    assert.equal(isCaSickLeaveReinstatementRequired('2026-06-15', '2026-12-01'), true);
  });

  test('reinstatement restores the prior balance unless it was already paid out at separation', () => {
    assert.equal(caSickLeaveBalanceToReinstate(24, false), 24);
    assert.equal(caSickLeaveBalanceToReinstate(24, true), 0);
  });

  test('a perHourWorked policy below the 1/30 accrual rate is flagged', () => {
    const policy: PtoPolicy = { id: 'p1', name: 'Basic', accrual: { kind: 'perHourWorked', hoursAccruedPerHourWorked: 1 / 40 } };
    const issues = caPaidSickLeavePolicyComplianceIssues(policy);
    assert.equal(issues.length, 1);
    assert.match(issues[0], /Accrual rate/);
  });

  test('a perHourWorked policy at or above the 1/30 rate with no caps is fully compliant', () => {
    const policy: PtoPolicy = { id: 'p1', name: 'Generous', accrual: { kind: 'perHourWorked', hoursAccruedPerHourWorked: 1 / 20 } };
    assert.deepEqual(caPaidSickLeavePolicyComplianceIssues(policy), []);
  });

  test('an accrual cap below 80 hours is flagged', () => {
    const policy: PtoPolicy = { id: 'p1', name: 'Capped', accrual: { kind: 'perHourWorked', hoursAccruedPerHourWorked: 1 / 30 }, maxBalanceHours: 48 };
    const issues = caPaidSickLeavePolicyComplianceIssues(policy);
    assert.equal(issues.length, 1);
    assert.match(issues[0], /Accrual cap/);
  });

  test('a carryover cap below 80 hours is flagged separately from the accrual cap', () => {
    const policy: PtoPolicy = {
      id: 'p1', name: 'Low carryover', accrual: { kind: 'perHourWorked', hoursAccruedPerHourWorked: 1 / 30 },
      maxBalanceHours: 80, annualCarryoverCapHours: 24,
    };
    const issues = caPaidSickLeavePolicyComplianceIssues(policy);
    assert.equal(issues.length, 1);
    assert.match(issues[0], /Carryover cap/);
  });

  test('a perPayPeriod policy is not flagged on accrual rate at all, only on caps', () => {
    const compliant: PtoPolicy = { id: 'p1', name: 'Flat', accrual: { kind: 'perPayPeriod', hoursPerPeriod: 4 } };
    assert.deepEqual(caPaidSickLeavePolicyComplianceIssues(compliant), []);

    const lowCap: PtoPolicy = { id: 'p1', name: 'Flat capped', accrual: { kind: 'perPayPeriod', hoursPerPeriod: 4 }, maxBalanceHours: 40 };
    const issues = caPaidSickLeavePolicyComplianceIssues(lowCap);
    assert.equal(issues.length, 1);
    assert.match(issues[0], /Accrual cap/);
  });
});
