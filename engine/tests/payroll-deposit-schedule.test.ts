import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { dollars } from '../src/money.ts';
import {
  DE_MINIMIS_QUARTERLY_THRESHOLD,
  LOOKBACK_PERIOD_THRESHOLD,
  NEXT_DAY_DEPOSIT_THRESHOLD,
  depositDeadlineFor,
  determineDepositorSchedule,
  lookbackPeriodQuarters,
  monthlyDepositDeadline,
  nextBusinessDay,
  nextDayDepositRuleApplies,
  nextDayRuleChangesFutureSchedule,
  qualifiesForDeMinimisException,
  semiweeklyDepositDeadline,
} from '../payroll/depositSchedule.ts';

describe('lookback period (payroll/depositSchedule.ts)', () => {
  test('2026 lookback period is 2024 Q3/Q4 and 2025 Q1/Q2', () => {
    assert.deepEqual(lookbackPeriodQuarters(2026), [
      { year: 2024, quarter: 3 },
      { year: 2024, quarter: 4 },
      { year: 2025, quarter: 1 },
      { year: 2025, quarter: 2 },
    ]);
  });
});

describe('depositor schedule determination (payroll/depositSchedule.ts)', () => {
  test('a brand-new employer with no lookback history is monthly by default', () => {
    assert.equal(determineDepositorSchedule(undefined), 'monthly');
  });

  test('lookback liability at exactly the $50,000 threshold is still monthly', () => {
    assert.equal(determineDepositorSchedule(LOOKBACK_PERIOD_THRESHOLD), 'monthly');
  });

  test('lookback liability one cent over $50,000 is semiweekly', () => {
    assert.equal(determineDepositorSchedule(LOOKBACK_PERIOD_THRESHOLD + 1), 'semiweekly');
  });
});

describe('monthly deposit deadline (payroll/depositSchedule.ts)', () => {
  test('taxes on January payments are due February 15', () => {
    assert.equal(monthlyDepositDeadline(2026, 1), '2026-02-15');
  });

  test('taxes on December payments roll into January of the NEXT year', () => {
    assert.equal(monthlyDepositDeadline(2026, 12), '2027-01-15');
  });
});

describe('semiweekly deposit deadline (payroll/depositSchedule.ts)', () => {
  // 2026-01-14/15/16 are Wed/Thu/Fri; 2026-01-17/18/19/20 are Sat/Sun/Mon/Tue.
  test('a Wednesday, Thursday, or Friday payday is due the FOLLOWING Wednesday', () => {
    assert.equal(semiweeklyDepositDeadline('2026-01-14'), '2026-01-21'); // Wed
    assert.equal(semiweeklyDepositDeadline('2026-01-15'), '2026-01-21'); // Thu
    assert.equal(semiweeklyDepositDeadline('2026-01-16'), '2026-01-21'); // Fri
  });

  test('a Saturday, Sunday, Monday, or Tuesday payday is due the FOLLOWING Friday', () => {
    assert.equal(semiweeklyDepositDeadline('2026-01-17'), '2026-01-23'); // Sat
    assert.equal(semiweeklyDepositDeadline('2026-01-18'), '2026-01-23'); // Sun
    assert.equal(semiweeklyDepositDeadline('2026-01-19'), '2026-01-23'); // Mon
    assert.equal(semiweeklyDepositDeadline('2026-01-20'), '2026-01-23'); // Tue
  });
});

describe('the $100,000 next-day deposit rule (payroll/depositSchedule.ts)', () => {
  test('applies at exactly $100,000 and above, not below', () => {
    assert.equal(nextDayDepositRuleApplies(NEXT_DAY_DEPOSIT_THRESHOLD), true);
    assert.equal(nextDayDepositRuleApplies(NEXT_DAY_DEPOSIT_THRESHOLD - 1), false);
    assert.equal(nextDayDepositRuleApplies(NEXT_DAY_DEPOSIT_THRESHOLD + 1), true);
  });

  test('flips a MONTHLY depositor to semiweekly going forward, but leaves an already-semiweekly one unchanged', () => {
    assert.equal(nextDayRuleChangesFutureSchedule('monthly', NEXT_DAY_DEPOSIT_THRESHOLD), true);
    assert.equal(nextDayRuleChangesFutureSchedule('semiweekly', NEXT_DAY_DEPOSIT_THRESHOLD), false);
    assert.equal(nextDayRuleChangesFutureSchedule('monthly', NEXT_DAY_DEPOSIT_THRESHOLD - 1), false);
  });

  test('nextBusinessDay skips weekends', () => {
    assert.equal(nextBusinessDay('2026-01-16'), '2026-01-19'); // Friday -> Monday
    assert.equal(nextBusinessDay('2026-01-14'), '2026-01-15'); // Wednesday -> Thursday
  });
});

describe('depositDeadlineFor (payroll/depositSchedule.ts)', () => {
  test('a monthly depositor with no next-day trigger uses the regular monthly deadline', () => {
    assert.equal(depositDeadlineFor('monthly', '2026-01-16', dollars(10_000)), '2026-02-15');
  });

  test('a semiweekly depositor with no next-day trigger uses the regular semiweekly table', () => {
    assert.equal(depositDeadlineFor('semiweekly', '2026-01-14', dollars(10_000)), '2026-01-21');
  });

  test('the $100,000 next-day rule overrides EITHER schedule', () => {
    // 2026-01-16 is a Friday; next business day skips the weekend to Monday.
    assert.equal(depositDeadlineFor('monthly', '2026-01-16', NEXT_DAY_DEPOSIT_THRESHOLD), '2026-01-19');
    assert.equal(depositDeadlineFor('semiweekly', '2026-01-16', NEXT_DAY_DEPOSIT_THRESHOLD), '2026-01-19');
  });
});

describe('de minimis quarterly exception (payroll/depositSchedule.ts)', () => {
  test('qualifies when the current quarter is under $2,500, with no next-day obligation', () => {
    assert.equal(qualifiesForDeMinimisException(dollars(2_000), dollars(10_000), false), true);
  });

  test('qualifies when the PRECEDING quarter was under $2,500, even if the current one is not', () => {
    assert.equal(qualifiesForDeMinimisException(dollars(10_000), dollars(2_000), false), true);
  });

  test('does not qualify when neither quarter is under the threshold', () => {
    assert.equal(qualifiesForDeMinimisException(dollars(10_000), dollars(10_000), false), false);
  });

  test('never qualifies if a next-day deposit obligation was triggered this quarter, regardless of the liability figures', () => {
    assert.equal(qualifiesForDeMinimisException(dollars(1), dollars(1), true), false);
  });

  test('exactly at the $2,500 threshold does not qualify (must be UNDER, not at or under)', () => {
    assert.equal(qualifiesForDeMinimisException(DE_MINIMIS_QUARTERLY_THRESHOLD, dollars(10_000), false), false);
  });
});
