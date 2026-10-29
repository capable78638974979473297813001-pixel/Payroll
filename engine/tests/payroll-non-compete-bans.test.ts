import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { dollars } from '../src/money.ts';
import {
  MN_NON_COMPETE_BAN_EFFECTIVE_DATE,
  isNonCompeteVoidInTotalBanState,
  CO_NON_COMPETE_THRESHOLD_2026,
  coNonSolicitThreshold2026,
  isCoNonCompeteEnforceable,
  isCoNonSolicitEnforceable,
  IL_NON_COMPETE_THRESHOLD_STEP_DATE_2027,
  IL_NON_COMPETE_THRESHOLD_THROUGH_2026,
  IL_NON_COMPETE_THRESHOLD_FROM_2027,
  IL_NON_SOLICIT_THRESHOLD_THROUGH_2026,
  ilNonCompeteThreshold,
  ilNonSolicitThreshold,
  isIlNonCompeteEnforceable,
  isIlNonSolicitEnforceable,
  WA_NON_COMPETE_TOTAL_BAN_EFFECTIVE_DATE,
  WA_NON_COMPETE_EMPLOYEE_THRESHOLD_2026,
  WA_NON_COMPETE_INDEPENDENT_CONTRACTOR_THRESHOLD_2026,
  isWaNonCompeteEnforceable,
  OR_NON_COMPETE_THRESHOLD_2026,
  isOrNonCompeteEnforceable,
} from '../payroll/nonCompeteBans.ts';

describe('State non-compete bans and thresholds (payroll/nonCompeteBans.ts)', () => {
  describe('total-ban states', () => {
    test('California, North Dakota, and Oklahoma void every non-compete regardless of date', () => {
      assert.equal(isNonCompeteVoidInTotalBanState('CA', '1999-01-01'), true);
      assert.equal(isNonCompeteVoidInTotalBanState('ND', '1900-01-01'), true);
      assert.equal(isNonCompeteVoidInTotalBanState('OK', '2050-01-01'), true);
    });

    test("Minnesota's ban is NOT retroactive: void only from 2023-07-01 forward", () => {
      assert.equal(isNonCompeteVoidInTotalBanState('MN', '2023-06-30'), false);
      assert.equal(isNonCompeteVoidInTotalBanState('MN', MN_NON_COMPETE_BAN_EFFECTIVE_DATE), true);
      assert.equal(isNonCompeteVoidInTotalBanState('MN', '2024-01-01'), true);
    });
  });

  describe('Colorado', () => {
    test('the non-solicit threshold is exactly 60% of the non-compete threshold ($78,008.40)', () => {
      assert.equal(coNonSolicitThreshold2026(), dollars(78_008.4));
    });

    test('non-compete enforceability requires meeting the $130,014 threshold', () => {
      assert.equal(isCoNonCompeteEnforceable(CO_NON_COMPETE_THRESHOLD_2026 - dollars(1)), false);
      assert.equal(isCoNonCompeteEnforceable(CO_NON_COMPETE_THRESHOLD_2026), true);
    });

    test('non-solicit enforceability requires meeting the lower $78,008.40 threshold', () => {
      assert.equal(isCoNonSolicitEnforceable(dollars(78_008.4) - dollars(1)), false);
      assert.equal(isCoNonSolicitEnforceable(dollars(78_008.4)), true);
    });
  });

  describe('Illinois', () => {
    test('thresholds through 2026 are $75,000 non-compete / $45,000 non-solicit', () => {
      assert.equal(ilNonCompeteThreshold('2026-12-31'), IL_NON_COMPETE_THRESHOLD_THROUGH_2026);
      assert.equal(ilNonSolicitThreshold('2026-12-31'), IL_NON_SOLICIT_THRESHOLD_THROUGH_2026);
    });

    test('thresholds step up to $80,000 / $47,500 starting 2027-01-01, on a fixed schedule (not CPI)', () => {
      assert.equal(ilNonCompeteThreshold(IL_NON_COMPETE_THRESHOLD_STEP_DATE_2027), IL_NON_COMPETE_THRESHOLD_FROM_2027);
      assert.equal(ilNonCompeteThreshold('2027-06-01'), IL_NON_COMPETE_THRESHOLD_FROM_2027);
    });

    test('enforceability is a function of both compensation and date', () => {
      assert.equal(isIlNonCompeteEnforceable(dollars(76_000), '2026-06-01'), true);
      assert.equal(isIlNonCompeteEnforceable(dollars(76_000), '2027-06-01'), false); // meets old but not new threshold
      assert.equal(isIlNonSolicitEnforceable(dollars(45_000), '2026-06-01'), true);
    });
  });

  describe('Washington', () => {
    test('employee and independent contractor thresholds are genuinely different figures', () => {
      assert.equal(isWaNonCompeteEnforceable(WA_NON_COMPETE_EMPLOYEE_THRESHOLD_2026, false, '2026-06-01'), true);
      assert.equal(isWaNonCompeteEnforceable(WA_NON_COMPETE_EMPLOYEE_THRESHOLD_2026, true, '2026-06-01'), false); // meets employee threshold but not the much higher contractor one
      assert.equal(isWaNonCompeteEnforceable(WA_NON_COMPETE_INDEPENDENT_CONTRACTOR_THRESHOLD_2026, true, '2026-06-01'), true);
    });

    test('every non-compete is void from the 2027-06-30 total-ban date forward, regardless of compensation', () => {
      assert.equal(isWaNonCompeteEnforceable(dollars(10_000_000), false, WA_NON_COMPETE_TOTAL_BAN_EFFECTIVE_DATE), false);
      assert.equal(isWaNonCompeteEnforceable(dollars(10_000_000), false, '2027-06-29'), true);
    });
  });

  describe('Oregon', () => {
    test('requires ALL THREE conditions: salary threshold, 12-month max term, and 14-day advance notice', () => {
      assert.equal(
        isOrNonCompeteEnforceable({ annualCompensationCents: OR_NON_COMPETE_THRESHOLD_2026, termMonths: 12, advanceNoticeDays: 14 }),
        true,
      );
      assert.equal(
        isOrNonCompeteEnforceable({ annualCompensationCents: OR_NON_COMPETE_THRESHOLD_2026 - dollars(1), termMonths: 12, advanceNoticeDays: 14 }),
        false,
      ); // fails salary
      assert.equal(
        isOrNonCompeteEnforceable({ annualCompensationCents: OR_NON_COMPETE_THRESHOLD_2026, termMonths: 13, advanceNoticeDays: 14 }),
        false,
      ); // fails duration
      assert.equal(
        isOrNonCompeteEnforceable({ annualCompensationCents: OR_NON_COMPETE_THRESHOLD_2026, termMonths: 12, advanceNoticeDays: 13 }),
        false,
      ); // fails notice
    });
  });
});
