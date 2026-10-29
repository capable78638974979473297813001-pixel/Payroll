/**
 * The federal PUMP Act (Providing Urgent Maternal Protections for
 * Nursing Mothers Act, amending FLSA § 7(r), effective April 28, 2023) —
 * LIVE-VERIFIED against DOL's own Fact Sheet #73, not assumed from
 * trained memory:
 *  - https://www.dol.gov/agencies/whd/fact-sheets/73-flsa-break-time-nursing-mothers
 * (fetched 2026-09-13).
 *
 * SCOPE: pure eligibility/pay/space math over caller-supplied dates and
 * facts — this project tracks no employee birth-of-child event or
 * pumping-break log, so every input here (the child's birth date, the
 * small-employer headcount, whether a given break coincided with duty or
 * with an already-paid break, the physical qualities of a space) is a
 * parameter the caller supplies, the same "count/fact supplied, not
 * derived" boundary payroll/cobra.ts and payroll/warnAct.ts already draw
 * around their own caller-supplied headcounts.
 *
 * DISCLOSED GAP: the fewer-than-50-employees exemption requires BOTH a
 * headcount below the threshold AND a fact-specific showing that full
 * compliance would be an "undue hardship" (weighed against the
 * employer's size, financial resources, nature, and structure) —
 * `mayQualifyForSmallEmployerExemption()` checks only the headcount half
 * of that test; the undue-hardship showing itself is a legal judgment
 * this module doesn't attempt, the same kind of boundary
 * payroll/warnAct.ts's own exception-guidance functions draw.
 */

/** DOL Fact Sheet #73: the break-time entitlement runs for this many months after the child's birth. */
export const PUMP_ACT_COVERAGE_MONTHS_AFTER_BIRTH = 12;

/** DOL Fact Sheet #73: an employer below this headcount (counted across ALL worksites, not just one location) may qualify for the undue-hardship exemption — a necessary condition, not by itself sufficient. */
export const PUMP_ACT_SMALL_EMPLOYER_THRESHOLD = 50;

function addMonths(iso: string, months: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1 + months, d));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

export function pumpActCoverageEndDate(childBirthDate: string): string {
  return addMonths(childBirthDate, PUMP_ACT_COVERAGE_MONTHS_AFTER_BIRTH);
}

export function isWithinPumpActCoveragePeriod(childBirthDate: string, asOfDate: string): boolean {
  return asOfDate <= pumpActCoverageEndDate(childBirthDate);
}

/** Necessary-but-not-sufficient half of the small-employer exemption test — the employer must ALSO show undue hardship, a fact-specific judgment this module doesn't evaluate. */
export function mayQualifyForSmallEmployerExemption(totalEmployeeCountAllWorksites: number): boolean {
  return totalEmployeeCountAllWorksites < PUMP_ACT_SMALL_EMPLOYER_THRESHOLD;
}

/**
 * DOL: the employee must either be completely relieved of duty during
 * the break, OR be paid for it — so payment is required whenever they
 * are NOT completely relieved, and is also required (regardless of
 * relief from duty) whenever the break coincides with a break period
 * that's already paid for every other employee (a nursing employee can't
 * be paid LESS than a non-nursing coworker for the same paid rest
 * break).
 */
export function isPumpBreakPaymentRequired(isCompletelyRelievedOfDuty: boolean, coincidesWithAlreadyPaidBreak: boolean): boolean {
  return !isCompletelyRelievedOfDuty || coincidesWithAlreadyPaidBreak;
}

/** DOL: the space must be shielded from view, free from intrusion, and — regardless of how private it is — never a bathroom. */
export function isCompliantPumpingSpace(isBathroom: boolean, isShieldedFromView: boolean, isFreeFromIntrusion: boolean): boolean {
  return !isBathroom && isShieldedFromView && isFreeFromIntrusion;
}
