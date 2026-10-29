import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { dollars } from '../src/money.ts';
import {
  NY_WAGE_NOTICE_MAX_DAMAGES,
  NY_WAGE_STATEMENT_MAX_DAMAGES,
  nyWageNoticeComplianceIssues,
  isNewNoticeRequiredForRateChange,
  estimatedNoticeViolationDamages,
  estimatedWageStatementViolationDamages,
} from '../payroll/nyWageNotice.ts';
import type { NyWageNotice } from '../payroll/nyWageNotice.ts';

function completeNotice(overrides: Partial<NyWageNotice> = {}): NyWageNotice {
  return {
    rateOfPayCents: dollars(20),
    basisOfPay: 'hourly',
    allowancesClaimedCents: 0,
    regularPayDay: 'Friday',
    employerLegalName: 'Acme Corp',
    employerAddress: '1 Elm St, Albany, NY',
    employerPhone: '518-555-0100',
    ...overrides,
  };
}

describe('New York wage notice (payroll/nyWageNotice.ts)', () => {
  test('a fully complete notice has no compliance issues', () => {
    assert.deepEqual(nyWageNoticeComplianceIssues(completeNotice()), []);
  });

  test('a zero allowance is valid — it must be STATED, not merely absent', () => {
    assert.deepEqual(nyWageNoticeComplianceIssues(completeNotice({ allowancesClaimedCents: 0 })), []);
  });

  test('a missing allowances field (as opposed to an explicit zero) is flagged', () => {
    const notice = completeNotice();
    delete (notice as Partial<NyWageNotice>).allowancesClaimedCents;
    const issues = nyWageNoticeComplianceIssues(notice);
    assert.equal(issues.length, 1);
    assert.match(issues[0], /allowances/);
  });

  test('every missing required field is reported, not just the first', () => {
    const issues = nyWageNoticeComplianceIssues({});
    assert.equal(issues.length, 7); // all seven required fields, including allowances, are missing from a bare {}
  });

  test('a zero or negative rate of pay is flagged', () => {
    assert.equal(nyWageNoticeComplianceIssues(completeNotice({ rateOfPayCents: 0 })).length, 1);
    assert.equal(nyWageNoticeComplianceIssues(completeNotice({ rateOfPayCents: -100 })).length, 1);
  });

  test('a rate decrease always requires a new notice, regardless of industry or wage-statement visibility', () => {
    assert.equal(isNewNoticeRequiredForRateChange(false, true, false), true);
    assert.equal(isNewNoticeRequiredForRateChange(false, false, false), true);
  });

  test('a non-hospitality rate increase needs a new notice only if it will NOT appear on the next wage statement', () => {
    assert.equal(isNewNoticeRequiredForRateChange(true, true, false), false);
    assert.equal(isNewNoticeRequiredForRateChange(true, false, false), true);
  });

  test('the hospitality industry always needs a new notice for any change', () => {
    assert.equal(isNewNoticeRequiredForRateChange(true, true, true), true);
    assert.equal(isNewNoticeRequiredForRateChange(false, true, true), true);
  });

  test('notice violation damages accrue at $50/day, capped at $5,000', () => {
    assert.equal(estimatedNoticeViolationDamages(10), dollars(500));
    assert.equal(estimatedNoticeViolationDamages(200), NY_WAGE_NOTICE_MAX_DAMAGES);
  });

  test('wage statement violation damages accrue at $250/day, capped at $5,000', () => {
    assert.equal(estimatedWageStatementViolationDamages(10), dollars(2_500));
    assert.equal(estimatedWageStatementViolationDamages(50), NY_WAGE_STATEMENT_MAX_DAMAGES);
  });
});
