import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  PUMP_ACT_SMALL_EMPLOYER_THRESHOLD,
  pumpActCoverageEndDate,
  isWithinPumpActCoveragePeriod,
  mayQualifyForSmallEmployerExemption,
  isPumpBreakPaymentRequired,
  isCompliantPumpingSpace,
} from '../payroll/pumpAct.ts';

describe('federal PUMP Act (payroll/pumpAct.ts)', () => {
  test('coverage runs for 1 year (12 months) after the birth date', () => {
    assert.equal(pumpActCoverageEndDate('2026-03-15'), '2027-03-15');
  });

  test('coverage is active on or before the end date, expired after it', () => {
    assert.equal(isWithinPumpActCoveragePeriod('2026-03-15', '2027-03-15'), true);
    assert.equal(isWithinPumpActCoveragePeriod('2026-03-15', '2027-03-16'), false);
    assert.equal(isWithinPumpActCoveragePeriod('2026-03-15', '2026-06-01'), true);
  });

  test('the small-employer exemption headcount check is strictly below 50', () => {
    assert.equal(mayQualifyForSmallEmployerExemption(49), true);
    assert.equal(mayQualifyForSmallEmployerExemption(PUMP_ACT_SMALL_EMPLOYER_THRESHOLD), false);
    assert.equal(mayQualifyForSmallEmployerExemption(51), false);
  });

  test('payment is required whenever the employee is not completely relieved of duty', () => {
    assert.equal(isPumpBreakPaymentRequired(false, false), true);
    assert.equal(isPumpBreakPaymentRequired(false, true), true);
  });

  test('payment is required when the break coincides with an already-paid break, even if fully relieved of duty', () => {
    assert.equal(isPumpBreakPaymentRequired(true, true), true);
  });

  test('payment is not required when fully relieved of duty and not coinciding with a paid break', () => {
    assert.equal(isPumpBreakPaymentRequired(true, false), false);
  });

  test('a bathroom never qualifies as a compliant pumping space, however private', () => {
    assert.equal(isCompliantPumpingSpace(true, true, true), false);
  });

  test('a space must be both shielded from view and free from intrusion, in addition to not being a bathroom', () => {
    assert.equal(isCompliantPumpingSpace(false, true, true), true);
    assert.equal(isCompliantPumpingSpace(false, false, true), false);
    assert.equal(isCompliantPumpingSpace(false, true, false), false);
  });
});
