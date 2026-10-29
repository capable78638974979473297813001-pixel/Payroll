import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { dollars } from '../src/money.ts';
import {
  CA_PAY_DATA_EMPLOYER_THRESHOLD,
  CA_PAY_DATA_JOB_CATEGORIES,
  CA_PAY_DATA_PAY_BANDS,
  CA_PAY_DATA_PENALTY_FIRST_FAILURE,
  CA_PAY_DATA_PENALTY_SUBSEQUENT_FAILURE,
  caPayDataReportRequired,
  classifyCaPayBand,
  caPayDataFilingDeadline,
  caPayDataPenaltyExposure,
} from '../payroll/caPayDataReport.ts';

describe('California pay data reporting (payroll/caPayDataReport.ts)', () => {
  test('there are exactly 10 job categories and 12 pay bands, per the handbook', () => {
    assert.equal(CA_PAY_DATA_JOB_CATEGORIES.length, 10);
    assert.equal(CA_PAY_DATA_PAY_BANDS.length, 12);
  });

  describe('caPayDataReportRequired', () => {
    test('the two report types are triggered by completely independent 100-employee tests', () => {
      assert.deepEqual(caPayDataReportRequired(100, 0), { payrollReportRequired: true, laborContractorReportRequired: false });
      assert.deepEqual(caPayDataReportRequired(0, 100), { payrollReportRequired: false, laborContractorReportRequired: true });
      assert.deepEqual(caPayDataReportRequired(99, 99), { payrollReportRequired: false, laborContractorReportRequired: false });
      assert.deepEqual(caPayDataReportRequired(CA_PAY_DATA_EMPLOYER_THRESHOLD, CA_PAY_DATA_EMPLOYER_THRESHOLD), {
        payrollReportRequired: true,
        laborContractorReportRequired: true,
      });
    });
  });

  describe('classifyCaPayBand', () => {
    test('classifies the boundary of band 1 and band 2 correctly', () => {
      assert.equal(classifyCaPayBand(dollars(19_239)), 1);
      assert.equal(classifyCaPayBand(dollars(19_240)), 2);
    });

    test('classifies the boundary of band 11 and band 12 correctly (the top band is open-ended)', () => {
      assert.equal(classifyCaPayBand(dollars(239_199)), 11);
      assert.equal(classifyCaPayBand(dollars(239_200)), 12);
      assert.equal(classifyCaPayBand(dollars(1_000_000)), 12);
    });

    test('classifies zero earnings into band 1 (the bottom band has no floor)', () => {
      assert.equal(classifyCaPayBand(0), 1);
    });

    test('throws on a negative amount', () => {
      assert.throws(() => classifyCaPayBand(dollars(-1)));
    });
  });

  describe('caPayDataFilingDeadline', () => {
    test('Reporting Year 2025 deadline is May 13, 2026, matching the handbook\'s own stated date exactly', () => {
      assert.equal(caPayDataFilingDeadline(2025), '2026-05-13');
    });

    test('is always the second Wednesday of May in the year after the reporting year', () => {
      const deadline = caPayDataFilingDeadline(2026);
      const date = new Date(deadline + 'T00:00:00Z');
      assert.equal(date.getUTCMonth(), 4); // May
      assert.equal(date.getUTCDay(), 3); // Wednesday
      assert.ok(date.getUTCDate() >= 8 && date.getUTCDate() <= 14); // second Wednesday always falls in this range
    });
  });

  describe('caPayDataPenaltyExposure', () => {
    test('a first failure is exposed at up to $100/employee', () => {
      assert.equal(caPayDataPenaltyExposure(100, false), 100 * CA_PAY_DATA_PENALTY_FIRST_FAILURE);
    });

    test('a subsequent failure is exposed at up to $200/employee — double the first-failure rate', () => {
      assert.equal(caPayDataPenaltyExposure(100, true), 100 * CA_PAY_DATA_PENALTY_SUBSEQUENT_FAILURE);
      assert.equal(caPayDataPenaltyExposure(100, true), 2 * caPayDataPenaltyExposure(100, false));
    });

    test('zero or fewer employees carries zero exposure', () => {
      assert.equal(caPayDataPenaltyExposure(0, false), 0);
      assert.equal(caPayDataPenaltyExposure(-5, true), 0);
    });
  });
});
