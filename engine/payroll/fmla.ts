/**
 * FMLA (Family and Medical Leave Act, 29 U.S.C. § 2601 et seq.)
 * eligibility and leave-entitlement arithmetic. LIVE-VERIFIED against
 * the Department of Labor's own Fact Sheet #28 ("The Family and Medical
 * Leave Act") and its FMLA FAQ — not assumed from trained memory.
 *
 * SCOPE: this module answers the eligibility test and the hours-of-leave
 * arithmetic — the two facts a real leave-of-absence workflow needs to
 * get right, and the two a naive implementation is likeliest to get
 * wrong (all three eligibility prongs must hold at once; only ACTUALLY
 * WORKED hours count toward the 1,250-hour test, not paid leave). It
 * does NOT track an actual leave REQUEST end to end (dates, approval,
 * job-protection status through the leave and back) — a real, separate
 * persistence workflow this project hasn't built yet, the same
 * "disclosed, not built" boundary drawn around EDI 834 and e-filing
 * elsewhere. It also does not model the extended 26-week military
 * caregiver leave entitlement, or the covered-employer worksite-
 * aggregation rule for a company with several small locations within 75
 * miles of each other — both real, separate pieces of FMLA law not
 * researched here.
 *
 * The 50-employees-within-75-miles WORKSITE test is a genuinely
 * different headcount from ACA's own Applicable Large Employer test
 * (payroll/aca.ts) or COBRA's own small-employer exemption
 * (payroll/cobra.ts) — each statute defines "how many employees, counted
 * how" on its own terms, so this module takes its own worksite headcount
 * as an explicit caller-supplied fact rather than reusing either of the
 * other two.
 */

/** DOL Fact Sheet #28: a private-sector employer with at least this many employees in 20+ workweeks of the current or preceding calendar year is a covered employer. */
export const FMLA_COVERED_EMPLOYER_THRESHOLD = 50;

/** DOL Fact Sheet #28: an eligible employee must have worked for the employer at least this many months (not necessarily consecutive). */
export const FMLA_MINIMUM_MONTHS_EMPLOYED = 12;

/** DOL Fact Sheet #28: at least this many hours of SERVICE (actually worked — paid leave doesn't count) in the 12 months immediately before the leave starts. */
export const FMLA_MINIMUM_HOURS_OF_SERVICE = 1250;

/** DOL Fact Sheet #28: the employee's own worksite must have at least this many employees within 75 miles (road/water distance, not straight-line). */
export const FMLA_WORKSITE_EMPLOYEE_THRESHOLD = 50;

/** DOL Fact Sheet #28: up to this many weeks of job-protected leave in a 12-month period, for the standard qualifying reasons (not the extended 26-week military caregiver entitlement, which this module doesn't model). */
export const FMLA_STANDARD_LEAVE_WEEKS = 12;

export interface FmlaEligibilityInput {
  monthsEmployed: number;
  hoursOfServicePastTwelveMonths: number;
  employeeCountAtWorksite: number;
}

export interface FmlaEligibilityResult {
  eligible: boolean;
  /** Empty when eligible; otherwise every prong of the 3-part test that failed, in plain language — never just a bare `false` with no explanation, since each prong is independently actionable (an employer can't fix "not enough tenure," but can decide the request needs to wait, or that a nearby worksite's headcount should be aggregated in, a case this module doesn't attempt on its own). */
  reasons: string[];
}

/**
 * All three prongs must hold — DOL's own eligibility rule is conjunctive,
 * not "any two of three." Never silently treats a missing/zero input as
 * passing: 0 months employed, 0 hours, or 0 coworkers at the worksite
 * are each a real, correct FAIL, not an unset field to ignore.
 */
export function checkFmlaEligibility(input: FmlaEligibilityInput): FmlaEligibilityResult {
  const reasons: string[] = [];
  if (input.monthsEmployed < FMLA_MINIMUM_MONTHS_EMPLOYED) {
    reasons.push(`Fewer than ${FMLA_MINIMUM_MONTHS_EMPLOYED} months employed (has ${input.monthsEmployed}).`);
  }
  if (input.hoursOfServicePastTwelveMonths < FMLA_MINIMUM_HOURS_OF_SERVICE) {
    reasons.push(`Fewer than ${FMLA_MINIMUM_HOURS_OF_SERVICE} hours of service in the preceding 12 months (has ${input.hoursOfServicePastTwelveMonths}).`);
  }
  if (input.employeeCountAtWorksite < FMLA_WORKSITE_EMPLOYEE_THRESHOLD) {
    reasons.push(`Fewer than ${FMLA_WORKSITE_EMPLOYEE_THRESHOLD} employees within 75 miles of this worksite (has ${input.employeeCountAtWorksite}).`);
  }
  return { eligible: reasons.length === 0, reasons };
}

/** An eligible employee's total FMLA leave entitlement in hours, for a 12-month period, given their own regularly scheduled weekly hours — a part-time employee's entitlement is proportionally smaller, never a flat 480 hours (12 weeks x 40) regardless of schedule. */
export function fmlaHoursEntitlement(regularlyScheduledWeeklyHours: number): number {
  return regularlyScheduledWeeklyHours * FMLA_STANDARD_LEAVE_WEEKS;
}

/** Hours still available in the current 12-month period. Never negative — using more than the entitlement is a real employer/leave-administration problem this function surfaces as zero remaining, not a number it lets go negative. */
export function fmlaHoursRemaining(totalEntitlementHours: number, hoursUsedThisPeriod: number): number {
  return Math.max(0, totalEntitlementHours - hoursUsedThisPeriod);
}
