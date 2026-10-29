import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { dollars } from '../src/money.ts';
import {
  USERRA_CUMULATIVE_SERVICE_LIMIT_YEARS,
  USERRA_MEDIUM_SERVICE_APPLICATION_DEADLINE_DAYS,
  USERRA_LONG_SERVICE_APPLICATION_DEADLINE_DAYS,
  userraReemploymentTier,
  userraApplicationDeadlineDays,
  isWithinCumulativeServiceLimit,
  userraDisabilityReportDeadline,
  isHealthContinuationElectionRequired,
  userraMaxHealthContinuationPremium,
} from '../payroll/userra.ts';

describe('USERRA (payroll/userra.ts)', () => {
  test('service under 31 days is the immediate-return tier', () => {
    assert.equal(userraReemploymentTier(30), 'immediate_return');
    assert.equal(userraApplicationDeadlineDays(30), 0);
  });

  test('service from 31 to 180 days requires an application within 14 days', () => {
    assert.equal(userraReemploymentTier(31), 'medium_service_application');
    assert.equal(userraReemploymentTier(180), 'medium_service_application');
    assert.equal(userraApplicationDeadlineDays(31), USERRA_MEDIUM_SERVICE_APPLICATION_DEADLINE_DAYS);
    assert.equal(userraApplicationDeadlineDays(180), USERRA_MEDIUM_SERVICE_APPLICATION_DEADLINE_DAYS);
  });

  test('service over 180 days requires an application within 90 days', () => {
    assert.equal(userraReemploymentTier(181), 'long_service_application');
    assert.equal(userraApplicationDeadlineDays(181), USERRA_LONG_SERVICE_APPLICATION_DEADLINE_DAYS);
  });

  test('the cumulative service limit is 5 years, exceptions already excluded by the caller', () => {
    assert.equal(isWithinCumulativeServiceLimit(5), true);
    assert.equal(isWithinCumulativeServiceLimit(5.01), false);
    assert.equal(isWithinCumulativeServiceLimit(USERRA_CUMULATIVE_SERVICE_LIMIT_YEARS), true);
  });

  test('the disability report deadline is 2 years after service completion', () => {
    assert.equal(userraDisabilityReportDeadline('2026-03-15'), '2028-03-15');
  });

  test('health continuation election is required only for service beyond 30 days', () => {
    assert.equal(isHealthContinuationElectionRequired(30), false);
    assert.equal(isHealthContinuationElectionRequired(31), true);
  });

  test('the maximum health continuation premium is 102% of the full premium', () => {
    assert.equal(userraMaxHealthContinuationPremium(dollars(500)), dollars(510));
  });
});
