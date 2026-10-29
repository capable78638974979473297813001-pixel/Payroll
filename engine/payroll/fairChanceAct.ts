/**
 * California's Fair Chance Act ("ban the box," Gov. Code § 12952) —
 * LIVE-VERIFIED by reading the Civil Rights Department's own FAQ PDF
 * directly (calcivilrights.ca.gov, fetched 2026-09-14), not assumed from
 * trained memory.
 *
 * ONE STATE ONLY. California is the one jurisdiction this module models
 * explicitly — many other states and cities have their own ban-the-box
 * ordinances with different thresholds and timelines (Los Angeles has
 * its own separate Fair Chance Initiative for Hiring ordinance, distinct
 * from this state law), which remain a disclosed gap, the same "one
 * jurisdiction modeled, the rest named as missing" boundary
 * payroll/paidSickLeave.ts and payroll/workersComp.ts already draw.
 *
 * SCOPE: the deadlines and thresholds this project's own
 * `payroll/onboarding.ts` candidate pipeline would need to gate a
 * conditional offer correctly — the 5-employee coverage test, the
 * 5-business-day (extendable to 10) response window before a preliminary
 * decision to rescind becomes final, and the mailed-notice deemed-
 * received rule. Deliberately does NOT evaluate the INDIVIDUALIZED
 * ASSESSMENT itself (weighing the nature/gravity of the offense, time
 * elapsed, and the nature of the job) — a genuinely fact-specific
 * judgment call about a real person's history and a real job's duties,
 * not a formula, the same kind of scope boundary payroll/warnAct.ts's
 * own exception-guidance functions draw around a legal judgment with no
 * closed-form answer. Also does not gate the criminal-history inquiry
 * itself (whether a question was actually asked before vs. after a
 * conditional offer) — `isCriminalHistoryInquiryPermitted()` only
 * restates the rule as a function of a caller-supplied fact (has a
 * conditional offer been made), since this project has no application-
 * form-content model to check against.
 */

export const FAIR_CHANCE_ACT_EMPLOYER_THRESHOLD = 5;

/** CRD: an applicant gets at least this many BUSINESS days to respond to a preliminary decision to rescind a conditional offer. */
export const FAIR_CHANCE_MIN_RESPONSE_BUSINESS_DAYS = 5;

/** CRD: if the applicant disputes the conviction history report within the original response window, they get this many ADDITIONAL business days beyond it. */
export const FAIR_CHANCE_DISPUTE_EXTENSION_BUSINESS_DAYS = 5;

/** 2 C.C.R. § 11017.01: a mailed notice without delivery confirmation is deemed received this many CALENDAR days after mailing, for a California address. */
export const FAIR_CHANCE_DEEMED_RECEIVED_DAYS_CALIFORNIA = 5;

/** 2 C.C.R. § 11017.01: deemed-received calendar days for a mailing address elsewhere in the United States. */
export const FAIR_CHANCE_DEEMED_RECEIVED_DAYS_OTHER_US = 10;

/** 2 C.C.R. § 11017.01: deemed-received calendar days for a mailing address outside the United States. */
export const FAIR_CHANCE_DEEMED_RECEIVED_DAYS_INTERNATIONAL = 20;

/** CRD: an applicant has this many years from the date of a violation to file a complaint. */
export const FAIR_CHANCE_COMPLAINT_DEADLINE_YEARS = 3;

export type FairChanceMailingAddressType = 'california' | 'other_us' | 'international';

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function addBusinessDays(iso: string, businessDays: number): string {
  let current = iso;
  let added = 0;
  while (added < businessDays) {
    current = addDays(current, 1);
    const [y, m, d] = current.split('-').map(Number);
    const dayOfWeek = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    if (dayOfWeek !== 0 && dayOfWeek !== 6) added++;
  }
  return current;
}

function addYears(iso: string, years: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y + years, m - 1, d));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

export function isFairChanceActCoveredEmployer(employeeCount: number): boolean {
  return employeeCount >= FAIR_CHANCE_ACT_EMPLOYER_THRESHOLD;
}

/** The Fair Chance Act's own timing rule, restated as a function of a caller-supplied fact: criminal history may be inquired about only once a conditional offer has actually been made. */
export function isCriminalHistoryInquiryPermitted(conditionalOfferMade: boolean): boolean {
  return conditionalOfferMade;
}

export function fairChanceResponseDeadline(preliminaryNoticeDate: string): string {
  return addBusinessDays(preliminaryNoticeDate, FAIR_CHANCE_MIN_RESPONSE_BUSINESS_DAYS);
}

/** The extended deadline once the applicant disputes the conviction history report within the original response window — 5 more business days beyond the original deadline, not from the dispute date itself. */
export function fairChanceExtendedResponseDeadline(preliminaryNoticeDate: string): string {
  return addBusinessDays(fairChanceResponseDeadline(preliminaryNoticeDate), FAIR_CHANCE_DISPUTE_EXTENSION_BUSINESS_DAYS);
}

export function fairChanceDeemedReceivedDate(mailedDate: string, addressType: FairChanceMailingAddressType): string {
  const days =
    addressType === 'california'
      ? FAIR_CHANCE_DEEMED_RECEIVED_DAYS_CALIFORNIA
      : addressType === 'other_us'
        ? FAIR_CHANCE_DEEMED_RECEIVED_DAYS_OTHER_US
        : FAIR_CHANCE_DEEMED_RECEIVED_DAYS_INTERNATIONAL;
  return addDays(mailedDate, days);
}

export function fairChanceComplaintDeadline(violationDate: string): string {
  return addYears(violationDate, FAIR_CHANCE_COMPLAINT_DEADLINE_YEARS);
}
