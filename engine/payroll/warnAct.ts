/**
 * Federal WARN Act (Worker Adjustment and Retraining Notification Act,
 * 29 U.S.C. § 2101 et seq.) — LIVE-VERIFIED against the statutory text
 * itself (law.cornell.edu/uscode/text/29/2101 and .../2102, fetched
 * 2026-09-13), not assumed from trained memory.
 *
 * SCOPE: pure eligibility/threshold math over caller-supplied headcounts
 * and dates — this project has no notion of a "layoff event" spanning
 * multiple employees (payroll/termination.ts processes one employee at a
 * time), so every count here (site headcount, employees losing
 * employment, part-time status) is a parameter the caller supplies,
 * the same "count supplied, not derived" boundary payroll/cobra.ts draws
 * around its own COBRA headcount input.
 *
 * DISCLOSED GAPS:
 *  - The three statutory exceptions (faltering company, unforeseeable
 *    business circumstances, natural disaster) don't eliminate notice —
 *    they require "as much notice as is practicable" plus a statement of
 *    reasons, a case-specific legal judgment the statute itself doesn't
 *    reduce to a formula. isWarnExceptionApplicable() only flags that an
 *    exception CATEGORY may apply; it does not compute a shortened
 *    notice period, since none exists in the statute to compute.
 *  - FEDERAL ONLY. Many states run their own "mini-WARN" acts with
 *    stricter thresholds (this project's own
 *    data/employer-thresholds/NY-2026.json already names New York's own
 *    50-employee/90-day-notice floor as a separate, out-of-band figure) —
 *    every state's own mini-WARN law remains a disclosed gap, the same
 *    "one jurisdiction modeled, the rest named as missing" boundary
 *    payroll/paidSickLeave.ts and payroll/workersComp.ts already draw.
 */

/** 29 U.S.C. § 2101(a)(1): an employer is covered once it has this many employees, EXCLUDING part-time employees (see isPartTimeForWarnPurposes below). */
export const WARN_EMPLOYER_THRESHOLD = 100;

/** § 2101(a)(8): an employee averaging fewer than this many hours/week is "part-time" and excluded from every count this module uses. */
export const WARN_PART_TIME_HOURS_PER_WEEK_THRESHOLD = 20;

/** § 2101(a)(8): an employee employed fewer than this many of the preceding 12 months is also "part-time" and excluded, regardless of hours. */
export const WARN_PART_TIME_TENURE_MONTHS_THRESHOLD = 6;

/** § 2101(a)(2): a "plant closing" is a shutdown resulting in employment loss, at a single site within any 30-day period, for at least this many employees (excluding part-time). */
export const WARN_PLANT_CLOSING_MINIMUM_EMPLOYEES = 50;

/** § 2101(a)(3)(B)(i): the SMALLER mass-layoff branch requires at least this many affected employees... */
export const WARN_MASS_LAYOFF_MINIMUM_EMPLOYEES = 50;

/** ...AND at least this fraction of the site's active workforce (one-third) — both conditions must hold for the smaller branch. */
export const WARN_MASS_LAYOFF_MINIMUM_FRACTION_OF_WORKFORCE = 1 / 3;

/** § 2101(a)(3)(B)(ii): the LARGER mass-layoff branch — at or above this many affected employees triggers WARN regardless of what fraction of the workforce that represents. */
export const WARN_MASS_LAYOFF_LARGE_THRESHOLD = 500;

/** § 2102(a): the required advance written notice period. */
export const WARN_NOTICE_PERIOD_DAYS = 60;

/** § 2102(d): smaller employment-loss groups at the same site, each below the plant-closing/mass-layoff minimum, are aggregated if they occur within this many days of each other and, combined, meet the minimum — unless the employer proves they're separate and distinct actions (a fact-specific defense this module doesn't evaluate). */
export const WARN_AGGREGATION_WINDOW_DAYS = 90;

export type WarnExceptionReason = 'faltering_company' | 'unforeseeable_business_circumstances' | 'natural_disaster';

/** § 2102(b): only the natural-disaster exception eliminates the notice requirement outright — the other two still require notice "as soon as practicable" with a statement of the basis for reducing the period, which this module doesn't attempt to quantify (the statute itself sets no formula for it). */
export function isWarnNoticeRequirementEliminated(reason: WarnExceptionReason): boolean {
  return reason === 'natural_disaster';
}

