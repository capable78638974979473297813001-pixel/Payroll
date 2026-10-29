import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { dollars } from '../src/money.ts';
import {
  CALSAVERS_EFFECTIVE_DATE,
  CALSAVERS_DEFAULT_CONTRIBUTION_RATE,
  CALSAVERS_MAX_CONTRIBUTION_RATE,
  CALSAVERS_FIRST_PENALTY_PER_EMPLOYEE,
  CALSAVERS_ADDITIONAL_PENALTY_PER_EMPLOYEE,
  isCalSaversMandatory,
  calSaversDefaultContributionRate,
  calSaversPenaltyExposure,
} from '../payroll/calSavers.ts';

describe('CalSavers (payroll/calSavers.ts)', () => {
  test('an employer with 1+ employees and no qualified plan is mandatory on or after the effective date', () => {
    assert.equal(isCalSaversMandatory(1, false, CALSAVERS_EFFECTIVE_DATE), true);
    assert.equal(isCalSaversMandatory(5, false, '2026-06-01'), true);
  });

  test('an employer with zero employees is never mandatory', () => {
    assert.equal(isCalSaversMandatory(0, false, '2026-06-01'), false);
  });

  test('an employer that already offers a qualified retirement plan is exempt', () => {
    assert.equal(isCalSaversMandatory(10, true, '2026-06-01'), false);
  });

  test('the mandate does not apply before its effective date', () => {
    assert.equal(isCalSaversMandatory(5, false, '2025-12-31'), false);
  });

  test('the default contribution rate starts at 5% and escalates 1 point per year', () => {
    assert.equal(calSaversDefaultContributionRate(0), CALSAVERS_DEFAULT_CONTRIBUTION_RATE);
    assert.equal(calSaversDefaultContributionRate(1), 0.06);
    assert.equal(calSaversDefaultContributionRate(2), 0.07);
  });

  test('the default contribution rate caps at 8% and never exceeds it', () => {
    assert.equal(calSaversDefaultContributionRate(3), CALSAVERS_MAX_CONTRIBUTION_RATE);
    assert.equal(calSaversDefaultContributionRate(10), CALSAVERS_MAX_CONTRIBUTION_RATE);
  });

  test('penalty exposure is $250/employee alone, or $750/employee once noncompliance continues', () => {
    assert.equal(calSaversPenaltyExposure(10, false), 10 * CALSAVERS_FIRST_PENALTY_PER_EMPLOYEE);
    assert.equal(calSaversPenaltyExposure(10, true), 10 * (CALSAVERS_FIRST_PENALTY_PER_EMPLOYEE + CALSAVERS_ADDITIONAL_PENALTY_PER_EMPLOYEE));
    assert.equal(calSaversPenaltyExposure(1, true), dollars(750));
  });
});
