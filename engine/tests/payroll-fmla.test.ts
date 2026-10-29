import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  FMLA_MINIMUM_HOURS_OF_SERVICE,
  FMLA_MINIMUM_MONTHS_EMPLOYED,
  FMLA_WORKSITE_EMPLOYEE_THRESHOLD,
  checkFmlaEligibility,
  fmlaHoursEntitlement,
  fmlaHoursRemaining,
} from '../payroll/fmla.ts';

function eligibleInput() {
  return { monthsEmployed: 24, hoursOfServicePastTwelveMonths: 2000, employeeCountAtWorksite: 75 };
}

describe('FMLA eligibility (payroll/fmla.ts)', () => {
  test('an employee meeting all three prongs is eligible with no reasons listed', () => {
    const result = checkFmlaEligibility(eligibleInput());
    assert.equal(result.eligible, true);
    assert.deepEqual(result.reasons, []);
  });

  test('fewer than 12 months employed fails, with a specific reason', () => {
    const result = checkFmlaEligibility({ ...eligibleInput(), monthsEmployed: 6 });
    assert.equal(result.eligible, false);
    assert.equal(result.reasons.length, 1);
    assert.match(result.reasons[0], /Fewer than 12 months employed/);
  });

  test('fewer than 1,250 hours of service fails, with a specific reason', () => {
    const result = checkFmlaEligibility({ ...eligibleInput(), hoursOfServicePastTwelveMonths: 900 });
    assert.equal(result.eligible, false);
    assert.match(result.reasons[0], /Fewer than 1250 hours/);
  });

  test('fewer than 50 employees at the worksite fails, with a specific reason', () => {
    const result = checkFmlaEligibility({ ...eligibleInput(), employeeCountAtWorksite: 10 });
    assert.equal(result.eligible, false);
    assert.match(result.reasons[0], /Fewer than 50 employees within 75 miles/);
  });

  test('failing all three prongs reports all three reasons, not just the first', () => {
    const result = checkFmlaEligibility({ monthsEmployed: 0, hoursOfServicePastTwelveMonths: 0, employeeCountAtWorksite: 0 });
    assert.equal(result.eligible, false);
    assert.equal(result.reasons.length, 3);
  });

  test('exactly at each threshold passes (the test is "at least", not "more than")', () => {
    const result = checkFmlaEligibility({
      monthsEmployed: FMLA_MINIMUM_MONTHS_EMPLOYED,
      hoursOfServicePastTwelveMonths: FMLA_MINIMUM_HOURS_OF_SERVICE,
      employeeCountAtWorksite: FMLA_WORKSITE_EMPLOYEE_THRESHOLD,
    });
    assert.equal(result.eligible, true);
  });
});

describe('FMLA leave entitlement (payroll/fmla.ts)', () => {
  test('a full-time (40 hr/week) employee\'s entitlement is 480 hours (12 weeks)', () => {
    assert.equal(fmlaHoursEntitlement(40), 480);
  });

  test('a part-time employee\'s entitlement is proportionally smaller, never a flat 480', () => {
    assert.equal(fmlaHoursEntitlement(20), 240);
  });

  test('remaining hours subtract usage correctly', () => {
    assert.equal(fmlaHoursRemaining(480, 100), 380);
  });

  test('remaining hours never go negative, even if usage somehow exceeds the entitlement', () => {
    assert.equal(fmlaHoursRemaining(480, 600), 0);
  });
});
