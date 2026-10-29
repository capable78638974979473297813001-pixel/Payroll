import { randomUUID } from 'node:crypto';
import type { Cents } from '../src/money.ts';
import { dollars } from '../src/money.ts';
import type { DirectDepositAccount } from './types.ts';

/**
 * 1099 contractors: a genuinely different population from `Employee` —
 * no W-4, no tax withholding at all (a contractor is responsible for
 * their own self-employment tax), no YTD wage-base tracking. What a
 * payroll company still owes a contractor is simple — pay them the
 * amount agreed, on the schedule agreed — and what it owes the IRS is a
 * single annual question: did this contractor cross the reporting
 * threshold, and if so, produce Form 1099-NEC.
 *
 * VERIFIED, NOT ASSUMED: the One Big Beautiful Bill Act (OBBBA, signed
 * July 2025) raised the 1099-NEC reporting threshold from its
 * long-standing $600 to $2,000, effective for payments made in 2026 — the
 * exact year this project is built around. Using the old $600 figure
 * here would have been a real, live mistake, not a stale-but-harmless
 * one; confirmed via live source review rather than trained-in memory,
 * the same discipline data/federal/2026.json's own sourced figures use.
 * Future years index this threshold for inflation — a value this project
 * doesn't have a source for yet, so FORM_1099_NEC_THRESHOLD only covers
 * 2026 and this module does not guess at later years.
 *
 * SCOPE: this does NOT generate Form 1099-NEC as a filable document,
 * does not verify a contractor's own backup-withholding status (an IRS
 * B-notice, an invalid TIN — which would require withholding at a flat
 * rate even from a nonemployee), and does not distinguish an
 * employee-vs-contractor MISCLASSIFICATION question — this project takes
 * the caller's own classification as given, the same way it takes
 * `employmentCategory` as given for an Employee.
 */

export interface Contractor {
  id: string;
  companyId: string;
  /** An individual's name or a business name — 1099-NEC doesn't distinguish the two in this field. */
  legalName: string;
  /**
   * SSN (individual) or EIN (business). Same production boundary as
   * Employee.ssn: a real system tokenizes or encrypts this rather than
   * storing it in a plain column the way this demo-scale store does.
   */
  tin: string;
  address: string;
  active: boolean;
  directDepositAccount?: DirectDepositAccount;
}

export interface ContractorPayment {
  id: string;
  contractorId: string;
  paymentDate: string; // ISO yyyy-mm-dd
  amount: Cents;
  description?: string;
}

/** OBBBA's 2026 threshold — see this module's own header comment. */
export const FORM_1099_NEC_THRESHOLD_2026 = dollars(2_000);

export interface Form1099NecSummary {
  contractorId: string;
  year: number;
  /** Box 1: total nonemployee compensation paid this year. */
  totalPayments: Cents;
  /** Whether this contractor crossed the year's reporting threshold — see this module's own header comment on why 2026 alone is covered. */
  reportingRequired: boolean;
  paymentCount: number;
}

export function recordContractorPayment(
  contractorId: string,
  amount: Cents,
  paymentDate: string,
  description?: string,
): ContractorPayment {
  return { id: randomUUID(), contractorId, amount, paymentDate, description };
}

export function compute1099Nec(contractorId: string, year: number, payments: readonly ContractorPayment[]): Form1099NecSummary {
  const paymentsThisYear = payments.filter((p) => p.contractorId === contractorId && p.paymentDate.startsWith(String(year)));
  const totalPayments = paymentsThisYear.reduce((sum, p) => sum + p.amount, 0);
  return {
    contractorId,
    year,
    totalPayments,
    reportingRequired: totalPayments >= FORM_1099_NEC_THRESHOLD_2026,
    paymentCount: paymentsThisYear.length,
  };
}
