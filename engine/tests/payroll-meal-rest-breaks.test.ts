import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { dollars } from '../src/money.ts';
import {
  isFirstMealPeriodRequired,
  isFirstMealPeriodWaivable,
  isSecondMealPeriodRequired,
  isSecondMealPeriodWaivable,
  isRestBreakRequired,
  restBreaksRequired,
  mealPeriodPremium,
  restPeriodPremium,
  dailyMealAndRestPremium,
} from '../payroll/mealRestBreaks.ts';

describe('California meal and rest breaks (payroll/mealRestBreaks.ts)', () => {
  test('a first meal period is required once the workday exceeds 5 hours', () => {
    assert.equal(isFirstMealPeriodRequired(5), false);
    assert.equal(isFirstMealPeriodRequired(5.01), true);
  });

  test('a first meal period is waivable only at or under 6 hours', () => {
    assert.equal(isFirstMealPeriodWaivable(6), true);
    assert.equal(isFirstMealPeriodWaivable(6.01), false);
  });

  test('a second meal period is required once the workday exceeds 10 hours', () => {
    assert.equal(isSecondMealPeriodRequired(10), false);
    assert.equal(isSecondMealPeriodRequired(10.01), true);
  });

  test('a second meal period is waivable at or under 12 hours only if the first was not waived', () => {
    assert.equal(isSecondMealPeriodWaivable(12, false), true);
    assert.equal(isSecondMealPeriodWaivable(12.01, false), false);
    assert.equal(isSecondMealPeriodWaivable(12, true), false);
  });

  test('no rest break is required below 3.5 hours; one is required at or above it', () => {
    assert.equal(isRestBreakRequired(3.49), false);
    assert.equal(isRestBreakRequired(3.5), true);
  });

  test('rest breaks required follow the "major fraction of 4 hours" schedule', () => {
    assert.equal(restBreaksRequired(3.4), 0);
    assert.equal(restBreaksRequired(3.5), 1);
    assert.equal(restBreaksRequired(6), 1); // exactly half of the second block, not yet a major fraction
    assert.equal(restBreaksRequired(6.01), 2);
    assert.equal(restBreaksRequired(10), 2);
    assert.equal(restBreaksRequired(10.01), 3);
    assert.equal(restBreaksRequired(14), 3);
    assert.equal(restBreaksRequired(14.01), 4);
  });

  test('meal and rest premiums are each exactly one hour of pay when a violation occurred, zero otherwise', () => {
    assert.equal(mealPeriodPremium(true, dollars(20)), dollars(20));
    assert.equal(mealPeriodPremium(false, dollars(20)), 0);
    assert.equal(restPeriodPremium(true, dollars(20)), dollars(20));
    assert.equal(restPeriodPremium(false, dollars(20)), 0);
  });

  test('both premiums are additive but each stays capped at one hour regardless of violation count, so the daily total never exceeds two hours', () => {
    assert.equal(dailyMealAndRestPremium(true, true, dollars(20)), dollars(40));
    assert.equal(dailyMealAndRestPremium(true, false, dollars(20)), dollars(20));
    assert.equal(dailyMealAndRestPremium(false, true, dollars(20)), dollars(20));
    assert.equal(dailyMealAndRestPremium(false, false, dollars(20)), 0);
  });
});
