import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  IL_SECURE_CHOICE_EMPLOYER_THRESHOLD,
  IL_SECURE_CHOICE_MIN_YEARS_IN_BUSINESS,
  IL_SECURE_CHOICE_TIER1_PENALTY_PER_EMPLOYEE,
  IL_SECURE_CHOICE_TIER2_PENALTY_PER_EMPLOYEE,
  isIlSecureChoiceMandatory,
  ilSecureChoicePenaltyExposure,
  ilSecureChoiceCureDeadline,
  isWithinIlSecureChoiceCurePeriod,
} from '../payroll/ilSecureChoice.ts';

describe('Illinois Secure Choice (payroll/ilSecureChoice.ts)', () => {
  test('mandatory requires ALL THREE conditions: 5+ employees, 2+ years in business, no qualified plan', () => {
    assert.equal(isIlSecureChoiceMandatory(IL_SECURE_CHOICE_EMPLOYER_THRESHOLD, IL_SECURE_CHOICE_MIN_YEARS_IN_BUSINESS, false), true);
    assert.equal(isIlSecureChoiceMandatory(4, 5, false), false); // too few employees
    assert.equal(isIlSecureChoiceMandatory(10, 1, false), false); // too new a business
    assert.equal(isIlSecureChoiceMandatory(10, 5, true), false); // already has a qualified plan
  });

  test('zero noncompliant years means zero penalty exposure', () => {
    assert.equal(ilSecureChoicePenaltyExposure(10, 0), 0);
  });

  test('the first noncompliant year is Tier I only', () => {
    assert.equal(ilSecureChoicePenaltyExposure(10, 1), 10 * IL_SECURE_CHOICE_TIER1_PENALTY_PER_EMPLOYEE);
  });

  test('each additional noncompliant year adds the (higher) Tier II rate on top of Tier I', () => {
    assert.equal(ilSecureChoicePenaltyExposure(10, 2), 10 * (IL_SECURE_CHOICE_TIER1_PENALTY_PER_EMPLOYEE + IL_SECURE_CHOICE_TIER2_PENALTY_PER_EMPLOYEE));
    assert.equal(ilSecureChoicePenaltyExposure(1, 3), IL_SECURE_CHOICE_TIER1_PENALTY_PER_EMPLOYEE + 2 * IL_SECURE_CHOICE_TIER2_PENALTY_PER_EMPLOYEE);
  });

  test('the cure deadline is 120 days after the notice issue date', () => {
    assert.equal(ilSecureChoiceCureDeadline('2026-01-01'), '2026-05-01');
  });

  test('curing on or before the deadline is within the cure period; after it is not', () => {
    assert.equal(isWithinIlSecureChoiceCurePeriod('2026-01-01', '2026-05-01'), true);
    assert.equal(isWithinIlSecureChoiceCurePeriod('2026-01-01', '2026-05-02'), false);
  });
});
