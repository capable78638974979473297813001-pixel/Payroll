import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { dollars } from '../src/money.ts';
import {
  BACKUP_WITHHOLDING_RATE,
  awaitingTinGracePeriodEndDate,
  isWithinAwaitingTinGracePeriod,
  isBackupWithholdingRequired,
  backupWithholdingAmount,
  netPaymentAfterBackupWithholding,
} from '../payroll/backupWithholding.ts';

describe('IRS backup withholding (payroll/backupWithholding.ts)', () => {
  test('the awaiting-TIN grace period is 60 days from the certificate date', () => {
    assert.equal(awaitingTinGracePeriodEndDate('2026-03-01'), '2026-04-30');
  });

  test('a payment on or before the grace-period end date is within it; after is not', () => {
    assert.equal(isWithinAwaitingTinGracePeriod('2026-03-01', '2026-04-30'), true);
    assert.equal(isWithinAwaitingTinGracePeriod('2026-03-01', '2026-05-01'), false);
  });

  test('a valid TIN on file means backup withholding never applies, regardless of payment type', () => {
    assert.equal(isBackupWithholdingRequired('nonemployee_compensation', true, false), false);
    assert.equal(isBackupWithholdingRequired('interest_or_dividends', true, false), false);
  });

  test('nonemployee compensation with no valid TIN is ALWAYS withheld immediately, even within what would be the grace period for other payment types', () => {
    assert.equal(isBackupWithholdingRequired('nonemployee_compensation', false, true), true);
    assert.equal(isBackupWithholdingRequired('nonemployee_compensation', false, false), true);
  });

  test('interest/dividend payments get the awaiting-TIN grace period — no withholding while within it, required once it lapses', () => {
    assert.equal(isBackupWithholdingRequired('interest_or_dividends', false, true), false);
    assert.equal(isBackupWithholdingRequired('interest_or_dividends', false, false), true);
  });

  test('backup withholding is exactly 24% of the gross payment', () => {
    assert.equal(BACKUP_WITHHOLDING_RATE, 0.24);
    assert.equal(backupWithholdingAmount(dollars(1_000)), dollars(240));
  });

  test('net payment subtracts backup withholding only when required', () => {
    assert.equal(netPaymentAfterBackupWithholding(dollars(1_000), true), dollars(760));
    assert.equal(netPaymentAfterBackupWithholding(dollars(1_000), false), dollars(1_000));
  });
});
