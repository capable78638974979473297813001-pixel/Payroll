import type { Cents } from '../src/money.ts';
import { dollars } from '../src/money.ts';

/**
 * California pay data reporting (Government Code § 12999) — LIVE-
 * VERIFIED by reading the Civil Rights Department's own "California Pay
 * Data Reporting Handbook, Reporting Year 2025" directly (calcivilrights
 * .ca.gov), not assumed from trained memory. Fetched 2026-09-14. Every
 * constant below — the 12 pay bands, the 10 job categories, the
 * penalties, and the filing-deadline rule — is copied verbatim from that
 * handbook's own tables rather than reconstructed from a secondary
 * source, since earlier research for this module surfaced conflicting
 * third-party figures for the top pay band boundary ($208,000 vs.
 * $239,200) that only the primary handbook resolved.
 *
 * TWO INDEPENDENT REPORT TYPES, EACH WITH ITS OWN 100-EMPLOYEE TEST: a
 * "payroll employee report" (100+ of the employer's own payroll
 * employees) and a "labor contractor employee report" (100+ workers
 * supplied through labor contractors) — an employer may owe one, the
 * other, both, or neither, since the two headcounts are never combined
 * for threshold purposes. `caPayDataReportRequired()` returns both
 * answers rather than a single boolean, since collapsing them would
 * misrepresent an employer that owes only one report type as owing
 * neither or both.
 *
 * SCOPE: does not model the "integrated enterprise" test for combining
 * affiliated entities' headcounts (interrelated operations, common
 * management, centralized labor relations, common ownership — a
 * multi-factor judgment call with no closed-form answer, the same kind
 * of scope boundary `payroll/warnAct.ts`'s own exception guidance
 * draws), the race/ethnicity or sex reporting categories, or the mean/
 * median hourly rate calculations the handbook also requires — those are
 * aggregation and self-identification questions this project's own
 * `Employee` type has no fields to answer, not a formula this module
 * could compute wrong. Only the coverage test, the pay-band
 * classification, the job categories, the penalty structure, and the
 * filing deadline are modeled.
 */

/** Gov. Code § 12999: each report type is triggered independently once an employer reaches this many employees of that type. */
export const CA_PAY_DATA_EMPLOYER_THRESHOLD = 100;

/** Gov. Code § 12999(b)(1): the ten EEO-1-style job categories, in the handbook's own numbered order. */
export const CA_PAY_DATA_JOB_CATEGORIES = [
  'Executive or senior level officials and managers',
  'First or mid-level officials and managers',
  'Professionals',
  'Technicians',
  'Sales workers',
  'Administrative support workers',
  'Craft workers',
  'Operatives',
  'Laborers and helpers',
  'Service workers',
] as const;

export type CaPayDataJobCategory = (typeof CA_PAY_DATA_JOB_CATEGORIES)[number];

/**
 * Gov. Code § 12999(b)(2), via the handbook's own pay-band table: 12
 * annual-earnings bands based on W-2 Box 5. Each entry is [minCents,
 * maxCents], with `undefined` marking the open ends of band 1 (no
 * floor) and band 12 (no ceiling).
 */
export const CA_PAY_DATA_PAY_BANDS: ReadonlyArray<{ minCents?: Cents; maxCents?: Cents }> = [
  { maxCents: dollars(19_239) },
  { minCents: dollars(19_240), maxCents: dollars(24_959) },
  { minCents: dollars(24_960), maxCents: dollars(32_239) },
  { minCents: dollars(32_240), maxCents: dollars(41_079) },
  { minCents: dollars(41_080), maxCents: dollars(53_039) },
  { minCents: dollars(53_040), maxCents: dollars(68_119) },
  { minCents: dollars(68_120), maxCents: dollars(87_359) },
  { minCents: dollars(87_360), maxCents: dollars(112_319) },
  { minCents: dollars(112_320), maxCents: dollars(144_559) },
  { minCents: dollars(144_560), maxCents: dollars(186_159) },
  { minCents: dollars(186_160), maxCents: dollars(239_199) },
  { minCents: dollars(239_200) },
];

/** Up to this amount per employee for an employer's first failure to file, per court order upon CRD's request. */
export const CA_PAY_DATA_PENALTY_FIRST_FAILURE: Cents = dollars(100);

/** Up to this amount per employee for a SUBSEQUENT failure to file. */
export const CA_PAY_DATA_PENALTY_SUBSEQUENT_FAILURE: Cents = dollars(200);

export interface CaPayDataReportRequirement {
  payrollReportRequired: boolean;
  laborContractorReportRequired: boolean;
}

/**
 * Whether an employer owes a payroll employee report, a labor
 * contractor employee report, both, or neither — the two 100-employee
 * tests are evaluated completely independently, since the statute never
 * combines the two headcounts.
 */
export function caPayDataReportRequired(payrollEmployeeCount: number, laborContractorEmployeeCount: number): CaPayDataReportRequirement {
  return {
    payrollReportRequired: payrollEmployeeCount >= CA_PAY_DATA_EMPLOYER_THRESHOLD,
    laborContractorReportRequired: laborContractorEmployeeCount >= CA_PAY_DATA_EMPLOYER_THRESHOLD,
  };
}

/**
 * Classifies an employee's annual earnings (W-2 Box 5, per the
 * handbook's own instruction) into one of the 12 pay bands, returning
 * the 1-indexed band number the handbook itself uses in its data-file
 * upload codes. Throws if the amount is negative, since no band covers
 * that — the handbook has no provision for it either.
 */
export function classifyCaPayBand(annualEarningsCents: Cents): number {
  if (annualEarningsCents < 0) throw new Error('annualEarningsCents must not be negative');
  for (let i = 0; i < CA_PAY_DATA_PAY_BANDS.length; i++) {
    const band = CA_PAY_DATA_PAY_BANDS[i];
    const aboveMin = band.minCents === undefined || annualEarningsCents >= band.minCents;
    const belowMax = band.maxCents === undefined || annualEarningsCents <= band.maxCents;
    if (aboveMin && belowMax) return i + 1;
  }
  throw new Error('annualEarningsCents did not match any pay band');
}

/**
 * Gov. Code § 12999(a): the filing deadline is the second Wednesday of
 * May, in the calendar year AFTER the reporting year (e.g. Reporting
 * Year 2025's deadline falls in May 2026 — hand-verified against the
 * handbook's own stated May 13, 2026 deadline for Reporting Year 2025).
 */
export function caPayDataFilingDeadline(reportingYear: number): string {
  const filingYear = reportingYear + 1;
  const firstOfMay = new Date(Date.UTC(filingYear, 4, 1));
  const firstWednesdayDay = 1 + ((3 - firstOfMay.getUTCDay() + 7) % 7);
  const secondWednesdayDay = firstWednesdayDay + 7;
  return `${filingYear}-05-${String(secondWednesdayDay).padStart(2, '0')}`;
}

/**
 * Total penalty exposure across every employee covered by a failed
 * report: the $100/employee first-failure rate, or the $200/employee
 * subsequent-failure rate — both are court-ordered CEILINGS ("up to"),
 * not flat mandatory amounts, but this function returns the ceiling
 * itself as the worst-case exposure.
 */
export function caPayDataPenaltyExposure(employeeCount: number, isSubsequentFailure: boolean): Cents {
  if (employeeCount <= 0) return 0;
  const perEmployee = isSubsequentFailure ? CA_PAY_DATA_PENALTY_SUBSEQUENT_FAILURE : CA_PAY_DATA_PENALTY_FIRST_FAILURE;
  return employeeCount * perEmployee;
}
