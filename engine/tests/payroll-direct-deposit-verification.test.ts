import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildNachaFile } from '../payroll/directDeposit.ts';
import type { AchFileConfig } from '../payroll/directDeposit.ts';
import {
  MICRO_DEPOSIT_MAX_ATTEMPTS,
  PRENOTE_WAITING_PERIOD_BUSINESS_DAYS,
  buildMicroDepositCredits,
  buildPrenoteCredit,
  initiateMicroDepositVerification,
  initiatePrenoteVerification,
  resolvePrenoteVerification,
  verifyMicroDeposits,
} from '../payroll/directDepositVerification.ts';
import type { DirectDepositAccount } from '../payroll/types.ts';

function account(overrides: Partial<DirectDepositAccount> = {}): DirectDepositAccount {
  return {
    id: 'acct-1',
    routingNumber: '021000021',
    accountNumber: '1234567',
    accountType: 'checking',
    allocation: { kind: 'remainder' },
    ...overrides,
  };
}

const config: AchFileConfig = {
  originRoutingNumber: '021000021',
  originName: 'Test Payroll Bank',
  immediateOriginId: '123456789',
  companyName: 'Acme Corp',
  companyIdentification: '1123456789',
  effectiveEntryDate: '2026-01-22',
};

describe('prenote verification (payroll/directDepositVerification.ts)', () => {
  test('a prenote credit carries a zero dollar amount and the prenote transaction code', () => {
    const credit = buildPrenoteCredit(account(), 'emp-1', 'Alice Smith');
    assert.equal(credit.amount, 0);
    assert.equal(credit.entryType, 'prenote');

    const file = buildNachaFile([credit], config);
    const entryRecord = file.trim().split('\r\n')[2];
    assert.equal(entryRecord.slice(1, 3), '23'); // checking prenote code
    assert.equal(Number(entryRecord.slice(29, 39)), 0);
  });

  test('a savings account prenote uses transaction code 33', () => {
    const credit = buildPrenoteCredit(account({ accountType: 'savings' }), 'emp-1', 'Alice Smith');
    const file = buildNachaFile([credit], config);
    const entryRecord = file.trim().split('\r\n')[2];
    assert.equal(entryRecord.slice(1, 3), '33');
  });

  test('buildNachaFile rejects a prenote entry with a nonzero amount', () => {
    const credit = buildPrenoteCredit(account(), 'emp-1', 'Alice Smith');
    assert.throws(() => buildNachaFile([{ ...credit, amount: 100 }], config), /zero dollar amount/);
  });

  test('stays pending before the 3-business-day waiting period elapses', () => {
    const verification = initiatePrenoteVerification('acct-1', '2026-01-05'); // a Monday
    const resolved = resolvePrenoteVerification(verification, '2026-01-07', false); // Wednesday, 2 business days later
    assert.equal(resolved.status, 'pending');
  });

  test('verifies once at least 3 business days elapse with no return/NOC, weekends excluded from the count', () => {
    const verification = initiatePrenoteVerification('acct-1', '2026-01-05'); // Monday
    // Mon -> Tue(1) Wed(2) Thu(3): 3 business days by Thursday
    const resolved = resolvePrenoteVerification(verification, '2026-01-08', false);
    assert.equal(resolved.status, 'verified');
    assert.equal(resolved.verifiedAt, '2026-01-08');
  });

  test('weekends between settlement and the check date do not count as business days', () => {
    const verification = initiatePrenoteVerification('acct-1', '2026-01-09'); // Friday
    // Fri -> Sat(no) Sun(no) Mon(1) Tue(2): only 2 business days by Tuesday
    const stillPending = resolvePrenoteVerification(verification, '2026-01-13', false);
    assert.equal(stillPending.status, 'pending');
    // Fri -> ... Wed(3): verified by Wednesday
    const verified = resolvePrenoteVerification(verification, '2026-01-14', false);
    assert.equal(verified.status, 'verified');
  });

  test('a returned entry or Notification of Change fails verification regardless of elapsed time', () => {
    const verification = initiatePrenoteVerification('acct-1', '2026-01-05');
    const resolved = resolvePrenoteVerification(verification, '2026-01-20', true);
    assert.equal(resolved.status, 'failed');
  });

  test('resolvePrenoteVerification() does not mutate the input record', () => {
    const verification = initiatePrenoteVerification('acct-1', '2026-01-05');
    resolvePrenoteVerification(verification, '2026-01-20', false);
    assert.equal(verification.status, 'pending');
  });
});

