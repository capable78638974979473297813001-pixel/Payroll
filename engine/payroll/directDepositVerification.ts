import { randomInt, randomUUID } from 'node:crypto';
import type { Cents } from '../src/money.ts';
import type { AchCredit } from './directDeposit.ts';
import type { DirectDepositAccount } from './types.ts';

/**
 * Verifying a bank account BEFORE trusting it with a real paycheck — the
 * two methods every real payroll company actually uses, because a
 * mistyped or fraudulent account number caught here is a same-day
 * correction, not a returned live entry (or worse, money sent to the
 * wrong person's account) two days after a pay run already ran.
 *
 * PRENOTE: a zero-dollar NACHA entry (transaction code 23/33, see
 * payroll/directDeposit.ts's own buildNachaFile()) sent through the same
 * ACH network a live payment would use. If the account or routing number
 * is bad, the receiving bank returns it or the account holder's own bank
 * sends a Notification of Change — exactly the same failure signal a
 * live payment would produce, just without any money at risk. NACHA's
 * own Operating Rules require waiting at least 3 BUSINESS days after the
 * prenote's settlement date before originating a live entry, unless a
 * return or NOC arrives first (this rule was reduced from 6 business
 * days in an earlier rule change — verified live rather than assumed
 * from stale memory, the same discipline payroll/aca.ts and
 * payroll/contractors.ts apply to their own dollar figures). This
 * module's business-day counter is calendar-only (Mon-Fri): it does NOT
 * exclude Federal Reserve holidays, a real gap disclosed here rather than
 * silently producing a slightly-too-short wait around a holiday.
 *
 * MICRO-DEPOSIT: two small (1-45 cent) live credits sent to the account;
 * the account holder reports both amounts back — something only someone
 * who can actually see the resulting bank statement could know — and a
 * match verifies the account without ever handling a real paycheck.
 * Slower than a prenote (it needs the account holder's own confirmation
 * step) but doesn't depend on the receiving bank's own NACHA compliance
 * (some smaller/newer institutions don't process prenotes correctly),
 * which is why real payroll products offer both rather than just one.
 *
 * SCOPE: this module tracks verification STATE (pending/verified/failed)
 * and produces the ACH entries a real bank movement needs; it does not
 * itself watch for an incoming NOC or return entry — a real deployment's
 * ACH-return-file ingestion (out of scope the same way live bank-linking
 * itself is, per payroll/directDeposit.ts's own header) is what actually
 * observes one and calls recordReturnOrNoc() below.
 */

export type VerificationMethod = 'prenote' | 'micro-deposit';
export type VerificationStatus = 'pending' | 'verified' | 'failed';

export interface DirectDepositVerification {
  id: string;
  accountId: string;
  method: VerificationMethod;
  status: VerificationStatus;
  createdAt: string; // ISO yyyy-mm-dd — the date the prenote/micro-deposits were originated
  /** Prenote only: the entry's own settlement date, the anchor the 3-business-day wait counts from. */
  settlementDate?: string;
  /**
   * Micro-deposit only: the two amounts actually deposited. Real systems
   * never expose this alongside the verification record itself in an
   * employee-facing API response — an endpoint that lets someone READ
   * this field defeats the entire point of asking them to report it
   * back. It exists here only so verifyMicroDeposits() has something to
   * check a guess against.
   */
  microDepositAmounts?: readonly [Cents, Cents];
  attemptsRemaining: number;
  verifiedAt?: string;
}

/** NACHA Operating Rules: at least this many business days must elapse after a prenote's settlement date, with no return/NOC received, before a live entry may follow. Reduced from a prior 6-business-day rule. */
export const PRENOTE_WAITING_PERIOD_BUSINESS_DAYS = 3;

/** How many guesses an account holder gets before micro-deposit verification is locked out — bounds the 45x45 = 2,025-combination guess space against brute force. */
export const MICRO_DEPOSIT_MAX_ATTEMPTS = 3;

const MICRO_DEPOSIT_MIN_CENTS = 1;
const MICRO_DEPOSIT_MAX_CENTS = 45;

export function initiatePrenoteVerification(accountId: string, settlementDate: string): DirectDepositVerification {
  return {
    id: randomUUID(),
    accountId,
    method: 'prenote',
    status: 'pending',
    createdAt: settlementDate,
    settlementDate,
    // A prenote is never "guessed" — attemptsRemaining is a micro-deposit-only concept, kept at 0 here since the field isn't optional.
    attemptsRemaining: 0,
  };
}

/** Builds the zero-dollar prenote entry this account's verification needs — feed the result straight into buildNachaFile() the same way a live payroll run feeds it real credits. */
export function buildPrenoteCredit(account: DirectDepositAccount, individualId: string, individualName: string): AchCredit {
  return {
    routingNumber: account.routingNumber,
    accountNumber: account.accountNumber,
    accountType: account.accountType,
    amount: 0,
    individualId,
    individualName,
    entryType: 'prenote',
  };
}

