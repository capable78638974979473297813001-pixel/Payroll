import type { Employee } from './types.ts';

/**
 * Form I-9 employment eligibility verification (Immigration Reform and
 * Control Act, 8 U.S.C. § 1324a) — the one compliance step required for
 * EVERY US hire regardless of state, unlike payroll/newHireReporting.ts's
 * state-reported new-hire filing. Two deadlines, both fixed by federal
 * regulation, not researched per state the way this project's other
 * deadline modules are:
 *
 *   Section 1 (employee's own attestation): no later than the first day
 *   of employment — may be completed any time after accepting the offer,
 *   but never later.
 *
 *   Section 2 (employer's review of documents): within 3 BUSINESS days of
 *   the first day of employment, EXCEPT when the job itself will last
 *   fewer than 3 business days, in which case Section 2 is due on the
 *   first day too (there's no multi-day window to complete it within if
 *   the job doesn't last that long).
 *
 * SCOPE: this tracks the two deadlines and the record-retention date —
 * not document verification itself (this project has no way to judge
 * whether a photocopy of a passport is genuine), not E-Verify, and not
 * reverification of an expiring work authorization document. Those are
 * real, separate pieces of an I-9 compliance subsystem, not modelled here.
 */

/** Adds business days (Mon-Fri only — this project doesn't model a federal holiday calendar, the same simplification payroll/schedule.ts's own header comment makes for check dates). */
function addBusinessDays(iso: string, businessDays: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  let date = new Date(Date.UTC(y, m - 1, d));
  let remaining = businessDays;
  while (remaining > 0) {
    date = new Date(date.getTime() + 86_400_000);
    const dayOfWeek = date.getUTCDay(); // 0 = Sunday, 6 = Saturday
    if (dayOfWeek !== 0 && dayOfWeek !== 6) remaining--;
  }
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function businessDaysBetween(startIso: string, endIso: string): number {
  let count = 0;
  let cursor = startIso;
  while (cursor < endIso) {
    cursor = addBusinessDays(cursor, 1);
    count++;
  }
  return count;
}

export interface I9Deadlines {
  section1DueBy: string;
  section2DueBy: string;
  /** True when Section 2's deadline was pulled in to the first day of employment because the job itself won't last 3 business days — see this module's own header comment. */
  shortTermException: boolean;
}

/**
 * `expectedLastDayOfWork` is optional: most hires have no known end date,
 * and the ordinary 3-business-day rule applies. Only pass it when the
 * job is genuinely known to be short (a seasonal or temporary hire) —
 * fabricating an end date to game the deadline the other direction would
 * be exactly the kind of guessed input this project's own conventions
 * refuse to allow elsewhere (see src/types.ts's own "never invented"
 * discipline for eligibility facts).
 */
export function i9Deadlines(hireDate: string, expectedLastDayOfWork?: string): I9Deadlines {
  const ordinarySection2Deadline = addBusinessDays(hireDate, 3);
  const shortTermException = expectedLastDayOfWork !== undefined && businessDaysBetween(hireDate, expectedLastDayOfWork) < 3;

  return {
    section1DueBy: hireDate,
    section2DueBy: shortTermException ? hireDate : ordinarySection2Deadline,
    shortTermException,
  };
}

/** The earliest date a completed I-9 may be discarded: the LATER of 3 years after hire, or 1 year after termination — never the earlier, and never a fixed "3 years" alone once someone has actually left, since a short tenure can push the 1-year-after-termination date past the 3-year-from-hire one. */
export function i9RetentionDueDate(hireDate: string, terminationDate?: string): string {
  const threeYearsAfterHire = addYears(hireDate, 3);
  if (!terminationDate) return threeYearsAfterHire;
  const oneYearAfterTermination = addYears(terminationDate, 1);
  return oneYearAfterTermination > threeYearsAfterHire ? oneYearAfterTermination : threeYearsAfterHire;
}

/** Uses Date's own month/day normalization rather than string concatenation — a Feb 29 hire date + 3 years (landing on a non-leap year) correctly rolls to March 1 instead of producing the invalid date string "...-02-29". */
function addYears(iso: string, years: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y + years, m - 1, d));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

export type I9Status = 'section1_pending' | 'section2_pending' | 'complete';

export interface I9Record {
  employeeId: string;
  section1CompletedAt?: string;
  section2CompletedAt?: string;
}

export function i9Status(record: I9Record): I9Status {
  if (!record.section1CompletedAt) return 'section1_pending';
  if (!record.section2CompletedAt) return 'section2_pending';
  return 'complete';
}

/** Every deadline this employee has already missed, as of `asOfDate` — a real compliance finding an admin needs to see, not a silent gap. Matches payroll/compliance.ts's own "surface it as a finding, never block or guess" convention. */
export function i9ComplianceIssues(employee: Employee, record: I9Record | undefined, asOfDate: string): string[] {
  const deadlines = i9Deadlines(employee.hireDate);
  const issues: string[] = [];
  const status = i9Status(record ?? { employeeId: employee.id });

  if (status === 'section1_pending' && asOfDate > deadlines.section1DueBy) {
    issues.push(`Section 1 was due by ${deadlines.section1DueBy} and is still not on file.`);
  }
  if (status !== 'complete' && asOfDate > deadlines.section2DueBy) {
    issues.push(`Section 2 was due by ${deadlines.section2DueBy} and is still not on file.`);
  }
  return issues;
}
