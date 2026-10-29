import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { dollars } from '../src/money.ts';
import {
  WA_PFML_MIN_HOURS_WORKED,
  WA_PFML_MAX_WEEKLY_BENEFIT_2026,
  WA_PFML_MIN_WEEKLY_BENEFIT_2026,
  isWaPfmlEligible,
  waPfmlTierThreshold,
  waPfmlWeeklyBenefit,
} from '../payroll/waPfml.ts';

describe('Washington PFML (payroll/waPfml.ts)', () => {
  test('eligibility requires at least 820 hours in the qualifying period', () => {
    assert.equal(isWaPfmlEligible(WA_PFML_MIN_HOURS_WORKED - 1), false);
    assert.equal(isWaPfmlEligible(WA_PFML_MIN_HOURS_WORKED), true);
  });

  test('the tier threshold is half the 2026 SAWW ($915)', () => {
    assert.equal(waPfmlTierThreshold(), dollars(915));
  });

  test('an average weekly wage under $100 gets the full wage, not the $100 floor', () => {
    assert.equal(waPfmlWeeklyBenefit(dollars(50)), dollars(50));
  });

  test('an average weekly wage at or above $100 but whose 90% would fall below $100 is floored at $100', () => {
    assert.equal(waPfmlWeeklyBenefit(dollars(105)), WA_PFML_MIN_WEEKLY_BENEFIT_2026);
  });

  test('a wage entirely below the tier threshold is replaced at a flat 90%', () => {
    assert.equal(waPfmlWeeklyBenefit(dollars(500)), dollars(450));
  });

  test('a wage exactly at the tier threshold uses only the 90% tier', () => {
    assert.equal(waPfmlWeeklyBenefit(dollars(915)), dollars(823.5));
  });

  test('a wage above the threshold uses the two-tier formula, hand-verified to the cent', () => {
    // 90% of $915 = $823.50, plus 50% of ($2000 - $915) = $542.50 → $1,366.00
    assert.equal(waPfmlWeeklyBenefit(dollars(2_000)), dollars(1_366));
  });

  test('the benefit caps at the 2026 maximum, matching the statute\'s own published $1,647 figure', () => {
    assert.equal(waPfmlWeeklyBenefit(dollars(5_000)), WA_PFML_MAX_WEEKLY_BENEFIT_2026);
  });
});
