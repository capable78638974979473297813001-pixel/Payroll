import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  PWFA_EMPLOYER_THRESHOLD,
  PWFA_EFFECTIVE_DATE,
  isPwfaCoveredEmployer,
  isPwfaInEffect,
  isPredictableAssessmentAccommodation,
  requiresMedicalDocumentation,
} from '../payroll/pwfa.ts';

describe('federal Pregnant Workers Fairness Act (payroll/pwfa.ts)', () => {
  test('an employer is covered at exactly 15 employees', () => {
    assert.equal(isPwfaCoveredEmployer(14), false);
    assert.equal(isPwfaCoveredEmployer(PWFA_EMPLOYER_THRESHOLD), true);
  });

  test('the law is in effect on or after June 27, 2023', () => {
    assert.equal(isPwfaInEffect('2023-06-26'), false);
    assert.equal(isPwfaInEffect(PWFA_EFFECTIVE_DATE), true);
    assert.equal(isPwfaInEffect('2026-01-01'), true);
  });

  test('exactly the four predictable-assessment accommodations are recognized', () => {
    assert.equal(isPredictableAssessmentAccommodation('water_access'), true);
    assert.equal(isPredictableAssessmentAccommodation('additional_restroom_breaks'), true);
    assert.equal(isPredictableAssessmentAccommodation('sit_or_stand_as_needed'), true);
    assert.equal(isPredictableAssessmentAccommodation('additional_eating_drinking_breaks'), true);
    assert.equal(isPredictableAssessmentAccommodation('temporary_reassignment'), false);
    assert.equal(isPredictableAssessmentAccommodation('telework'), false);
  });

  test('medical documentation is never required for a predictable-assessment accommodation, but may be for anything else', () => {
    assert.equal(requiresMedicalDocumentation('water_access'), false);
    assert.equal(requiresMedicalDocumentation('additional_restroom_breaks'), false);
    assert.equal(requiresMedicalDocumentation('temporary_reassignment'), true);
  });
});
