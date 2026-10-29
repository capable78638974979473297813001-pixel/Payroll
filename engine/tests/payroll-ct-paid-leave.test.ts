import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { dollars } from '../src/money.ts';
import {
  CT_PAID_LEAVE_MIN_HIGHEST_QUARTER_EARNINGS,
  CT_PAID_LEAVE_MAX_WEEKS_SINCE_SEPARATION,
  ctPaidLeaveTierThreshold,
  ctPaidLeaveMaxWeeklyBenefit,
  ctPaidLeaveWeeklyBenefit,
  ctMeetsHighestQuarterEarningsTest,
  ctMeetsRecentEmploymentTest,
  isCtPaidLeaveEligible,
} from '../payroll/ctPaidLeave.ts';

describe('Connecticut Paid Leave (payroll/ctPaidLeave.ts)', () => {
  test('the tier threshold is 40x the 2026 minimum wage ($677.60)', () => {
    assert.equal(ctPaidLeaveTierThreshold(), dollars(677.6));
  });

  test('the maximum weekly benefit is 60x the 2026 minimum wage ($1,016.40)', () => {
    assert.equal(ctPaidLeaveMaxWeeklyBenefit(), dollars(1_016.4));
  });

  test('a wage at or below the threshold is replaced at a flat 95%', () => {
    assert.equal(ctPaidLeaveWeeklyBenefit(dollars(500)), dollars(475));
    assert.equal(ctPaidLeaveWeeklyBenefit(ctPaidLeaveTierThreshold()), dollars(643.72));
  });

  test('a wage above the threshold gets 95% of the threshold plus 60% of the excess, hand-verified to the cent', () => {
    // 95% of $677.60 = $643.72 (rounded) + 60% of ($1,000 - $677.60 = $322.40) = $193.44 -> $837.16
    assert.equal(ctPaidLeaveWeeklyBenefit(dollars(1_000)), dollars(837.16));
  });

  test('the benefit caps at the maximum for a very high wage', () => {
    assert.equal(ctPaidLeaveWeeklyBenefit(dollars(5_000)), ctPaidLeaveMaxWeeklyBenefit());
  });

  test('the highest-quarter earnings test requires at least $2,325', () => {
    assert.equal(ctMeetsHighestQuarterEarningsTest(CT_PAID_LEAVE_MIN_HIGHEST_QUARTER_EARNINGS - dollars(1)), false);
    assert.equal(ctMeetsHighestQuarterEarningsTest(CT_PAID_LEAVE_MIN_HIGHEST_QUARTER_EARNINGS), true);
  });

  test('the recent-employment test passes if currently employed, regardless of weeks since separation', () => {
    assert.equal(ctMeetsRecentEmploymentTest(true, 999), true);
  });

  test('the recent-employment test passes for someone not currently employed only within 12 weeks of separation', () => {
    assert.equal(ctMeetsRecentEmploymentTest(false, CT_PAID_LEAVE_MAX_WEEKS_SINCE_SEPARATION), true);
    assert.equal(ctMeetsRecentEmploymentTest(false, CT_PAID_LEAVE_MAX_WEEKS_SINCE_SEPARATION + 1), false);
  });

  test('overall eligibility requires BOTH independent tests to pass', () => {
    assert.equal(isCtPaidLeaveEligible(dollars(2_325), true, 0), true);
    assert.equal(isCtPaidLeaveEligible(dollars(2_324), true, 0), false); // fails earnings test
    assert.equal(isCtPaidLeaveEligible(dollars(2_325), false, 13), false); // fails recent-employment test
  });
});
