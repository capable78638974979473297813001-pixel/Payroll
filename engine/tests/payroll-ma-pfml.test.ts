import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { dollars } from '../src/money.ts';
import {
  MA_PFML_MAX_WEEKLY_BENEFIT_2026,
  MA_PFML_MIN_BASE_PERIOD_EARNINGS_2026,
  maPfmlTierThreshold,
  maPfmlWeeklyBenefit,
  maMeetsMinimumEarningsTest,
  maMeetsThirtyTimesBenefitTest,
  isMaPfmlEligible,
} from '../payroll/maPfml.ts';

describe('Massachusetts PFML (payroll/maPfml.ts)', () => {
  test('the tier threshold is 50% of the 2026 MAAWW ($961.24)', () => {
    assert.equal(maPfmlTierThreshold(), dollars(961.24));
  });

  test('a wage entirely below the threshold is replaced at a flat 80%', () => {
    assert.equal(maPfmlWeeklyBenefit(dollars(500)), dollars(400));
  });

  test('a wage above the threshold uses the two-tier formula, hand-verified to the cent', () => {
    // 80% of $961.24 = $768.99 (rounded) + 50% of $238.76 = $119.38 → $888.37
    assert.equal(maPfmlWeeklyBenefit(dollars(1_200)), dollars(888.37));
  });

  test('a wage exactly at the threshold is entirely in the lower (80%) tier', () => {
    const threshold = maPfmlTierThreshold();
    assert.equal(maPfmlWeeklyBenefit(threshold), Math.round(threshold * 0.8));
  });

  test('the benefit caps at the 2026 maximum, matching DFML\'s own published $1,230.39 figure', () => {
    assert.equal(maPfmlWeeklyBenefit(dollars(10_000)), MA_PFML_MAX_WEEKLY_BENEFIT_2026);
  });

  test('the minimum earnings test requires at least $6,300 in the base period', () => {
    assert.equal(maMeetsMinimumEarningsTest(MA_PFML_MIN_BASE_PERIOD_EARNINGS_2026 - dollars(1)), false);
    assert.equal(maMeetsMinimumEarningsTest(MA_PFML_MIN_BASE_PERIOD_EARNINGS_2026), true);
  });

  test('the 30x test requires base-period earnings to STRICTLY exceed 30 times the weekly benefit', () => {
    assert.equal(maMeetsThirtyTimesBenefitTest(dollars(3_000), dollars(100)), false); // exactly 30x, not more
    assert.equal(maMeetsThirtyTimesBenefitTest(dollars(3_001), dollars(100)), true);
  });

  test('overall eligibility requires BOTH tests to pass', () => {
    assert.equal(isMaPfmlEligible(dollars(6_300), dollars(100)), true); // meets both: $6,300 >= min, and > 30*$100=$3,000
    assert.equal(isMaPfmlEligible(dollars(6_299), dollars(100)), false); // fails the minimum-earnings test
    assert.equal(isMaPfmlEligible(dollars(10_000), dollars(400)), false); // meets minimum but not 30x ($10,000 < 30*$400=$12,000)
  });
});
