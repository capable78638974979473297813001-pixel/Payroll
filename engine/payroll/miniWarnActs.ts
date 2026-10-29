import type { Cents } from '../src/money.ts';

/**
 * State "mini-WARN" acts — the disclosed gap `payroll/warnAct.ts`'s own
 * header names ("FEDERAL ONLY... every state's own mini-WARN law remains
 * a disclosed gap"). THREE STATES ONLY, deliberately: New York, New
 * Jersey, and California, each live-verified against primary/
 * corroborating sources, fetched 2026-09-14. Every other state's own
 * mini-WARN law (or absence of one) remains a disclosed gap, the same
 * "one jurisdiction modeled, the rest named as missing" boundary
 * `payroll/paidSickLeave.ts` and `payroll/workersComp.ts` already draw.
 *
 * A GENUINE STRUCTURAL DIFFERENCE, not just different numbers: New York
 * (Labor Law Art. 25-A) keeps federal WARN's own TWO-CATEGORY shape — a
 * flat-count "plant closing" threshold and a separate percentage-based
 * "mass layoff" formula (25+ employees AND at least one-third of the
 * site's workforce, OR 250+ regardless of percentage) — just with lower
 * numbers than federal's 50/500. New Jersey (N.J.S.A. 34:21-1 et seq.,
 * as amended 2023) and California (Cal. Lab. Code §§ 1400-1408) instead
 * each use a SINGLE FLAT THRESHOLD with NO percentage test at all —
 * conflating NY's own two-branch formula with either state's simpler
 * one-branch rule would be exactly the mistake `payroll/cobra.ts`'s own
 * header warns against.
 *
 * NEW JERSEY'S OWN EMPLOYER-SIZE TEST IS ALSO STRUCTURALLY DIFFERENT
 * FROM THE OTHER TWO: it counts every employee NATIONWIDE (any status,
 * full-time or part-time), not just employees at the New Jersey site or
 * in the state — the broadest counting rule of the three. New Jersey is
 * also the only one of the three requiring MANDATORY SEVERANCE PAY (one
 * week per year of service, owed regardless of whether adequate notice
 * was given, per the 2023 amendments), with an additional flat penalty
 * if notice was inadequate — a wage obligation neither NY's nor CA's own
 * mini-WARN law imposes at all.
 *
 * SCOPE: same "counts supplied, not derived" boundary
 * `payroll/warnAct.ts`'s own header draws — every headcount here is a
 * caller-supplied parameter, since this project has no notion of a
 * "layoff event" spanning multiple employees. Does not model any of the
 * three states' own statutory exceptions (each state has its own
 * version of federal WARN's faltering-company/unforeseeable-
 * circumstances/natural-disaster categories) — the same fact-specific,
 * no-formula scope boundary `payroll/warnAct.ts`'s own
 * `warnExceptionGuidance()` already draws for the federal statute. Does
 * not model California's own SB 617 (2026) notice-content requirements
 * (workforce board coordination, CalFresh information) — a document-
 * content question, not a threshold or dollar calculation.
 */

export type MiniWarnState = 'NY' | 'NJ' | 'CA';

/** NY Labor Law Art. 25-A: covers employers with this many full-time employees in New York. */
export const NY_WARN_EMPLOYER_THRESHOLD = 50;

/** NY: a "plant closing" is a loss of employment, at a single site within 30 days, for at least this many full-time employees — no percentage test. */
export const NY_WARN_PLANT_CLOSING_MINIMUM_EMPLOYEES = 25;

/** NY: the smaller mass-layoff branch requires at least this many affected full-time employees... */
export const NY_WARN_MASS_LAYOFF_MINIMUM_EMPLOYEES = 25;

/** ...AND at least this fraction of the site's active full-time workforce (one-third) — mirrors federal WARN's own two-part formula, just at half federal's numbers. */
export const NY_WARN_MASS_LAYOFF_MINIMUM_FRACTION_OF_WORKFORCE = 1 / 3;

/** NY: the larger mass-layoff branch — at or above this many affected employees triggers coverage regardless of workforce percentage. */
export const NY_WARN_MASS_LAYOFF_LARGE_THRESHOLD = 250;

/** NY: required advance written notice, 30 days longer than federal WARN's 60. */
export const NY_WARN_NOTICE_PERIOD_DAYS = 90;

/** NJ N.J.S.A. 34:21-2: covers employers with this many employees NATIONWIDE (any status, full-time or part-time) — the broadest counting rule of the three states modeled here. */
export const NJ_WARN_EMPLOYER_THRESHOLD = 100;

/** NJ: a SINGLE flat threshold triggers coverage — this many employees affected at or reporting to any New Jersey establishment, with NO percentage-of-workforce test at all. */
export const NJ_WARN_TRIGGER_MINIMUM_EMPLOYEES = 50;

export const NJ_WARN_NOTICE_PERIOD_DAYS = 90;

/** NJ 2023 amendments: mandatory severance owed to every affected employee, one week's pay per full year of service — owed regardless of whether adequate notice was given. */
export const NJ_WARN_SEVERANCE_WEEKS_PER_YEAR_OF_SERVICE = 1;

/** NJ: an ADDITIONAL flat severance penalty, on top of the base severance above, when the required 90-day notice was not given in full. */
export const NJ_WARN_INADEQUATE_NOTICE_PENALTY_WEEKS = 4;

/** CA Lab. Code § 1400: covers any commercial/industrial employer with this many full- and part-time employees, counted over the preceding 12 months. */
export const CA_WARN_EMPLOYER_THRESHOLD = 75;

