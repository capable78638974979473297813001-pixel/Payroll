/**
 * California bereavement leave (AB 1949, Government Code § 12945.7,
 * effective January 1, 2023) — LIVE-VERIFIED against the bill's own
 * statutory text (leginfo.legislature.ca.gov, fetched 2026-09-13), not
 * assumed from trained memory.
 *
 * ONE STATE ONLY. California is the one jurisdiction this module models
 * explicitly — several other states (Illinois, Oregon, Maryland, and
 * others) have their own bereavement-leave mandates with different
 * thresholds and covered relationships, which remain a disclosed gap,
 * the same "one jurisdiction modeled, the rest named as missing"
 * boundary payroll/paidSickLeave.ts and payroll/workersComp.ts already
 * draw.
 *
 * SCOPE: pure eligibility/deadline/pay-allocation math over caller-
 * supplied headcount, tenure, dates, and an employer's own existing paid-
 * leave policy — this project has no "bereavement leave request" workflow
 * (unlike payroll/ptoRequest.ts's own PTO request/approval state machine),
 * so a real end-to-end request/approval flow for this leave type remains
 * a separate, unbuilt feature, the same category of gap
 * payroll/fmla.ts's own header discloses for FMLA leave requests.
 */

export type CaBereavementCoveredRelationship = 'spouse' | 'child' | 'parent' | 'sibling' | 'grandparent' | 'grandchild' | 'domestic_partner' | 'parent_in_law';

/** Gov. Code § 12945.7(a): covers employers with this many employees or more. */
export const CA_BEREAVEMENT_LEAVE_EMPLOYER_THRESHOLD = 5;

/** § 12945.7(a): an employee must have been employed this many days before the leave begins. */
export const CA_BEREAVEMENT_LEAVE_MIN_TENURE_DAYS = 30;

/** § 12945.7(a): up to this many days of leave per qualifying death. */
export const CA_BEREAVEMENT_LEAVE_DAYS = 5;

/** § 12945.7(a): the leave (which need not be taken consecutively) must be completed within this many months of the date of death. */
export const CA_BEREAVEMENT_LEAVE_COMPLETION_WINDOW_MONTHS = 3;

/** § 12945.7: the employer's own window, from the first day of leave, to request documentation (a death certificate, published obituary, or written verification of death/burial/memorial services). */
export const CA_BEREAVEMENT_DOCUMENTATION_REQUEST_WINDOW_DAYS = 30;

function addMonths(iso: string, months: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1 + months, d));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

export function isCaBereavementLeaveEmployerCovered(employeeCount: number): boolean {
  return employeeCount >= CA_BEREAVEMENT_LEAVE_EMPLOYER_THRESHOLD;
}

export function isCaBereavementLeaveEligible(daysEmployedBeforeLeaveStarts: number): boolean {
  return daysEmployedBeforeLeaveStarts >= CA_BEREAVEMENT_LEAVE_MIN_TENURE_DAYS;
}

export function caBereavementLeaveCompletionDeadline(dateOfDeath: string): string {
  return addMonths(dateOfDeath, CA_BEREAVEMENT_LEAVE_COMPLETION_WINDOW_MONTHS);
}

export function isCaBereavementLeaveTimely(dateOfDeath: string, leaveDate: string): boolean {
  return leaveDate <= caBereavementLeaveCompletionDeadline(dateOfDeath);
}

export function caBereavementDocumentationRequestDeadline(leaveStartDate: string): string {
  return addDays(leaveStartDate, CA_BEREAVEMENT_DOCUMENTATION_REQUEST_WINDOW_DAYS);
}

/**
 * The statute doesn't require PAID leave on its own — it requires 5 days
 * of leave, PAID to whatever extent the employer's own existing
 * bereavement/PTO policy already pays for it, with the remainder
 * (if any) unpaid. An employer with no paid policy at all owes 5 unpaid
 * days; one whose policy already pays all 5 owes no unpaid days.
 */
export function caBereavementLeavePaidDays(existingPolicyPaidDays: number): number {
  return Math.min(Math.max(0, existingPolicyPaidDays), CA_BEREAVEMENT_LEAVE_DAYS);
}

export function caBereavementLeaveUnpaidDays(existingPolicyPaidDays: number): number {
  return CA_BEREAVEMENT_LEAVE_DAYS - caBereavementLeavePaidDays(existingPolicyPaidDays);
}
