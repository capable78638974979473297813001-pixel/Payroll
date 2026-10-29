import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { dollars } from '../src/money.ts';
import {
  WAITING_TIME_PENALTY_MAX_DAYS,
  waitingTimePenaltyDaysLate,
  waitingTimeDailyRate,
  waitingTimePenaltyAmount,
} from '../payroll/waitingTimePenalty.ts';

describe('California waiting time penalty (payroll/waitingTimePenalty.ts)', () => {
  test('days late is the calendar-day gap between due date and actual payment, counting weekends', () => {
    assert.equal(waitingTimePenaltyDaysLate('2026-03-01', '2026-03-11'), 10);
  });

  test('a payment on or before the due date is 0 days late, never negative', () => {
    assert.equal(waitingTimePenaltyDaysLate('2026-03-01', '2026-03-01'), 0);
    assert.equal(waitingTimePenaltyDaysLate('2026-03-01', '2026-02-25'), 0);
  });

  test('the daily rate is hourly rate times normal daily hours', () => {
    assert.equal(waitingTimeDailyRate(dollars(15), 8), dollars(120));
  });

  test('the penalty is daily rate times days late, matching the DIR worked example ($120/day x 10 days = $1,200)', () => {
    assert.equal(waitingTimePenaltyAmount(dollars(120), 10), dollars(1_200));
  });

  test('the penalty caps at 30 days of accrual, however much longer wages remain unpaid', () => {
    assert.equal(waitingTimePenaltyAmount(dollars(120), WAITING_TIME_PENALTY_MAX_DAYS), dollars(3_600));
    assert.equal(waitingTimePenaltyAmount(dollars(120), 45), dollars(3_600)); // capped, not 45 days' worth
    assert.equal(waitingTimePenaltyAmount(dollars(120), 90), dollars(3_600));
  });

  test('zero days late means zero penalty', () => {
    assert.equal(waitingTimePenaltyAmount(dollars(120), 0), 0);
  });
});
