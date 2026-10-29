import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { dollars } from '../src/money.ts';
import {
  NY_WARN_EMPLOYER_THRESHOLD,
  NY_WARN_MASS_LAYOFF_LARGE_THRESHOLD,
  NY_WARN_NOTICE_PERIOD_DAYS,
  NJ_WARN_EMPLOYER_THRESHOLD,
  NJ_WARN_TRIGGER_MINIMUM_EMPLOYEES,
  NJ_WARN_NOTICE_PERIOD_DAYS,
  NJ_WARN_INADEQUATE_NOTICE_PENALTY_WEEKS,
  CA_WARN_EMPLOYER_THRESHOLD,
  CA_WARN_TRIGGER_MINIMUM_EMPLOYEES,
  CA_WARN_RELOCATION_DISTANCE_MILES,
  CA_WARN_NOTICE_PERIOD_DAYS,
  miniWarnNoticePeriodDays,
  isNyWarnCoveredEmployer,
  isNyPlantClosing,
  isNyMassLayoff,
  isNjWarnCoveredEmployer,
  isNjWarnTriggered,
  njMandatorySeverance,
  njTotalSeveranceOwed,
  isCaWarnCoveredEmployer,
  isCaWarnTriggered,
  isCaWarnRelocationTriggered,
  miniWarnNoticeDeadline,
  isMiniWarnNoticeLate,
} from '../payroll/miniWarnActs.ts';

describe('State mini-WARN acts (payroll/miniWarnActs.ts)', () => {
  describe('notice periods', () => {
    test('NY and NJ both require 90 days; CA requires 60, matching federal', () => {
      assert.equal(miniWarnNoticePeriodDays('NY'), 90);
      assert.equal(miniWarnNoticePeriodDays('NJ'), 90);
      assert.equal(miniWarnNoticePeriodDays('CA'), 60);
      assert.equal(NY_WARN_NOTICE_PERIOD_DAYS, 90);
      assert.equal(NJ_WARN_NOTICE_PERIOD_DAYS, 90);
      assert.equal(CA_WARN_NOTICE_PERIOD_DAYS, 60);
    });
  });

  describe('New York (two-branch, percentage-based mass layoff — mirrors federal at half the numbers)', () => {
    test('employer coverage requires 50+ full-time New York employees', () => {
      assert.equal(isNyWarnCoveredEmployer(NY_WARN_EMPLOYER_THRESHOLD - 1), false);
      assert.equal(isNyWarnCoveredEmployer(NY_WARN_EMPLOYER_THRESHOLD), true);
    });

    test('a plant closing is a flat 25+ full-time employees, no percentage test', () => {
      assert.equal(isNyPlantClosing(24), false);
      assert.equal(isNyPlantClosing(25), true);
    });

    test('a mass layoff requires 25+ AND at least one-third of the site workforce', () => {
      assert.equal(isNyMassLayoff(25, 100), false); // 25% < 1/3
      assert.equal(isNyMassLayoff(34, 100), true); // 34% >= 1/3
      assert.equal(isNyMassLayoff(24, 50), false); // fails the 25-employee floor even though the percentage is high
    });

    test('250+ affected employees trigger mass-layoff coverage regardless of workforce percentage', () => {
      assert.equal(isNyMassLayoff(NY_WARN_MASS_LAYOFF_LARGE_THRESHOLD, 10_000), true);
    });
  });

  describe('New Jersey (single flat threshold, nationwide employer count, mandatory severance)', () => {
    test('employer coverage requires 100+ employees NATIONWIDE, any status', () => {
      assert.equal(isNjWarnCoveredEmployer(NJ_WARN_EMPLOYER_THRESHOLD - 1), false);
      assert.equal(isNjWarnCoveredEmployer(NJ_WARN_EMPLOYER_THRESHOLD), true);
    });

    test('the trigger is a flat 50 employees at a NJ establishment, with no percentage test at all', () => {
      assert.equal(isNjWarnTriggered(NJ_WARN_TRIGGER_MINIMUM_EMPLOYEES - 1), false);
      assert.equal(isNjWarnTriggered(NJ_WARN_TRIGGER_MINIMUM_EMPLOYEES), true);
    });

    test('mandatory severance is one week of pay per full year of service', () => {
      assert.equal(njMandatorySeverance(5, dollars(1_000)), 5 * dollars(1_000));
      assert.equal(njMandatorySeverance(5.9, dollars(1_000)), 5 * dollars(1_000)); // partial year does not round up
      assert.equal(njMandatorySeverance(0, dollars(1_000)), 0);
    });

    test('total severance adds a flat 4-week penalty on top of the base when notice was inadequate — the base is still owed either way', () => {
      const base = njMandatorySeverance(5, dollars(1_000));
      assert.equal(njTotalSeveranceOwed(5, dollars(1_000), true), base); // adequate notice: no penalty
      assert.equal(
        njTotalSeveranceOwed(5, dollars(1_000), false),
        base + NJ_WARN_INADEQUATE_NOTICE_PENALTY_WEEKS * dollars(1_000),
      ); // inadequate notice: base PLUS penalty
    });
  });

  describe('California (single flat threshold, independent relocation-distance trigger)', () => {
    test('employer coverage requires 75+ full- and part-time employees', () => {
      assert.equal(isCaWarnCoveredEmployer(CA_WARN_EMPLOYER_THRESHOLD - 1), false);
      assert.equal(isCaWarnCoveredEmployer(CA_WARN_EMPLOYER_THRESHOLD), true);
    });

    test('the trigger is a flat 50 employees, with no percentage test at all', () => {
      assert.equal(isCaWarnTriggered(CA_WARN_TRIGGER_MINIMUM_EMPLOYEES - 1), false);
      assert.equal(isCaWarnTriggered(CA_WARN_TRIGGER_MINIMUM_EMPLOYEES), true);
    });

    test('a relocation of 100+ miles triggers coverage independent of headcount', () => {
      assert.equal(isCaWarnRelocationTriggered(CA_WARN_RELOCATION_DISTANCE_MILES - 1), false);
      assert.equal(isCaWarnRelocationTriggered(CA_WARN_RELOCATION_DISTANCE_MILES), true);
    });
  });

  describe('notice deadlines', () => {
    test('miniWarnNoticeDeadline subtracts the state\'s own notice period from the planned action date', () => {
      assert.equal(miniWarnNoticeDeadline('CA', '2026-06-01'), '2026-04-02'); // 60 days before
      assert.equal(miniWarnNoticeDeadline('NY', '2026-06-01'), '2026-03-03'); // 90 days before
    });

    test('isMiniWarnNoticeLate compares against the state-specific deadline', () => {
      assert.equal(isMiniWarnNoticeLate('CA', '2026-04-02', '2026-06-01'), false); // exactly on deadline
      assert.equal(isMiniWarnNoticeLate('CA', '2026-04-03', '2026-06-01'), true); // one day late
    });
  });
});