/** Counts Mon-Fri business days strictly between two ISO dates. Calendar-only — does not exclude Federal Reserve holidays; see this module's own header. */
function businessDaysBetween(fromIso: string, toIso: string): number {
  let count = 0;
  const cursor = new Date(`${fromIso}T00:00:00Z`);
  const end = new Date(`${toIso}T00:00:00Z`);
  while (cursor < end) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) count++;
  }
  return count;
}

/**
 * Resolves a pending prenote verification against today's date: VERIFIED
 * once at least PRENOTE_WAITING_PERIOD_BUSINESS_DAYS business days have
 * elapsed since settlement with no return/NOC reported, FAILED if one
 * was, still PENDING otherwise. Never mutates the input — same
 * immutable-record convention run.ts's own recalculatePayRun() uses.
 */
export function resolvePrenoteVerification(
  verification: DirectDepositVerification,
  asOfDate: string,
  receivedReturnOrNoc: boolean,
): DirectDepositVerification {
  if (verification.method !== 'prenote') {
    throw new Error(`resolvePrenoteVerification() called on a ${verification.method} verification`);
  }
  if (receivedReturnOrNoc) {
    return { ...verification, status: 'failed' };
  }
  const elapsed = businessDaysBetween(verification.settlementDate!, asOfDate);
  if (elapsed >= PRENOTE_WAITING_PERIOD_BUSINESS_DAYS) {
    return { ...verification, status: 'verified', verifiedAt: asOfDate };
  }
  return verification;
}

/** Two independent random amounts, 1-45 cents each — the same range real micro-deposit verification products use, small enough to never matter as money, large enough to differ from account to account. */
function generateMicroDepositAmounts(): [Cents, Cents] {
  return [
    randomInt(MICRO_DEPOSIT_MIN_CENTS, MICRO_DEPOSIT_MAX_CENTS + 1),
    randomInt(MICRO_DEPOSIT_MIN_CENTS, MICRO_DEPOSIT_MAX_CENTS + 1),
  ];
}

export function initiateMicroDepositVerification(accountId: string, initiatedDate: string): DirectDepositVerification {
  return {
    id: randomUUID(),
    accountId,
    method: 'micro-deposit',
    status: 'pending',
    createdAt: initiatedDate,
    microDepositAmounts: generateMicroDepositAmounts(),
    attemptsRemaining: MICRO_DEPOSIT_MAX_ATTEMPTS,
  };
}

/** Builds the two live (ordinary, non-prenote) tiny-dollar credits this verification's own amounts require — real money, just too small to matter, which is what makes it a verification independent of the receiving bank's own NACHA prenote handling. */
export function buildMicroDepositCredits(account: DirectDepositAccount, verification: DirectDepositVerification, individualId: string, individualName: string): AchCredit[] {
  if (verification.method !== 'micro-deposit' || !verification.microDepositAmounts) {
    throw new Error('buildMicroDepositCredits() requires a micro-deposit verification with its amounts generated');
  }
  return verification.microDepositAmounts.map((amount) => ({
    routingNumber: account.routingNumber,
    accountNumber: account.accountNumber,
    accountType: account.accountType,
    amount,
    individualId,
    individualName,
  }));
}

export interface MicroDepositVerifyResult {
  verification: DirectDepositVerification;
  correct: boolean;
}

/**
 * Checks a guessed pair of amounts against what was actually deposited —
 * order-independent, since a bank statement doesn't guarantee the two
 * postings appear in the order they were originated. Decrements the
 * attempt counter on every wrong guess and locks the verification to
 * FAILED once attempts run out, so the ~2,000-combination guess space
 * can't be brute-forced by an attacker who doesn't actually control the
 * account.
 */
export function verifyMicroDeposits(verification: DirectDepositVerification, guess: readonly [Cents, Cents]): MicroDepositVerifyResult {
  if (verification.method !== 'micro-deposit' || !verification.microDepositAmounts) {
    throw new Error('verifyMicroDeposits() requires a micro-deposit verification with its amounts generated');
  }
  if (verification.status !== 'pending') {
    return { verification, correct: verification.status === 'verified' };
  }

  const actual = [...verification.microDepositAmounts].sort((a, b) => a - b);
  const guessed = [...guess].sort((a, b) => a - b);
  const correct = actual[0] === guessed[0] && actual[1] === guessed[1];

  if (correct) {
    return { verification: { ...verification, status: 'verified', verifiedAt: verification.createdAt }, correct: true };
  }

  const attemptsRemaining = verification.attemptsRemaining - 1;
  const status = attemptsRemaining <= 0 ? 'failed' : 'pending';
  return { verification: { ...verification, attemptsRemaining, status }, correct: false };
}
