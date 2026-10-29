/**
 * The California Family Rights Act (CFRA, Gov. Code § 12945.2) —
 * LIVE-VERIFIED against the California Civil Rights Department's own
 * "Expanded Family and Medical Leave in California" factsheet (fetched
 * and read directly 2026-09-14), not assumed from trained memory. An
 * earlier automated read of the SAME document initially mislabeled
 * CFRA's employer threshold as 50 — that turned out to be the document
 * quoting the OLD, pre-2021 rule it was explicitly describing as
 * ELIMINATED, not the current one; reading the source directly rather
 * than trusting a single extraction pass caught the error before it
 * reached this file.
 *
 * A GENUINELY DIFFERENT STATUTE from federal FMLA (payroll/fmla.ts),
 * not a copy: CFRA covers employers with just 5+ employees STATEWIDE
 * (no 50-employees-within-75-miles worksite test at all — that
 * limitation was eliminated effective January 1, 2021), and its tenure
 * prong is worded as "more than 12 months," a STRICT inequality —
 * exactly 12 months does not qualify, unlike FMLA's own "at least 12
 * months" phrasing which this project's own `checkFmlaEligibility()`
 * correctly treats as inclusive. Conflating the two thresholds or the
 * two tenure tests would be exactly the mistake payroll/fmla.ts's own
 * header warns against ("three different statutes, three different
 * definitions of 'how many employees, counted how'").
 *
 * SCOPE: eligibility and leave-entitlement arithmetic, the same two
 * facts payroll/fmla.ts's own header identifies as what a real leave
 * workflow needs and a naive implementation is likeliest to get wrong.
 * Deliberately does NOT model CFRA's interaction with California
 * Pregnancy Disability Leave (Gov. Code § 12945, a separate statute with
 * its own up-to-four-MONTH duration) — a real, additional piece of leave
 * law this module leaves out rather than repeating an unverified
 * "16 combined weeks" figure surfaced during research that could not be
 * corroborated and directly contradicts PDL's own known duration order
 * of magnitude. Does not track an actual leave request end to end, the
 * same category of gap payroll/fmla.ts's own header discloses.
 */

/** CRD: effective January 1, 2021, CFRA covers private employers with this many employees or more, STATEWIDE — no worksite-mileage aggregation test, unlike FMLA's own 75-mile worksite rule. */
export const CFRA_EMPLOYER_THRESHOLD = 5;

/** CRD, verbatim: "must have worked for the employer for MORE THAN 12 months" — a strict inequality, unlike FMLA's own inclusive "at least 12 months." */
export const CFRA_MIN_MONTHS_EMPLOYED = 12;

/** CRD: at least this many hours of service in the 12 months prior to leave — the same figure and "actually worked" concept as FMLA's own test. */
export const CFRA_MIN_HOURS_OF_SERVICE = 1250;

export const CFRA_LEAVE_WEEKS = 12;

/** CRD (2023 "designated person" expansion): an employer may limit an employee to this many designated persons (beyond the enumerated family-member list) per 12-month period. */
export const CFRA_DESIGNATED_PERSONS_PER_YEAR = 1;

/** CRD: when the need for leave is NOT foreseeable, notice must be given as soon as practicable, or within this many days of the employer's own request. */
export const CFRA_UNFORESEEABLE_NOTICE_DAYS = 15;

export interface CfraEligibilityInput {
  monthsEmployed: number;
  hoursOfServicePastTwelveMonths: number;
  employeeCount: number;
}

export interface CfraEligibilityResult {
  eligible: boolean;
  /** Empty when eligible; otherwise every failing prong in plain language, the same "report all three, not just the first" discipline payroll/fmla.ts's own eligibility check uses. */
  reasons: string[];
}

/** All three prongs must hold. `monthsEmployed` uses a STRICT inequality (must exceed 12, not merely reach it) — the one place this deliberately diverges from how payroll/fmla.ts checks its own, differently-worded 12-month prong. */
export function checkCfraEligibility(input: CfraEligibilityInput): CfraEligibilityResult {
  const reasons: string[] = [];
  if (!(input.monthsEmployed > CFRA_MIN_MONTHS_EMPLOYED)) {
    reasons.push(`Not more than ${CFRA_MIN_MONTHS_EMPLOYED} months employed (has ${input.monthsEmployed}) — CFRA requires MORE than ${CFRA_MIN_MONTHS_EMPLOYED} months.`);
  }
  if (input.hoursOfServicePastTwelveMonths < CFRA_MIN_HOURS_OF_SERVICE) {
    reasons.push(`Fewer than ${CFRA_MIN_HOURS_OF_SERVICE} hours of service in the preceding 12 months (has ${input.hoursOfServicePastTwelveMonths}).`);
  }
  if (input.employeeCount < CFRA_EMPLOYER_THRESHOLD) {
    reasons.push(`Fewer than ${CFRA_EMPLOYER_THRESHOLD} employees statewide (has ${input.employeeCount}).`);
  }
  return { eligible: reasons.length === 0, reasons };
}

/** An eligible employee's total CFRA leave entitlement in hours, scaled by their own regularly scheduled weekly hours — never a flat 480 regardless of full- or part-time status. */
export function cfraHoursEntitlement(regularlyScheduledWeeklyHours: number): number {
  return regularlyScheduledWeeklyHours * CFRA_LEAVE_WEEKS;
}

export function cfraHoursRemaining(totalEntitlementHours: number, hoursUsedThisPeriod: number): number {
  return Math.max(0, totalEntitlementHours - hoursUsedThisPeriod);
}

export function cfraDesignatedPersonsRemaining(designatedPersonsUsedThisPeriod: number): number {
  return Math.max(0, CFRA_DESIGNATED_PERSONS_PER_YEAR - designatedPersonsUsedThisPeriod);
}
