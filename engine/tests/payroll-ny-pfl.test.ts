import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { dollars } from '../src/money.ts';
import {
  NY_PFL_STATEWIDE_AVERAGE_WEEKLY_WAGE_2026,
  NY_PFL_MAX_WEEKLY_BENEFIT_2026,
  isFullTimePflEligible,
  isPartTimePflEligible,
  isPflEligible,
  nyPflWeeklyBenefit,
} from '../payroll/nyPfl.ts';

describe('New York Paid Family Leave (payroll/nyPfl.ts)', () => {
  test('a full-time (20+ hours) employee is eligible at exactly 26 consecutive weeks', () => {
    assert.equal(isFullTimePflEligible(20, 25), false);
    assert.equal(isFullTimePflEligible(20, 26), true);
    assert.equal(isFullTimePflEligible(40, 26), true);
  });

  test('a schedule under 20 hours/week never qualifies under the full-time test, however many weeks', () => {
    assert.equal(isFullTimePflEligible(19, 100), false);
  });

  test('a part-time (under 20 hours) employee is eligible at exactly 175 days worked', () => {
    assert.equal(isPartTimePflEligible(15, 174), false);
    assert.equal(isPartTimePflEligible(15, 175), true);
  });

  test('a schedule at or above 20 hours/week never qualifies under the part-time test, however many days', () => {
    assert.equal(isPartTimePflEligible(20, 1000), false);
  });

  test('overall eligibility is true if EITHER track is satisfied', () => {
    assert.equal(isPflEligible(40, 26, 0), true);
    assert.equal(isPflEligible(15, 0, 175), true);
    assert.equal(isPflEligible(40, 10, 50), false);
  });

  test('the weekly benefit is 67% of the employee\'s own average weekly wage below the cap', () => {
    assert.equal(nyPflWeeklyBenefit(dollars(1_000)), Math.round(dollars(1_000) * 0.67));
  });

  test('the weekly benefit caps at 67% of the statewide average weekly wage, matching the WCB\'s own published $1,228.53 figure', () => {
    assert.equal(nyPflWeeklyBenefit(NY_PFL_STATEWIDE_AVERAGE_WEEKLY_WAGE_2026), NY_PFL_MAX_WEEKLY_BENEFIT_2026);
    assert.equal(nyPflWeeklyBenefit(dollars(5_000)), NY_PFL_MAX_WEEKLY_BENEFIT_2026); // a high earner is capped, not paid 67% of their own wage
  });
});
