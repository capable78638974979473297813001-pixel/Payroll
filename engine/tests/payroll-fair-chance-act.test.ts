import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  FAIR_CHANCE_ACT_EMPLOYER_THRESHOLD,
  isFairChanceActCoveredEmployer,
  isCriminalHistoryInquiryPermitted,
  fairChanceResponseDeadline,
  fairChanceExtendedResponseDeadline,
  fairChanceDeemedReceivedDate,
  fairChanceComplaintDeadline,
} from '../payroll/fairChanceAct.ts';

describe('California Fair Chance Act (payroll/fairChanceAct.ts)', () => {
  test('an employer is covered at exactly 5 employees', () => {
    assert.equal(isFairChanceActCoveredEmployer(4), false);
    assert.equal(isFairChanceActCoveredEmployer(FAIR_CHANCE_ACT_EMPLOYER_THRESHOLD), true);
  });

  test('criminal history inquiry is permitted only once a conditional offer has been made', () => {
    assert.equal(isCriminalHistoryInquiryPermitted(false), false);
    assert.equal(isCriminalHistoryInquiryPermitted(true), true);
  });

  test('the response deadline is 5 BUSINESS days after the preliminary notice (Wed + 5 business days = the following Wed)', () => {
    assert.equal(fairChanceResponseDeadline('2026-01-14'), '2026-01-21');
  });

  test('the extended deadline (after a dispute) is 5 more business days beyond the original deadline', () => {
    assert.equal(fairChanceExtendedResponseDeadline('2026-01-14'), '2026-01-28');
  });

  test('a mailed notice to a California address is deemed received 5 calendar days after mailing', () => {
    assert.equal(fairChanceDeemedReceivedDate('2026-03-01', 'california'), '2026-03-06');
  });

  test('a mailed notice to another US address is deemed received 10 calendar days after mailing', () => {
    assert.equal(fairChanceDeemedReceivedDate('2026-03-01', 'other_us'), '2026-03-11');
  });

  test('a mailed notice to an international address is deemed received 20 calendar days after mailing', () => {
    assert.equal(fairChanceDeemedReceivedDate('2026-03-01', 'international'), '2026-03-21');
  });

  test('the complaint deadline is 3 years after the violation date', () => {
    assert.equal(fairChanceComplaintDeadline('2026-01-14'), '2029-01-14');
  });
});
