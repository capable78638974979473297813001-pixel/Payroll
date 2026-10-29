import type { Cents } from '../src/money.ts';
import { dollars } from '../src/money.ts';

/**
 * Colorado's Equal Pay for Equal Work Act, Part 2 — "Transparency in Pay
 * and Opportunities for Promotion and Advancement" (C.R.S. §§ 8-5-201 to
 * 8-5-203) — LIVE-VERIFIED against the statute's own text and CDLE
 * guidance (corroborated across multiple independent sources since the
 * CDLE site itself blocked automated fetches), fetched 2026-09-14.
 *
 * A third pay-transparency module alongside `payroll/salaryHistoryBan.ts`
 * (California) and `payroll/nyPayTransparency.ts` (New York) — again
 * deliberately its own module rather than a shared abstraction, since
 * Colorado's law is structured differently from both: it has NO
 * employer-size threshold at all for either the job-posting compensation
 * disclosure or the promotional-opportunity notice duty (unlike
 * California's 15-employee floor for job postings, or New York's
 * 4-employee floor for everything) — ANY employer with a job opening
 * performed at least partly in Colorado is covered. The one carve-out
 * Colorado's statute does provide is not size-based but a temporary,
 * physical-presence-based exception: through July 1, 2029, an employer
 * with no physical location in Colorado and fewer than 15 Colorado
 * employees, all of them fully remote, need only notify those employees
 * of REMOTE job openings, not every opening company-wide (the job-posting
 * compensation-disclosure duty itself still applies in full even to that
 * exempted employer). Conflating this temporal/remote-workforce carve-out
 * with the OTHER two statutes' own size thresholds would be exactly the
 * mistake `payroll/cobra.ts`'s own header warns against.
 *
 * SCOPE: coverage of the promotional-notice carve-out, the penalty range,
 * and the one-year complaint deadline. Does not evaluate whether a
 * disclosed compensation range is the range the employer genuinely
 * expects to pay (a fact-specific "good faith" judgment, not a formula —
 * the same kind of scope boundary `payroll/warnAct.ts`'s own exception
 * guidance draws), and does not model Part 1's separate equal-pay-for-
 * equal-work wage discrimination claims (C.R.S. §§ 8-5-101 to 8-5-106),
 * which are a distinct statutory scheme from this Part 2 transparency
 * regime.
 */

export const CO_EPEWA_PENALTY_MIN: Cents = dollars(500);
export const CO_EPEWA_PENALTY_MAX: Cents = dollars(10_000);

/** C.R.S. § 8-5-203(1): an aggrieved person has this many years from learning of a violation to file a written complaint with the director. */
export const CO_EPEWA_COMPLAINT_DEADLINE_YEARS = 1;

/** The remote-workforce notice carve-out applies only below this many Colorado employees. */
export const CO_EPEWA_REMOTE_EXCEPTION_EMPLOYEE_THRESHOLD = 15;

/** The remote-workforce notice carve-out itself sunsets on this date; from then on every employer owes full company-wide promotional notice regardless of physical presence or remote workforce size. */
export const CO_EPEWA_REMOTE_EXCEPTION_SUNSET_DATE = '2029-07-01';

export type CoPromotionalNoticeScope = 'all_openings' | 'remote_openings_only';

export interface CoPromotionalNoticeScopeInput {
  employerPhysicallyLocatedInColorado: boolean;
  coloradoEmployeeCount: number;
  allColoradoEmployeesFullyRemote: boolean;
  /** ISO date (YYYY-MM-DD) of the promotion decision, checked against the carve-out's own sunset date. */
  decisionDate: string;
}

/**
 * C.R.S. § 8-5-201(1) as narrowed by the temporary out-of-state-employer
 * exception: an employer with no Colorado location, fewer than 15
 * Colorado employees, all fully remote, owes notice only for remote
 * openings until the carve-out sunsets — every other employer, and every
 * employer once the sunset date passes, owes notice of ALL openings.
 */
export function coPromotionalNoticeScope(input: CoPromotionalNoticeScopeInput): CoPromotionalNoticeScope {
  const carveOutStillInEffect = input.decisionDate < CO_EPEWA_REMOTE_EXCEPTION_SUNSET_DATE;
  const qualifiesForCarveOut =
    !input.employerPhysicallyLocatedInColorado &&
    input.coloradoEmployeeCount < CO_EPEWA_REMOTE_EXCEPTION_EMPLOYEE_THRESHOLD &&
    input.allColoradoEmployeesFullyRemote;
  return carveOutStillInEffect && qualifiesForCarveOut ? 'remote_openings_only' : 'all_openings';
}

function addYears(iso: string, years: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y + years, m - 1, d));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

/** C.R.S. § 8-5-203(1): the last date a written complaint may be filed, one year after the person learned of the violation. */
export function coEpewaComplaintDeadline(dateLearnedOfViolation: string): string {
  return addYears(dateLearnedOfViolation, CO_EPEWA_COMPLAINT_DEADLINE_YEARS);
}

/** C.R.S. § 8-5-203(2): clamps a considered per-violation fine into the statute's own $500-$10,000 range. */
export function clampCoEpewaPenalty(consideredPenaltyCents: Cents): Cents {
  return Math.min(Math.max(consideredPenaltyCents, CO_EPEWA_PENALTY_MIN), CO_EPEWA_PENALTY_MAX);
}

/** Each non-compliant posting or missing notification is its own violation under the statute — this simply sums independently-clamped per-violation fines rather than clamping the total, since the range is explicitly "per violation." */
export function coEpewaTotalPenalty(consideredPerViolationPenaltiesCents: Cents[]): Cents {
  return consideredPerViolationPenaltiesCents.reduce((total, penalty) => total + clampCoEpewaPenalty(penalty), 0);
}
