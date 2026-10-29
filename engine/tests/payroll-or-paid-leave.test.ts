import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { dollars } from '../src/money.ts';
import {
  OR_PAID_LEAVE_MIN_BASE_YEAR_EARNINGS,
  OR_PAID_LEAVE_STANDARD_MAX_WEEKS,
  OR_PAID_LEAVE_COMBINED_MAX_WEEKS,
  orPaidLeaveTierThreshold,
  orPaidLeaveMinWeeklyBenefit,
  orPaidLeaveMaxWeeklyBenefit,
  orPaidLeaveWeeklyBenefit,
  isOrPaidLeaveEligible,
  orPaidLeaveMaxWeeksAvailable,
} from '../payroll/orPaidLeave.ts';

describe('Paid Leave Oregon (payroll/orPaidLeave.ts)', () => {
  test('the tier threshold is 65% of the 2026-2027 SAWW ($916.58)', () => {
    assert.equal(orPaidLeaveTierThreshold(), dollars(916.58));
  });

  test('the minimum weekly benefit is 5% of the SAWW ($70.51), matching the Employment Department\'s own published figure', () => {
    assert.equal(orPaidLeaveMinWeeklyBenefit(), dollars(70.51));
  });

  test('the maximum weekly benefit is 120% of the SAWW ($1,692.16), matching the Employment Department\'s own published figure', () => {
    assert.equal(orPaidLeaveMaxWeeklyBenefit(), dollars(1_692.16));
  });

  test('a wage at or below the threshold is replaced at a flat 100%', () => {
    assert.equal(orPaidLeaveWeeklyBenefit(dollars(500)), dollars(500));
    assert.equal(orPaidLeaveWeeklyBenefit(orPaidLeaveTierThreshold()), orPaidLeaveTierThreshold());
  });

  test('a wage above the threshold gets the threshold plus 50% of the excess, hand-verified to the cent', () => {
    // threshold $916.58 + 50% of ($1,500 - $916.58) = $916.58 + $291.71 = $1,208.29
    assert.equal(orPaidLeaveWeeklyBenefit(dollars(1_500)), dollars(1_208.29));
  });

  test('the benefit floors at the minimum for a very low wage', () => {
    assert.equal(orPaidLeaveWeeklyBenefit(dollars(1)), orPaidLeaveMinWeeklyBenefit());
  });

  test('the benefit caps at the maximum for a very high wage', () => {
    assert.equal(orPaidLeaveWeeklyBenefit(dollars(5_000)), orPaidLeaveMaxWeeklyBenefit());
  });

  test('eligibility requires at least $1,000 in base-year earnings, with no other test', () => {
    assert.equal(isOrPaidLeaveEligible(OR_PAID_LEAVE_MIN_BASE_YEAR_EARNINGS - dollars(1)), false);
    assert.equal(isOrPaidLeaveEligible(OR_PAID_LEAVE_MIN_BASE_YEAR_EARNINGS), true);
  });

  test('leave weeks default to 12, extending to 14 for a pregnancy/childbirth-related condition', () => {
    assert.equal(orPaidLeaveMaxWeeksAvailable(false), OR_PAID_LEAVE_STANDARD_MAX_WEEKS);
    assert.equal(orPaidLeaveMaxWeeksAvailable(true), OR_PAID_LEAVE_COMBINED_MAX_WEEKS);
    assert.equal(OR_PAID_LEAVE_COMBINED_MAX_WEEKS, 14);
  });
});
