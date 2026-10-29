import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { dollars } from '../src/money.ts';
import {
  OR_FAIR_WORK_WEEK_EMPLOYER_THRESHOLD,
  OR_FAIR_WORK_WEEK_DE_MINIMIS_MINUTES,
  OR_FAIR_WORK_WEEK_REST_PERIOD_HOURS,
  OR_FAIR_WORK_WEEK_PENALTY_MIN,
  OR_FAIR_WORK_WEEK_PENALTY_MAX,
  isOrFairWorkWeekCoveredEmployer,
  isOrFairWorkWeekChangeDeMinimis,
  orFairWorkWeekAdditiveChangePay,
  orFairWorkWeekSubtractiveChangePay,
  isOrFairWorkWeekRestPeriodViolation,
  orFairWorkWeekRestPeriodPremiumPay,
  clampOrFairWorkWeekPenalty,
  orFairWorkWeekExceptionGuidance,
} from '../payroll/orFairWorkWeek.ts';

describe('Oregon Fair Work Week Act (payroll/orFairWorkWeek.ts)', () => {
  describe('isOrFairWorkWeekCoveredEmployer', () => {
    test('requires BOTH 500+ employees worldwide AND non-exempt hourly status', () => {
      assert.equal(isOrFairWorkWeekCoveredEmployer(OR_FAIR_WORK_WEEK_EMPLOYER_THRESHOLD, true), true);
      assert.equal(isOrFairWorkWeekCoveredEmployer(OR_FAIR_WORK_WEEK_EMPLOYER_THRESHOLD - 1, true), false);
      assert.equal(isOrFairWorkWeekCoveredEmployer(10_000, false), false); // salaried exempt employee, outside the Act
    });
  });

  test('a change of 30 minutes or less is de minimis, owing no compensation', () => {
    assert.equal(isOrFairWorkWeekChangeDeMinimis(OR_FAIR_WORK_WEEK_DE_MINIMIS_MINUTES), true);
    assert.equal(isOrFairWorkWeekChangeDeMinimis(OR_FAIR_WORK_WEEK_DE_MINIMIS_MINUTES + 1), false);
  });

  test('the additive-change formula is a flat one hour of pay, regardless of how much time was added', () => {
    const rate = dollars(20);
    assert.equal(orFairWorkWeekAdditiveChangePay(rate), rate); // one hour, whether 31 minutes or 8 hours added
  });

  test('the subtractive-change formula scales with the size of the cut, at half the regular rate per hour', () => {
    const rate = dollars(20);
    assert.equal(orFairWorkWeekSubtractiveChangePay(rate, 3), Math.round(rate * 0.5 * 3));
    assert.equal(orFairWorkWeekSubtractiveChangePay(rate, 0), 0);
  });

  test('the two formulas produce genuinely different totals for a comparable-sized change', () => {
    const rate = dollars(20);
    const additive = orFairWorkWeekAdditiveChangePay(rate); // flat $20, regardless of hours added
    const subtractive = orFairWorkWeekSubtractiveChangePay(rate, 4); // $10/hr * 4 hrs = $40
    assert.notEqual(additive, subtractive);
    assert.equal(subtractive, dollars(40));
  });

  describe('rest period', () => {
    test('fewer than 10 hours between shifts is a violation', () => {
      assert.equal(isOrFairWorkWeekRestPeriodViolation(OR_FAIR_WORK_WEEK_REST_PERIOD_HOURS - 1), true);
      assert.equal(isOrFairWorkWeekRestPeriodViolation(OR_FAIR_WORK_WEEK_REST_PERIOD_HOURS), false);
    });

    test('hours worked during the rest period are paid at 1.5x, even with consent', () => {
      const rate = dollars(20);
      assert.equal(orFairWorkWeekRestPeriodPremiumPay(rate, 2), Math.round(rate * 1.5 * 2));
      assert.equal(orFairWorkWeekRestPeriodPremiumPay(rate, 0), 0);
    });
  });

  test('clampOrFairWorkWeekPenalty enforces the $500-$2,000 per-violation, per-day range', () => {
    assert.equal(clampOrFairWorkWeekPenalty(dollars(100)), OR_FAIR_WORK_WEEK_PENALTY_MIN);
    assert.equal(clampOrFairWorkWeekPenalty(dollars(5_000)), OR_FAIR_WORK_WEEK_PENALTY_MAX);
    assert.equal(clampOrFairWorkWeekPenalty(dollars(1_000)), dollars(1_000));
  });

  test('every exception reason returns non-empty guidance text', () => {
    const reasons: Array<Parameters<typeof orFairWorkWeekExceptionGuidance>[0]> = [
      'employee_initiated_swap',
      'employee_written_request',
      'disciplinary_with_documentation',
      'threat_to_safety_or_property',
      'public_utility_failure',
      'natural_disaster',
      'ticketed_event_cancellation',
      'voluntary_standby_consent',
      'unanticipated_need_with_consent',
    ];
    for (const reason of reasons) {
      assert.ok(orFairWorkWeekExceptionGuidance(reason).length > 0);
    }
  });
});
