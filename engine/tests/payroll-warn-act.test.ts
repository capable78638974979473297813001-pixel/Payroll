import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  WARN_EMPLOYER_THRESHOLD,
  WARN_PLANT_CLOSING_MINIMUM_EMPLOYEES,
  WARN_MASS_LAYOFF_LARGE_THRESHOLD,
  isPartTimeForWarnPurposes,
  isWarnCoveredEmployer,
  isPlantClosing,
  isMassLayoff,
  warnNoticeDeadline,
  isWarnNoticeLate,
  areWithinWarnAggregationWindow,
  isWarnNoticeRequirementEliminated,
  warnExceptionGuidance,
} from '../payroll/warnAct.ts';

describe('federal WARN Act (payroll/warnAct.ts)', () => {
  test('an employee under 20 hours/week or under 6 months tenure is part-time', () => {
    assert.equal(isPartTimeForWarnPurposes(19, 12), true);
    assert.equal(isPartTimeForWarnPurposes(40, 5), true);
    assert.equal(isPartTimeForWarnPurposes(20, 6), false);
    assert.equal(isPartTimeForWarnPurposes(40, 12), false);
  });

  test('an employer is covered at exactly 100 full-time-equivalent employees', () => {
    assert.equal(isWarnCoveredEmployer(99), false);
    assert.equal(isWarnCoveredEmployer(WARN_EMPLOYER_THRESHOLD), true);
    assert.equal(isWarnCoveredEmployer(150), true);
  });

  test('a plant closing requires at least 50 employees losing employment at the site', () => {
    assert.equal(isPlantClosing(49), false);
    assert.equal(isPlantClosing(WARN_PLANT_CLOSING_MINIMUM_EMPLOYEES), true);
  });

  test('500+ affected employees is always a mass layoff regardless of workforce fraction', () => {
    assert.equal(isMassLayoff(WARN_MASS_LAYOFF_LARGE_THRESHOLD, 100_000), true);
    assert.equal(isMassLayoff(600, 10_000), true);
  });

  test('50-499 affected employees is a mass layoff only if it is also at least one-third of the site workforce', () => {
    assert.equal(isMassLayoff(50, 200), false); // 50/200 = 25%, below one-third
    assert.equal(isMassLayoff(50, 150), true); // 50/150 = 33.3%, meets one-third
    assert.equal(isMassLayoff(499, 10_000), false); // large count but tiny fraction of a huge site
  });

  test('under 50 affected employees is never a mass layoff even at 100% of a tiny site', () => {
    assert.equal(isMassLayoff(10, 10), false);
  });

  test('notice deadline is 60 days before the planned action date', () => {
    assert.equal(warnNoticeDeadline('2026-06-01'), '2026-04-02');
  });

  test('notice served after the 60-day deadline is late; on or before it is not', () => {
    assert.equal(isWarnNoticeLate('2026-04-03', '2026-06-01'), true);
    assert.equal(isWarnNoticeLate('2026-04-02', '2026-06-01'), false);
    assert.equal(isWarnNoticeLate('2026-01-01', '2026-06-01'), false);
  });

  test('events at most 90 days apart fall within the aggregation window', () => {
    assert.equal(areWithinWarnAggregationWindow('2026-01-01', '2026-04-01'), true); // exactly 90 days
    assert.equal(areWithinWarnAggregationWindow('2026-01-01', '2026-04-02'), false); // 91 days
    assert.equal(areWithinWarnAggregationWindow('2026-04-01', '2026-01-01'), true); // order-independent
  });

  test('only the natural-disaster exception eliminates notice entirely', () => {
    assert.equal(isWarnNoticeRequirementEliminated('natural_disaster'), true);
    assert.equal(isWarnNoticeRequirementEliminated('faltering_company'), false);
    assert.equal(isWarnNoticeRequirementEliminated('unforeseeable_business_circumstances'), false);
  });

  test('every exception reason has its own guidance text', () => {
    for (const reason of ['faltering_company', 'unforeseeable_business_circumstances', 'natural_disaster'] as const) {
      assert.ok(warnExceptionGuidance(reason).length > 0);
    }
  });
});