describe('micro-deposit verification (payroll/directDepositVerification.ts)', () => {
  test('generates two amounts within the 1-45 cent range', () => {
    const verification = initiateMicroDepositVerification('acct-1', '2026-01-05');
    assert.equal(verification.microDepositAmounts!.length, 2);
    for (const amount of verification.microDepositAmounts!) {
      assert.ok(amount >= 1 && amount <= 45, `amount ${amount} out of range`);
    }
  });

  test('builds two live (non-prenote) credits for the generated amounts', () => {
    const verification = initiateMicroDepositVerification('acct-1', '2026-01-05');
    const credits = buildMicroDepositCredits(account(), verification, 'emp-1', 'Alice Smith');
    assert.equal(credits.length, 2);
    assert.deepEqual(credits.map((c) => c.amount).sort((a, b) => a - b), [...verification.microDepositAmounts!].sort((a, b) => a - b));
    for (const c of credits) assert.equal(c.entryType, undefined); // 'live', the default
  });

  test('the correct pair of amounts verifies the account, in either order', () => {
    const verification = initiateMicroDepositVerification('acct-1', '2026-01-05');
    const [a, b] = verification.microDepositAmounts!;
    const result = verifyMicroDeposits(verification, [b, a]);
    assert.equal(result.correct, true);
    assert.equal(result.verification.status, 'verified');
  });

  test('a wrong guess decrements attemptsRemaining without failing outright', () => {
    const verification = initiateMicroDepositVerification('acct-1', '2026-01-05');
    // A guess guaranteed wrong regardless of what was actually generated.
    const wrongGuess: [number, number] = [
      verification.microDepositAmounts![0] === 99 ? 1 : 99,
      verification.microDepositAmounts![1] === 98 ? 2 : 98,
    ];
    const wrong = verifyMicroDeposits(verification, wrongGuess);
    assert.equal(wrong.correct, false);
    assert.equal(wrong.verification.status, 'pending');
    assert.equal(wrong.verification.attemptsRemaining, MICRO_DEPOSIT_MAX_ATTEMPTS - 1);
  });

  test('locks to failed once attempts are exhausted, bounding the guess space against brute force', () => {
    let verification = initiateMicroDepositVerification('acct-1', '2026-01-05');
    const wrongGuess: [number, number] = [
      verification.microDepositAmounts![0] === 99 ? 1 : 99,
      verification.microDepositAmounts![1] === 98 ? 2 : 98,
    ];
    for (let i = 0; i < MICRO_DEPOSIT_MAX_ATTEMPTS; i++) {
      const result = verifyMicroDeposits(verification, wrongGuess);
      verification = result.verification;
    }
    assert.equal(verification.status, 'failed');
    assert.equal(verification.attemptsRemaining, 0);
  });

  test('a verified or failed verification does not accept further guesses', () => {
    let verification = initiateMicroDepositVerification('acct-1', '2026-01-05');
    const [a, b] = verification.microDepositAmounts!;
    verification = verifyMicroDeposits(verification, [a, b]).verification;
    assert.equal(verification.status, 'verified');
    const again = verifyMicroDeposits(verification, [999, 998]);
    assert.equal(again.verification.status, 'verified');
    assert.equal(again.correct, true);
  });
});

describe('PRENOTE_WAITING_PERIOD_BUSINESS_DAYS constant', () => {
  test('is the current NACHA rule figure (3 business days, reduced from a prior 6)', () => {
    assert.equal(PRENOTE_WAITING_PERIOD_BUSINESS_DAYS, 3);
  });
});
