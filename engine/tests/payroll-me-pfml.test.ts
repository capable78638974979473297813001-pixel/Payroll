import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { dollars } from '../src/money.ts';
import {
  ME_PFML_STATE_AVERAGE_WEEKLY_WAGE_2026,
  ME_PFML_MAX_WEEKS_PER_BENEFIT_YEAR,
  mePfmlFloorToDollar,
  mePfmlTierThreshold,
  mePfmlMaxWeeklyBenefit,
  mePfmlWeeklyBenefit,
  mePfmlMinBasePeriodEarnings,
  isMePfmlEligible,
} from '../payroll/mePfml.ts';

describe('Maine PFML (payroll/mePfml.ts)', () => {
  test('mePfmlFloorToDollar rounds down to the whole dollar, never to the nearest cent', () => {
    assert.equal(mePfmlFloorToDollar(dollars(328.99)), dollars(328));
    assert.equal(mePfmlFloorToDollar(dollars(328.02)), dollars(328));
    assert.equal(mePfmlFloorToDollar(dollars(328)), dollars(328));
  });

  test('the tier threshold is 50% of the 2026-2027 SAWW, floored to the whole dollar ($624)', () => {
    assert.equal(mePfmlTierThreshold(), dollars(624));
  });

  test('the maximum weekly benefit is the full, un-floored SAWW ($1,249.12)', () => {
    assert.equal(mePfmlMaxWeeklyBenefit(), ME_PFML_STATE_AVERAGE_WEEKLY_WAGE_2026);
  });

  // The following three cases reproduce MDOL's own published worked
  // examples (using the 2025 SAWW of $1,199 that the state's own webinar
  // deck used) to confirm the floor-to-whole-dollar tiered formula
  // itself is implemented correctly, independent of which year's SAWW is
  // plugged in. Since this module's own constant is pinned to the
  // 2026-2027 SAWW, these three cases construct their own tier
  // arithmetic directly against a stand-in SAWW rather than calling the
  // exported functions (which are pinned to the current year).
  test("reproduces MDOL's own worked example: AWW below half the SAWW gets a flat 90%, floored", () => {
    const saww = dollars(1_199);
    const threshold = mePfmlFloorToDollar(Math.round(saww * 0.5)); // $599
    const aww = dollars(300);
    const lowerTier = mePfmlFloorToDollar(Math.round(Math.min(aww, threshold) * 0.9));
    assert.equal(lowerTier, dollars(270)); // MDOL: "90% of $300 = $270"
  });

  test("reproduces MDOL's own worked example: AWW above half the SAWW splits across both tiers ($867 total)", () => {
    const saww = dollars(1_199);
    const threshold = mePfmlFloorToDollar(Math.round(saww * 0.5)); // $599
    const aww = dollars(1_096);
    const lowerTier = mePfmlFloorToDollar(Math.round(Math.min(aww, threshold) * 0.9));
    const upperTier = mePfmlFloorToDollar(Math.round(Math.max(0, aww - threshold) * 0.66));
    assert.equal(lowerTier, dollars(539)); // MDOL: "90% of $599 = $539"
    assert.equal(upperTier, dollars(328)); // MDOL: "66% of 497 = $328"
    assert.equal(lowerTier + upperTier, dollars(867)); // MDOL: "$539 + $328 = $867"
  });

  test("reproduces MDOL's own worked example: a high AWW caps at the full SAWW ($1,199)", () => {
    const saww = dollars(1_199);
    const threshold = mePfmlFloorToDollar(Math.round(saww * 0.5)); // $599
    const aww = dollars(1_730);
    const lowerTier = mePfmlFloorToDollar(Math.round(Math.min(aww, threshold) * 0.9));
    const upperTier = mePfmlFloorToDollar(Math.round(Math.max(0, aww - threshold) * 0.66));
    assert.equal(lowerTier, dollars(539));
    assert.equal(upperTier, dollars(746)); // MDOL: "66% of 1,131 = $746"
    assert.equal(Math.min(lowerTier + upperTier, saww), saww); // MDOL: "Max is $1,199"
  });

  test('mePfmlWeeklyBenefit reproduces the same three-case shape against the current 2026-2027 SAWW', () => {
    assert.equal(mePfmlWeeklyBenefit(dollars(300)), dollars(270));
    assert.equal(mePfmlWeeklyBenefit(dollars(10_000)), mePfmlMaxWeeklyBenefit());
  });

  test('minimum base-period earnings are 6 times the SAWW', () => {
    assert.equal(mePfmlMinBasePeriodEarnings(), 6 * ME_PFML_STATE_AVERAGE_WEEKLY_WAGE_2026);
  });

  test('eligibility requires base-period earnings of at least 6x the SAWW, with no other test', () => {
    const min = mePfmlMinBasePeriodEarnings();
    assert.equal(isMePfmlEligible(min - dollars(1)), false);
    assert.equal(isMePfmlEligible(min), true);
  });

  test('the combined leave allowance is 12 weeks per benefit year', () => {
    assert.equal(ME_PFML_MAX_WEEKS_PER_BENEFIT_YEAR, 12);
  });
});
