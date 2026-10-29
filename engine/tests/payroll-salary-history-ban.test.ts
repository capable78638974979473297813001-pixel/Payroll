import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { dollars } from '../src/money.ts';
import {
  SALARY_HISTORY_JOB_POSTING_EMPLOYER_THRESHOLD,
  SALARY_HISTORY_BAN_MIN_PENALTY,
  SALARY_HISTORY_BAN_MAX_PENALTY,
  isJobPostingPayScaleRequired,
  isFirstViolationPenaltyWaived,
  clampSalaryHistoryBanPenalty,
  salaryHistoryBanPenaltyOwed,
} from '../payroll/salaryHistoryBan.ts';

describe('California salary history ban / pay scale transparency (payroll/salaryHistoryBan.ts)', () => {
  test('job posting pay scale disclosure is required at exactly 15 employees', () => {
    assert.equal(isJobPostingPayScaleRequired(14), false);
    assert.equal(isJobPostingPayScaleRequired(SALARY_HISTORY_JOB_POSTING_EMPLOYER_THRESHOLD), true);
  });

  test('the first-violation waiver requires BOTH conditions: first violation AND all postings updated', () => {
    assert.equal(isFirstViolationPenaltyWaived(true, true), true);
    assert.equal(isFirstViolationPenaltyWaived(true, false), false);
    assert.equal(isFirstViolationPenaltyWaived(false, true), false);
    assert.equal(isFirstViolationPenaltyWaived(false, false), false);
  });

  test('a considered penalty is clamped into the $100-$10,000 range', () => {
    assert.equal(clampSalaryHistoryBanPenalty(dollars(50)), SALARY_HISTORY_BAN_MIN_PENALTY);
    assert.equal(clampSalaryHistoryBanPenalty(dollars(500)), dollars(500));
    assert.equal(clampSalaryHistoryBanPenalty(dollars(50_000)), SALARY_HISTORY_BAN_MAX_PENALTY);
  });

  test('penalty owed is zero when the first-violation waiver applies, regardless of the considered amount', () => {
    assert.equal(salaryHistoryBanPenaltyOwed(true, true, dollars(5_000)), 0);
  });

  test('penalty owed is the clamped considered amount when the waiver does not apply', () => {
    assert.equal(salaryHistoryBanPenaltyOwed(false, true, dollars(5_000)), dollars(5_000));
    assert.equal(salaryHistoryBanPenaltyOwed(true, false, dollars(50)), SALARY_HISTORY_BAN_MIN_PENALTY);
  });
});
