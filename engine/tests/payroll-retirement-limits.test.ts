import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { dollars } from '../src/money.ts';
import {
  ELECTIVE_DEFERRAL_LIMIT_2026,
  CATCH_UP_LIMIT_2026,
  ENHANCED_CATCH_UP_LIMIT_2026,
  ROTH_CATCH_UP_WAGE_THRESHOLD_2026,
  applicableCatchUpLimit,
  annualElectiveDeferralLimit,
  remainingElectiveDeferralRoom,
  cappedDeferralForPayPeriod,
  isRothCatchUpRequired,
} from '../payroll/retirementLimits.ts';

describe('401(k) elective deferral and catch-up limits (payroll/retirementLimits.ts)', () => {
  test('no catch-up applies under age 50', () => {
    assert.equal(applicableCatchUpLimit(30), 0);
    assert.equal(applicableCatchUpLimit(49), 0);
    assert.equal(annualElectiveDeferralLimit(30), ELECTIVE_DEFERRAL_LIMIT_2026);
  });

  test('the standard catch-up applies at 50 and up, outside the 60-63 window', () => {
    assert.equal(applicableCatchUpLimit(50), CATCH_UP_LIMIT_2026);
    assert.equal(applicableCatchUpLimit(59), CATCH_UP_LIMIT_2026);
    assert.equal(applicableCatchUpLimit(64), CATCH_UP_LIMIT_2026);
    assert.equal(annualElectiveDeferralLimit(50), ELECTIVE_DEFERRAL_LIMIT_2026 + CATCH_UP_LIMIT_2026);
  });

  test('the enhanced catch-up applies exactly for ages 60 through 63', () => {
    assert.equal(applicableCatchUpLimit(60), ENHANCED_CATCH_UP_LIMIT_2026);
    assert.equal(applicableCatchUpLimit(61), ENHANCED_CATCH_UP_LIMIT_2026);
    assert.equal(applicableCatchUpLimit(63), ENHANCED_CATCH_UP_LIMIT_2026);
    assert.equal(applicableCatchUpLimit(64), CATCH_UP_LIMIT_2026); // falls back to standard just past the window
    assert.equal(annualElectiveDeferralLimit(60), ELECTIVE_DEFERRAL_LIMIT_2026 + ENHANCED_CATCH_UP_LIMIT_2026);
  });

  test('remaining room is the limit minus YTD deferrals, and never negative', () => {
    assert.equal(remainingElectiveDeferralRoom(dollars(20_000), 30), ELECTIVE_DEFERRAL_LIMIT_2026 - dollars(20_000));
    assert.equal(remainingElectiveDeferralRoom(dollars(30_000), 30), 0); // already past the age-30 limit
    assert.equal(remainingElectiveDeferralRoom(ELECTIVE_DEFERRAL_LIMIT_2026, 30), 0);
  });

  test('a requested deferral is capped to remaining room, never below what was actually requested when room is sufficient', () => {
    assert.equal(cappedDeferralForPayPeriod(dollars(2_000), dollars(23_000), 30), ELECTIVE_DEFERRAL_LIMIT_2026 - dollars(23_000));
    assert.equal(cappedDeferralForPayPeriod(dollars(1_000), dollars(10_000), 30), dollars(1_000));
    assert.equal(cappedDeferralForPayPeriod(dollars(500), ELECTIVE_DEFERRAL_LIMIT_2026, 30), 0);
  });

  test('Roth catch-up is never required under age 50, regardless of wages', () => {
    assert.equal(isRothCatchUpRequired(30, dollars(500_000)), false);
  });

  test('Roth catch-up is required at 50+ only when prior-year wages STRICTLY exceed the threshold', () => {
    assert.equal(isRothCatchUpRequired(50, ROTH_CATCH_UP_WAGE_THRESHOLD_2026), false);
    assert.equal(isRothCatchUpRequired(50, ROTH_CATCH_UP_WAGE_THRESHOLD_2026 + 1), true);
    assert.equal(isRothCatchUpRequired(60, dollars(200_000)), true);
    assert.equal(isRothCatchUpRequired(50, dollars(100_000)), false);
  });
});
