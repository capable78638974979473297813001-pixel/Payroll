import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { dollars } from '../src/money.ts';
import {
  NJ_FLI_MAX_WEEKLY_BENEFIT_2026,
  NJ_FLI_MIN_BASE_WEEKS,
  NJ_FLI_MIN_WEEKLY_EARNINGS_2026,
  NJ_FLI_MIN_BASE_YEAR_EARNINGS_2026,
  NJ_FLI_MAX_CONTINUOUS_LEAVE_WEEKS,
  NJ_FLI_MAX_INTERMITTENT_LEAVE_DAYS,
  isNjFliEligibleByBaseWeeks,
  isNjFliEligibleByAnnualEarnings,
  isNjFliEligible,
  njFliWeeklyBenefit,
  njFliRemainingContinuousWeeks,
  njFliRemainingIntermittentDays,
} from '../payroll/njFli.ts';

describe('New Jersey Family Leave Insurance (payroll/njFli.ts)', () => {
  test('the base-weeks path requires 20+ weeks each earning at least $310', () => {
    assert.equal(isNjFliEligibleByBaseWeeks(19, NJ_FLI_MIN_WEEKLY_EARNINGS_2026), false);
    assert.equal(isNjFliEligibleByBaseWeeks(NJ_FLI_MIN_BASE_WEEKS, NJ_FLI_MIN_WEEKLY_EARNINGS_2026 - 1), false);
    assert.equal(isNjFliEligibleByBaseWeeks(NJ_FLI_MIN_BASE_WEEKS, NJ_FLI_MIN_WEEKLY_EARNINGS_2026), true);
  });

  test('the annual-earnings path requires at least $15,500 in the base year, independent of weekly distribution', () => {
    assert.equal(isNjFliEligibleByAnnualEarnings(NJ_FLI_MIN_BASE_YEAR_EARNINGS_2026 - dollars(1)), false);
    assert.equal(isNjFliEligibleByAnnualEarnings(NJ_FLI_MIN_BASE_YEAR_EARNINGS_2026), true);
  });

  test('overall eligibility is true if EITHER path is satisfied', () => {
    assert.equal(isNjFliEligible(NJ_FLI_MIN_BASE_WEEKS, NJ_FLI_MIN_WEEKLY_EARNINGS_2026, dollars(0)), true);
    assert.equal(isNjFliEligible(0, dollars(0), NJ_FLI_MIN_BASE_YEAR_EARNINGS_2026), true);
    assert.equal(isNjFliEligible(5, dollars(100), dollars(1_000)), false);
  });

  test('the weekly benefit is 85% of average weekly wage below the cap', () => {
    assert.equal(njFliWeeklyBenefit(dollars(1_000)), dollars(850));
  });

  test('the weekly benefit caps at the 2026 maximum, matching the NJ DOL\'s own published $1,119 figure', () => {
    assert.equal(njFliWeeklyBenefit(dollars(5_000)), NJ_FLI_MAX_WEEKLY_BENEFIT_2026);
  });

  test('remaining continuous weeks and intermittent days count down from their own separate 12-week/56-day caps', () => {
    assert.equal(njFliRemainingContinuousWeeks(0), NJ_FLI_MAX_CONTINUOUS_LEAVE_WEEKS);
    assert.equal(njFliRemainingContinuousWeeks(5), 7);
    assert.equal(njFliRemainingContinuousWeeks(20), 0); // never negative
    assert.equal(njFliRemainingIntermittentDays(0), NJ_FLI_MAX_INTERMITTENT_LEAVE_DAYS);
    assert.equal(njFliRemainingIntermittentDays(50), 6);
    assert.equal(njFliRemainingIntermittentDays(100), 0);
  });
});
