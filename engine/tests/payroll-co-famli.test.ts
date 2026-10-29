import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { dollars } from '../src/money.ts';
import {
  CO_FAMLI_MIN_BASE_PERIOD_EARNINGS,
  CO_FAMLI_STANDARD_LEAVE_MAX_WEEKS,
  CO_FAMLI_COMBINED_MAX_WEEKS,
  coFamliTierThreshold,
  coFamliMaxWeeklyBenefit,
  coFamliWeeklyBenefit,
  isCoFamliEligible,
  coFamliMaxWeeksAvailable,
} from '../payroll/coFamli.ts';

describe('Colorado FAMLI (payroll/coFamli.ts)', () => {
  test('the tier threshold is 50% of the 2026-2027 SAWW ($804.46)', () => {
    assert.equal(coFamliTierThreshold(), dollars(804.46));
  });

  test('the maximum weekly benefit is 90% of the full SAWW ($1,448.02)', () => {
    assert.equal(coFamliMaxWeeklyBenefit(), dollars(1_448.02));
  });

  test('a wage entirely below the threshold is replaced at a flat 90%', () => {
    assert.equal(coFamliWeeklyBenefit(dollars(500)), dollars(450));
  });

  test('a wage above the threshold uses the two-tier formula, hand-verified to the cent', () => {
    // lower tier: 90% of $804.46 = $724.014 -> $724.01 (rounded)
    // upper tier: wage $1,000 - $804.46 = $195.54; 50% of that = $97.77
    // total: $724.01 + $97.77 = $821.78
    assert.equal(coFamliWeeklyBenefit(dollars(1_000)), dollars(821.78));
  });

  test('a wage exactly at the threshold is entirely in the lower (90%) tier', () => {
    const threshold = coFamliTierThreshold();
    assert.equal(coFamliWeeklyBenefit(threshold), Math.round(threshold * 0.9));
  });

  test('the benefit caps at the maximum weekly benefit', () => {
    assert.equal(coFamliWeeklyBenefit(dollars(5_000)), coFamliMaxWeeklyBenefit());
  });

  test('eligibility requires at least $2,500 in base-period earnings, with no other test', () => {
    assert.equal(isCoFamliEligible(CO_FAMLI_MIN_BASE_PERIOD_EARNINGS - dollars(1)), false);
    assert.equal(isCoFamliEligible(CO_FAMLI_MIN_BASE_PERIOD_EARNINGS), true);
  });

  test('leave weeks default to 12, extending to 16 for pregnancy or childbirth complications', () => {
    assert.equal(coFamliMaxWeeksAvailable(false), CO_FAMLI_STANDARD_LEAVE_MAX_WEEKS);
    assert.equal(coFamliMaxWeeksAvailable(true), CO_FAMLI_COMBINED_MAX_WEEKS);
    assert.equal(CO_FAMLI_COMBINED_MAX_WEEKS, 16);
  });
});
