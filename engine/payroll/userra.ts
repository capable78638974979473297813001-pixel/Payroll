import type { Cents } from '../src/money.ts';

/**
 * USERRA (Uniformed Services Employment and Reemployment Rights Act,
 * 38 U.S.C. § 4301 et seq., 1994) — LIVE-VERIFIED against the
 * Department of Labor's own Veterans' Employment & Training Service
 * (VETS) Fact Sheet #2, not assumed from trained memory:
 *  - https://www.dol.gov/sites/dolgov/files/VETS/files/USERRA-Fact-Sheet-2-FAQs.pdf
 * (fetched 2026-09-13).
 *
 * NO EMPLOYER-SIZE THRESHOLD AT ALL — unlike every other single-
 * jurisdiction module in this project (payroll/cobra.ts's 20-employee
 * floor, payroll/fmla.ts's 50-employee test, payroll/warnAct.ts's
 * 100-employee coverage), USERRA applies to every employer, public or
 * private, regardless of size. There is deliberately no
 * `isUserraCoveredEmployer()` function here — there is nothing to check.
 *
 * SCOPE: the tiered reemployment-application deadline (which depends on
 * how long the service lasted), the 5-year cumulative service limit, and
 * health-plan continuation rights. Deliberately does NOT evaluate the
 * "escalator principle" (a returning service member is reemployed into
 * the position, seniority, and pay they would have ATTAINED had they not
 * been absent — not merely their prior position) or the disability-
 * accommodation duty on return, both fact-specific determinations about
 * what career progression or accommodation would have looked like,
 * not formulas. The 5-year limit's own statutory exceptions (an initial
 * enlistment exceeding 5 years, periodic Guard/Reserve training,
 * war/national-emergency active-duty extensions) are also not evaluated
 * here — `isWithinCumulativeServiceLimit()` takes the caller's own
 * already-adjusted cumulative-service figure (with any excepted time
 * already excluded), the same "count supplied, not derived" boundary
 * payroll/cobra.ts and payroll/warnAct.ts already draw around their own
 * caller-supplied headcounts.
 */

export const USERRA_CUMULATIVE_SERVICE_LIMIT_YEARS = 5;

/** Service under this many days: the service member must report back at the start of the next regularly scheduled work period (not a fixed day count — it accounts for safe travel time plus an 8-hour rest period). */
export const USERRA_IMMEDIATE_RETURN_THRESHOLD_DAYS = 31;

/** Service of 31-180 days: an application for reemployment must be submitted within this many days of release. */
export const USERRA_MEDIUM_SERVICE_APPLICATION_DEADLINE_DAYS = 14;

/** The upper bound (inclusive) of the "medium" service tier — service beyond this many days moves to the 90-day deadline. */
export const USERRA_MEDIUM_SERVICE_MAX_DAYS = 180;

/** Service of more than 180 days: an application for reemployment must be submitted within this many days of release. */
export const USERRA_LONG_SERVICE_APPLICATION_DEADLINE_DAYS = 90;

/** A service member convalescing from a service-incurred or service-aggravated disability has up to this many years from completion of service to report to (or apply for reemployment with) their job. */
export const USERRA_DISABILITY_REPORT_DEADLINE_YEARS = 2;

/** Service of more than 30 days: the service member may elect to continue employer-sponsored health coverage for up to this many months. */
export const USERRA_HEALTH_CONTINUATION_MAX_MONTHS = 24;

/** The maximum percentage of the full premium a service member electing continued health coverage may be required to pay. */
export const USERRA_HEALTH_CONTINUATION_MAX_PREMIUM_FRACTION = 1.02;

export type UserraReemploymentTier = 'immediate_return' | 'medium_service_application' | 'long_service_application';

/** Which reemployment-deadline tier a period of uniformed service falls into, based purely on its duration. */
export function userraReemploymentTier(serviceDurationDays: number): UserraReemploymentTier {
  if (serviceDurationDays < USERRA_IMMEDIATE_RETURN_THRESHOLD_DAYS) return 'immediate_return';
  if (serviceDurationDays <= USERRA_MEDIUM_SERVICE_MAX_DAYS) return 'medium_service_application';
  return 'long_service_application';
}

/** How many days after release the service member has to submit a reemployment application — 0 for the "immediate return" tier, since that tier is governed by the next scheduled work period rather than a day count. */
export function userraApplicationDeadlineDays(serviceDurationDays: number): number {
  const tier = userraReemploymentTier(serviceDurationDays);
  if (tier === 'immediate_return') return 0;
  if (tier === 'medium_service_application') return USERRA_MEDIUM_SERVICE_APPLICATION_DEADLINE_DAYS;
  return USERRA_LONG_SERVICE_APPLICATION_DEADLINE_DAYS;
}

/** True as long as the service member's own cumulative absence for military duty (with any statutory exceptions already excluded by the caller) is at or under the 5-year limit. */
export function isWithinCumulativeServiceLimit(cumulativeServiceYearsExcludingExceptions: number): boolean {
  return cumulativeServiceYearsExcludingExceptions <= USERRA_CUMULATIVE_SERVICE_LIMIT_YEARS;
}

function addYears(iso: string, years: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y + years, m - 1, d));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

export function userraDisabilityReportDeadline(serviceCompletionDate: string): string {
  return addYears(serviceCompletionDate, USERRA_DISABILITY_REPORT_DEADLINE_YEARS);
}

/** For service of 30 days or less, coverage simply continues as if the employee had never been absent — no election is needed. Only service beyond 30 days requires an affirmative election to continue coverage (for up to 24 months, at up to 102% of premium). */
export function isHealthContinuationElectionRequired(serviceDurationDays: number): boolean {
  return serviceDurationDays > 30;
}

export function userraMaxHealthContinuationPremium(fullMonthlyPremiumCents: Cents): Cents {
  return Math.round(fullMonthlyPremiumCents * USERRA_HEALTH_CONTINUATION_MAX_PREMIUM_FRACTION);
}