/** CA: a SINGLE flat threshold triggers coverage for a mass layoff or covered-establishment termination — this many employees affected, with NO percentage-of-workforce test, the same simpler shape as New Jersey's own rule. */
export const CA_WARN_TRIGGER_MINIMUM_EMPLOYEES = 50;

/** CA: a relocation of operations this many miles or more away also triggers coverage, independent of the headcount trigger. */
export const CA_WARN_RELOCATION_DISTANCE_MILES = 100;

export const CA_WARN_NOTICE_PERIOD_DAYS = 60;

export function miniWarnNoticePeriodDays(state: MiniWarnState): number {
  switch (state) {
    case 'NY':
      return NY_WARN_NOTICE_PERIOD_DAYS;
    case 'NJ':
      return NJ_WARN_NOTICE_PERIOD_DAYS;
    case 'CA':
      return CA_WARN_NOTICE_PERIOD_DAYS;
  }
}

/** NY Labor Law Art. 25-A: true once the employer's own New York full-time headcount reaches the threshold. */
export function isNyWarnCoveredEmployer(fullTimeEmployeesInNewYork: number): boolean {
  return fullTimeEmployeesInNewYork >= NY_WARN_EMPLOYER_THRESHOLD;
}

/** NY: true when the number of full-time employees losing employment at a single site within 30 days meets the flat plant-closing floor. */
export function isNyPlantClosing(employeesLosingEmploymentFullTime: number): boolean {
  return employeesLosingEmploymentFullTime >= NY_WARN_PLANT_CLOSING_MINIMUM_EMPLOYEES;
}

/** NY: true when a reduction in force meets either mass-layoff branch — 250+ outright, or 25+ AND at least one-third of the site's active full-time workforce. */
export function isNyMassLayoff(employeesLosingEmploymentFullTime: number, activeWorkforceAtSiteBeforeLayoff: number): boolean {
  if (employeesLosingEmploymentFullTime >= NY_WARN_MASS_LAYOFF_LARGE_THRESHOLD) return true;
  if (employeesLosingEmploymentFullTime < NY_WARN_MASS_LAYOFF_MINIMUM_EMPLOYEES) return false;
  if (activeWorkforceAtSiteBeforeLayoff <= 0) return false;
  return employeesLosingEmploymentFullTime / activeWorkforceAtSiteBeforeLayoff >= NY_WARN_MASS_LAYOFF_MINIMUM_FRACTION_OF_WORKFORCE;
}

/** NJ: true once the employer's own NATIONWIDE headcount (any status) reaches the threshold — the broadest counting rule of the three states modeled here. */
export function isNjWarnCoveredEmployer(totalEmployeesNationwide: number): boolean {
  return totalEmployeesNationwide >= NJ_WARN_EMPLOYER_THRESHOLD;
}

/** NJ: true when employees affected at or reporting to a New Jersey establishment meet the flat trigger — no percentage test, unlike NY's own formula. */
export function isNjWarnTriggered(employeesAffectedAtNjEstablishment: number): boolean {
  return employeesAffectedAtNjEstablishment >= NJ_WARN_TRIGGER_MINIMUM_EMPLOYEES;
}

/** NJ: the mandatory base severance owed to one affected employee — one week's pay per FULL year of service, owed regardless of whether adequate notice was given. */
export function njMandatorySeverance(fullYearsOfService: number, weeklyPayCents: Cents): Cents {
  if (fullYearsOfService <= 0) return 0;
  return Math.floor(fullYearsOfService) * NJ_WARN_SEVERANCE_WEEKS_PER_YEAR_OF_SERVICE * weeklyPayCents;
}

/**
 * NJ: the total severance owed to one affected employee, including the
 * additional flat penalty when the required 90-day notice was not given
 * in full — the base severance is owed either way; the penalty is
 * additive, not a replacement for it.
 */
export function njTotalSeveranceOwed(fullYearsOfService: number, weeklyPayCents: Cents, noticeWasAdequate: boolean): Cents {
  const base = njMandatorySeverance(fullYearsOfService, weeklyPayCents);
  const penalty = noticeWasAdequate ? 0 : NJ_WARN_INADEQUATE_NOTICE_PENALTY_WEEKS * weeklyPayCents;
  return base + penalty;
}

/** CA: true once the employer's own combined full- and part-time headcount (12-month lookback, supplied by caller) reaches the threshold. */
export function isCaWarnCoveredEmployer(employeesPastTwelveMonths: number): boolean {
  return employeesPastTwelveMonths >= CA_WARN_EMPLOYER_THRESHOLD;
}

/** CA: true when employees affected by a mass layoff or covered-establishment termination meet the flat trigger — no percentage test, the same simpler shape as New Jersey's own rule. */
export function isCaWarnTriggered(employeesAffected: number): boolean {
  return employeesAffected >= CA_WARN_TRIGGER_MINIMUM_EMPLOYEES;
}

/** CA: true when a relocation of operations meets the independent 100-mile distance trigger, regardless of headcount. */
export function isCaWarnRelocationTriggered(relocationDistanceMiles: number): boolean {
  return relocationDistanceMiles >= CA_WARN_RELOCATION_DISTANCE_MILES;
}

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

/** The latest date written notice must be served for a covered action planned for this date, under the given state's own notice period. */
export function miniWarnNoticeDeadline(state: MiniWarnState, plannedActionDate: string): string {
  return addDays(plannedActionDate, -miniWarnNoticePeriodDays(state));
}

/** True when notice was NOT served by the state's own deadline for the planned action date. */
export function isMiniWarnNoticeLate(state: MiniWarnState, noticeServedDate: string, plannedActionDate: string): boolean {
  return noticeServedDate > miniWarnNoticeDeadline(state, plannedActionDate);
}