/** Plain-language statutory basis for each exception, for display alongside a flagged event — not a substitute for counsel's own fact-specific determination of whether it actually applies. */
export function warnExceptionGuidance(reason: WarnExceptionReason): string {
  switch (reason) {
    case 'faltering_company':
      return 'Applies only to a PLANT CLOSING (not a mass layoff): the employer was actively seeking capital or business that, if obtained, would have avoided or postponed the closing, and reasonably believed giving notice would have prevented obtaining it. Still requires notice as soon as practicable.';
    case 'unforeseeable_business_circumstances':
      return 'Applies when the closing or mass layoff was caused by business circumstances not reasonably foreseeable at the time notice would otherwise have been required. Still requires notice as soon as practicable.';
    case 'natural_disaster':
      return 'No notice is required at all when the closing or mass layoff is due to a natural disaster (flood, earthquake, drought, etc.).';
  }
}

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function daysBetween(isoA: string, isoB: string): number {
  const [ya, ma, da] = isoA.split('-').map(Number);
  const [yb, mb, db] = isoB.split('-').map(Number);
  const utcA = Date.UTC(ya, ma - 1, da);
  const utcB = Date.UTC(yb, mb - 1, db);
  return Math.round(Math.abs(utcB - utcA) / (24 * 60 * 60 * 1000));
}

/** § 2101(a)(8): true if this employee counts as "part-time" and is therefore excluded from every WARN headcount. */
export function isPartTimeForWarnPurposes(averageHoursPerWeek: number, monthsEmployedInPastTwelve: number): boolean {
  return averageHoursPerWeek < WARN_PART_TIME_HOURS_PER_WEEK_THRESHOLD || monthsEmployedInPastTwelve < WARN_PART_TIME_TENURE_MONTHS_THRESHOLD;
}

/** § 2101(a)(1): true once the employer's own full-time-equivalent count (already excluding part-time employees per the caller) reaches the threshold. */
export function isWarnCoveredEmployer(employeeCountExcludingPartTime: number): boolean {
  return employeeCountExcludingPartTime >= WARN_EMPLOYER_THRESHOLD;
}

/** § 2101(a)(2): true when the number of employees losing employment at a single site (excluding part-time) within any 30-day period meets the plant-closing floor. */
export function isPlantClosing(employeesLosingEmploymentExcludingPartTime: number): boolean {
  return employeesLosingEmploymentExcludingPartTime >= WARN_PLANT_CLOSING_MINIMUM_EMPLOYEES;
}

/**
 * § 2101(a)(3): true when a reduction in force (that is NOT itself a
 * plant closing) meets either mass-layoff branch — 500+ affected
 * employees outright, or 50+ AND at least one-third of the site's active
 * workforce immediately before the layoff.
 */
export function isMassLayoff(employeesLosingEmploymentExcludingPartTime: number, activeWorkforceAtSiteBeforeLayoff: number): boolean {
  if (employeesLosingEmploymentExcludingPartTime >= WARN_MASS_LAYOFF_LARGE_THRESHOLD) return true;
  if (employeesLosingEmploymentExcludingPartTime < WARN_MASS_LAYOFF_MINIMUM_EMPLOYEES) return false;
  if (activeWorkforceAtSiteBeforeLayoff <= 0) return false;
  return employeesLosingEmploymentExcludingPartTime / activeWorkforceAtSiteBeforeLayoff >= WARN_MASS_LAYOFF_MINIMUM_FRACTION_OF_WORKFORCE;
}

/** § 2102(a): the latest date written notice must be served for a plant closing/mass layoff planned for this date. */
export function warnNoticeDeadline(plannedActionDate: string): string {
  return addDays(plannedActionDate, -WARN_NOTICE_PERIOD_DAYS);
}

/** True once the planned action date is on or before today plus the required notice period has already elapsed since noticeServedDate — i.e. notice was NOT served in time. */
export function isWarnNoticeLate(noticeServedDate: string, plannedActionDate: string): boolean {
  return noticeServedDate > warnNoticeDeadline(plannedActionDate);
}

/** § 2102(d): true when two employment-loss events at the same site fall within the aggregation window and should be combined toward the plant-closing/mass-layoff minimums, absent the employer proving they're separate and distinct actions. */
export function areWithinWarnAggregationWindow(eventDateA: string, eventDateB: string): boolean {
  return daysBetween(eventDateA, eventDateB) <= WARN_AGGREGATION_WINDOW_DAYS;
}
