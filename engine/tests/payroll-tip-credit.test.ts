import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { dollars } from '../src/money.ts';
import {
  FEDERAL_MINIMUM_WAGE_PER_HOUR,
  FEDERAL_TIPPED_CASH_WAGE_PER_HOUR,
  federalMaxTipCreditPerHour,
  stateTipCredit,
  tipCreditShortfall,
  isEligibleForTipPool,
} from '../payroll/tipCredit.ts';

describe('FLSA tip credit and tip pooling (payroll/tipCredit.ts)', () => {
  test('the federal maximum tip credit is $5.12/hour ($7.25 - $2.13)', () => {
    assert.equal(federalMaxTipCreditPerHour(), dollars(5.12));
    assert.equal(FEDERAL_MINIMUM_WAGE_PER_HOUR - FEDERAL_TIPPED_CASH_WAGE_PER_HOUR, federalMaxTipCreditPerHour());
  });

  describe('stateTipCredit', () => {
    test('a no-tip-credit state (California) has an equal cash and standard floor, with zero allowed credit', () => {
      const answer = stateTipCredit('2026-06-01', 'CA');
      assert.equal(answer.tipCreditAllowed, false);
      assert.equal(answer.cashFloorCentsPerHour, answer.standardFloorCentsPerHour);
      assert.equal(answer.maxTipCreditCentsPerHour, 0);
    });

    test('a federal-floor tip-credit state (Texas) allows the full $5.12 federal credit', () => {
      const answer = stateTipCredit('2026-06-01', 'TX');
      assert.equal(answer.tipCreditAllowed, true);
      assert.equal(answer.cashFloorCentsPerHour, dollars(2.13));
      assert.equal(answer.standardFloorCentsPerHour, dollars(7.25));
      assert.equal(answer.maxTipCreditCentsPerHour, dollars(5.12));
    });
  });

  describe('tipCreditShortfall', () => {
    test('is zero when cash wages plus tips meet the full minimum wage', () => {
      const shortfall = tipCreditShortfall({
        hoursWorked: 40,
        cashWageCentsPerHour: dollars(2.13),
        tipsReceivedCents: dollars(300), // 40 * 5.12 = 204.80 needed on top of cash
        requiredMinimumWageCentsPerHour: dollars(7.25),
      });
      assert.equal(shortfall, 0);
    });

    test('is the exact gap when tips fall short, hand-verified to the cent', () => {
      // owed: 40 * $7.25 = $290.00; paid: 40 * $2.13 + $100 tips = $85.20 + $100 = $185.20
      // shortfall: $290.00 - $185.20 = $104.80
      const shortfall = tipCreditShortfall({
        hoursWorked: 40,
        cashWageCentsPerHour: dollars(2.13),
        tipsReceivedCents: dollars(100),
        requiredMinimumWageCentsPerHour: dollars(7.25),
      });
      assert.equal(shortfall, dollars(104.8));
    });

    test('is zero, never negative, when tips exceed what is needed', () => {
      const shortfall = tipCreditShortfall({
        hoursWorked: 10,
        cashWageCentsPerHour: dollars(2.13),
        tipsReceivedCents: dollars(1_000),
        requiredMinimumWageCentsPerHour: dollars(7.25),
      });
      assert.equal(shortfall, 0);
    });
  });

  describe('isEligibleForTipPool', () => {
    test('a manager or supervisor is never eligible, regardless of tip-credit status', () => {
      assert.equal(isEligibleForTipPool({ isManagerOrSupervisor: true, customarilyReceivesTips: true, employerTakesTipCredit: false }), false);
      assert.equal(isEligibleForTipPool({ isManagerOrSupervisor: true, customarilyReceivesTips: true, employerTakesTipCredit: true }), false);
    });

    test('when the employer takes a tip credit, only customarily-tipped employees are eligible', () => {
      assert.equal(isEligibleForTipPool({ isManagerOrSupervisor: false, customarilyReceivesTips: true, employerTakesTipCredit: true }), true);
      assert.equal(isEligibleForTipPool({ isManagerOrSupervisor: false, customarilyReceivesTips: false, employerTakesTipCredit: true }), false);
    });

    test('when the employer takes no tip credit, every non-management employee is eligible', () => {
      assert.equal(isEligibleForTipPool({ isManagerOrSupervisor: false, customarilyReceivesTips: false, employerTakesTipCredit: false }), true);
      assert.equal(isEligibleForTipPool({ isManagerOrSupervisor: false, customarilyReceivesTips: true, employerTakesTipCredit: false }), true);
    });
  });
});
