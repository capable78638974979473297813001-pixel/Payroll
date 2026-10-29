import type { Cents } from '../src/money.ts';

/**
 * IRS backup withholding (26 U.S.C. § 3406) for a missing or invalid
 * taxpayer identification number — LIVE-VERIFIED against the IRS's own
 * pages, not assumed from trained memory:
 *  - https://www.irs.gov/businesses/small-businesses-self-employed/backup-withholding
 *    (the 24% rate)
 *  - https://www.irs.gov/instructions/iw9 (the awaiting-TIN exception's
 *    scope)
 * (both fetched 2026-09-13).
 *
 * THE ONE DETAIL THAT MATTERS MOST FOR A 1099-NEC PAYER: a payee who has
 * applied for a TIN and is genuinely awaiting one gets a 60-day grace
 * period before backup withholding must start — but ONLY for interest,
 * dividends, and certain broker payments on readily tradable instruments.
 * The IRS's own instructions are explicit that this grace period does
 * NOT extend to nonemployee compensation: "Any other reportable payment,
 * such as nonemployee compensation, is subject to backup withholding
 * immediately, even if the payee has applied for and is awaiting a TIN."
 * A contractor payment (this project's own payroll/contractors.ts) with
 * no TIN on file is therefore ALWAYS subject to backup withholding from
 * the first payment — never given the same grace an interest or dividend
 * payment would get.
 *
 * SCOPE: this module computes only the RATE and TRIGGER — whether backup
 * withholding applies to a given payment and how much it withholds. It
 * does NOT model the "B notice" procedural workflow (the IRS's CP2100/
 * CP2100A mismatch notices, first-notice vs. second-notice-within-3-years
 * consequences, or the payee's own response deadlines) — those are a
 * real, separate compliance workflow this project doesn't have enough
 * independently-verified precision on to model responsibly, the same
 * "disclosed, not guessed" discipline applied everywhere else in this
 * project.
 */

export type BackupWithholdingPaymentType = 'nonemployee_compensation' | 'interest_or_dividends';

/** IRS: the flat backup withholding rate. */
export const BACKUP_WITHHOLDING_RATE = 0.24;

/** IRS: the grace period for a payee who has applied for and is awaiting a TIN — applicable ONLY to interest/dividends/certain broker payments, never to nonemployee compensation. */
export const AWAITING_TIN_GRACE_PERIOD_DAYS = 60;

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

export function awaitingTinGracePeriodEndDate(certificateReceivedDate: string): string {
  return addDays(certificateReceivedDate, AWAITING_TIN_GRACE_PERIOD_DAYS);
}

export function isWithinAwaitingTinGracePeriod(certificateReceivedDate: string, paymentDate: string): boolean {
  return paymentDate <= awaitingTinGracePeriodEndDate(certificateReceivedDate);
}

/**
 * True when backup withholding must be applied to this payment. A valid
 * TIN on file means never. Without one, nonemployee compensation is
 * ALWAYS withheld from the first payment — the awaiting-TIN grace period
 * simply doesn't exist for this payment type. Interest/dividend payments
 * DO get that grace, but only while still within it.
 */
export function isBackupWithholdingRequired(paymentType: BackupWithholdingPaymentType, hasValidTinOnFile: boolean, isWithinGracePeriod: boolean): boolean {
  if (hasValidTinOnFile) return false;
  if (paymentType === 'nonemployee_compensation') return true;
  return !isWithinGracePeriod;
}

export function backupWithholdingAmount(grossPaymentCents: Cents): Cents {
  return Math.round(grossPaymentCents * BACKUP_WITHHOLDING_RATE);
}

export function netPaymentAfterBackupWithholding(grossPaymentCents: Cents, backupWithholdingRequired: boolean): Cents {
  return backupWithholdingRequired ? grossPaymentCents - backupWithholdingAmount(grossPaymentCents) : grossPaymentCents;
}
