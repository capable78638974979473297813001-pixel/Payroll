import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { dollars } from '../src/money.ts';
import {
  COBRA_SMALL_EMPLOYER_THRESHOLD,
  continuationCoverageEndDate,
  electionDeadline,
  electionNoticeDeadline,
  initialPremiumDeadline,
  isCobraApplicable,
  isQualifyingTermination,
  maximumMonthlyPremium,
  qualifyingEventDurationMonths,
  GENERAL_NOTICE_DEADLINE_DAYS,
  ERISA_NOTICE_PENALTY_PER_DAY,
  EXCISE_TAX_PER_DAY_SINGLE_BENEFICIARY,
  EXCISE_TAX_PER_DAY_MULTIPLE_BENEFICIARIES,
  generalNoticeDeadline,
  generalNoticeDeadlineGivenPossibleElectionNotice,
  erisaNoticePenaltyExposure,
  exciseTaxExposure,
} from '../payroll/cobra.ts';

describe('COBRA employer applicability (payroll/cobra.ts)', () => {
  test('an employer at or above the 20-employee threshold is subject to COBRA', () => {
    assert.equal(isCobraApplicable(COBRA_SMALL_EMPLOYER_THRESHOLD), true);
    assert.equal(isCobraApplicable(50), true);
  });

  test('an employer below the threshold is exempt entirely', () => {
    assert.equal(isCobraApplicable(COBRA_SMALL_EMPLOYER_THRESHOLD - 1), false);
    assert.equal(isCobraApplicable(1), false);
  });
});

describe('qualifying event duration (payroll/cobra.ts)', () => {
  test('termination and reduced hours are 18-month qualifying events', () => {
    assert.equal(qualifyingEventDurationMonths('termination'), 18);
    assert.equal(qualifyingEventDurationMonths('reduced_hours'), 18);
  });

  test('divorce, Medicare entitlement, a dependent aging out, and death are all 36-month qualifying events', () => {
    assert.equal(qualifyingEventDurationMonths('divorce_or_legal_separation'), 36);
    assert.equal(qualifyingEventDurationMonths('employee_medicare_entitlement'), 36);
    assert.equal(qualifyingEventDurationMonths('dependent_aging_out'), 36);
    assert.equal(qualifyingEventDurationMonths('employee_death'), 36);
  });
});

describe('gross misconduct is not a qualifying event at all (payroll/cobra.ts)', () => {
  test('every ordinary termination reason qualifies except gross misconduct', () => {
    assert.equal(isQualifyingTermination('involuntary'), true);
    assert.equal(isQualifyingTermination('layoff'), true);
    assert.equal(isQualifyingTermination('voluntary_with_notice'), true);
    assert.equal(isQualifyingTermination('voluntary_without_notice'), true);
    assert.equal(isQualifyingTermination('gross_misconduct'), false);
  });
});

describe('COBRA deadlines (payroll/cobra.ts)', () => {
  test('the election notice is due 44 days after the qualifying event', () => {
    assert.equal(electionNoticeDeadline('2026-06-10'), '2026-07-24');
  });

  test('the election period is 60 days from the LATER of coverage loss or notice provided', () => {
    // Notice provided same day as coverage loss -> 60 days from that day.
    assert.equal(electionDeadline('2026-06-10', '2026-06-10'), '2026-08-09');
    // Notice provided LATER than coverage loss -> 60 days from the notice date, not the loss date.
    assert.equal(electionDeadline('2026-06-10', '2026-07-01'), '2026-08-30');
  });

  test('the first premium payment is due 45 days after the election date', () => {
    assert.equal(initialPremiumDeadline('2026-08-09'), '2026-09-23');
  });

  test('continuation coverage ends duration-months after the qualifying event', () => {
    assert.equal(continuationCoverageEndDate('2026-06-10', 'termination'), '2027-12-10'); // 18 months
    assert.equal(continuationCoverageEndDate('2026-06-10', 'employee_death'), '2029-06-10'); // 36 months
  });
});

describe('COBRA premium cap (payroll/cobra.ts)', () => {
  test('the maximum premium is 102% of the plan\'s own full cost of coverage', () => {
    assert.equal(maximumMonthlyPremium(dollars(500)), dollars(510));
  });
});

describe('COBRA general notice (payroll/cobra.ts)', () => {
  test('the general notice deadline is 90 days after first coverage', () => {
    assert.equal(generalNoticeDeadline('2026-01-01'), '2026-04-01');
    assert.equal(GENERAL_NOTICE_DEADLINE_DAYS, 90);
  });

  test('with no election notice pending, the standard 90-day deadline applies', () => {
    assert.equal(generalNoticeDeadlineGivenPossibleElectionNotice('2026-01-01', null), '2026-04-01');
  });

  test('an election notice due EARLIER than the standard 90-day deadline pulls the general notice deadline in with it', () => {
    assert.equal(generalNoticeDeadlineGivenPossibleElectionNotice('2026-01-01', '2026-02-15'), '2026-02-15');
  });

  test('an election notice due LATER than the standard 90-day deadline does not push the general notice deadline out', () => {
    assert.equal(generalNoticeDeadlineGivenPossibleElectionNotice('2026-01-01', '2026-06-01'), '2026-04-01');
  });

  test('ERISA penalty exposure is $110/day per affected beneficiary', () => {
    assert.equal(erisaNoticePenaltyExposure(10, 1), 10 * ERISA_NOTICE_PENALTY_PER_DAY);
    assert.equal(erisaNoticePenaltyExposure(10, 3), 10 * 3 * ERISA_NOTICE_PENALTY_PER_DAY);
  });

  test('ERISA penalty exposure is zero for zero days late or zero affected beneficiaries', () => {
    assert.equal(erisaNoticePenaltyExposure(0, 3), 0);
    assert.equal(erisaNoticePenaltyExposure(10, 0), 0);
  });

  test('excise tax uses the single-beneficiary per-day rate when only one family member is affected', () => {
    assert.equal(exciseTaxExposure(10, false), 10 * EXCISE_TAX_PER_DAY_SINGLE_BENEFICIARY);
  });

  test('excise tax uses the family-wide per-day rate when more than one family member is affected', () => {
    assert.equal(exciseTaxExposure(10, true), 10 * EXCISE_TAX_PER_DAY_MULTIPLE_BENEFICIARIES);
    assert.notEqual(exciseTaxExposure(10, true), exciseTaxExposure(10, false));
  });
});
