import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  CFRA_EMPLOYER_THRESHOLD,
  CFRA_MIN_MONTHS_EMPLOYED,
  CFRA_MIN_HOURS_OF_SERVICE,
  CFRA_LEAVE_WEEKS,
  CFRA_DESIGNATED_PERSONS_PER_YEAR,
  checkCfraEligibility,
  cfraHoursEntitlement,
  cfraHoursRemaining,
  cfraDesignatedPersonsRemaining,
} from '../payroll/cfra.ts';

describe('California Family Rights Act (payroll/cfra.ts)', () => {
  test('exactly 12 months employed does NOT qualify — CFRA requires strictly more', () => {
    const result = checkCfraEligibility({ monthsEmployed: 12, hoursOfServicePastTwelveMonths: CFRA_MIN_HOURS_OF_SERVICE, employeeCount: CFRA_EMPLOYER_THRESHOLD });
    assert.equal(result.eligible, false);
    assert.equal(result.reasons.length, 1);
    assert.match(result.reasons[0], /more than/i);
  });

  test('12.01 months (more than 12) passes the tenure prong', () => {
    const result = checkCfraEligibility({ monthsEmployed: 13, hoursOfServicePastTwelveMonths: CFRA_MIN_HOURS_OF_SERVICE, employeeCount: CFRA_EMPLOYER_THRESHOLD });
    assert.equal(result.eligible, true);
  });

  test('an employer with 5 employees statewide is covered — much lower than FMLA\'s own 50-employee test', () => {
    const result = checkCfraEligibility({ monthsEmployed: 13, hoursOfServicePastTwelveMonths: CFRA_MIN_HOURS_OF_SERVICE, employeeCount: 5 });
    assert.equal(result.eligible, true);
    assert.equal(checkCfraEligibility({ monthsEmployed: 13, hoursOfServicePastTwelveMonths: CFRA_MIN_HOURS_OF_SERVICE, employeeCount: 4 }).eligible, false);
  });

  test('every failing prong is reported at once, not just the first', () => {
    const result = checkCfraEligibility({ monthsEmployed: 1, hoursOfServicePastTwelveMonths: 100, employeeCount: 1 });
    assert.equal(result.eligible, false);
    assert.equal(result.reasons.length, 3);
  });

  test('hours entitlement scales with the employee\'s own regular schedule, never a flat figure', () => {
    assert.equal(cfraHoursEntitlement(40), 40 * CFRA_LEAVE_WEEKS);
    assert.equal(cfraHoursEntitlement(20), 20 * CFRA_LEAVE_WEEKS);
  });

  test('remaining hours never go negative', () => {
    assert.equal(cfraHoursRemaining(480, 480), 0);
    assert.equal(cfraHoursRemaining(480, 500), 0);
    assert.equal(cfraHoursRemaining(480, 100), 380);
  });

  test('designated persons remaining counts down from the 1-per-year default and never goes negative', () => {
    assert.equal(cfraDesignatedPersonsRemaining(0), CFRA_DESIGNATED_PERSONS_PER_YEAR);
    assert.equal(cfraDesignatedPersonsRemaining(1), 0);
    assert.equal(cfraDesignatedPersonsRemaining(5), 0);
  });
});
