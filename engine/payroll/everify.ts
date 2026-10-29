import type { Employee } from './types.ts';

/**
 * E-Verify case tracking — the electronic employment-authorization check
 * this project's own payroll/i9.ts explicitly names as NOT modeled in its
 * header comment ("this project has no way to judge whether a photocopy
 * of a passport is genuine... not E-Verify"). LIVE-VERIFIED against
 * USCIS's own I-9 Central guidance and E-Verify's own published
 * deadlines, not assumed from trained memory.
 *
 * SCOPE, disclosed rather than guessed at: this module tracks case
 * STATUS and the two deadlines that bind every participating employer
 * (case creation, and acting on a Tentative Nonconfirmation) — it does
 * NOT determine whether an employer is even REQUIRED to use E-Verify in
 * the first place. That determination is genuinely a per-state, per-
 * employer-size, sometimes per-industry legal question (roughly a dozen
 * states mandate it for some or all private employers, above varying
 * headcount thresholds; several more mandate it only for public
 * employers or government contractors; federal contractors have their
 * own separate FAR-based mandate) — a legal-research project of the same
 * shape and size as this project's own minimum-wage database, not
 * something to force-fit here. The same "disclosed, not guessed" choice
 * `payroll/newHireReporting.ts`'s own `deadlineDaysForState()` makes for
 * per-state reporting deadlines it hasn't researched.
 *
 * Also does NOT integrate with the actual E-Verify system (case
 * submission, photo matching, the real API) — a real, separate
 * integration, the same "disclosed, not built" boundary this project
 * draws around e-filing and carrier EDI elsewhere. `caseNumber` on
 * `EverifyCase` is exactly as far as this project's own tracking goes:
 * a plain reference to whatever case number a human obtained by actually
 * using the real E-Verify system.
 */

export type EverifyCaseStatus =
  | 'not_created'
  | 'pending'
  | 'employment_authorized'
  | 'tentative_nonconfirmation'
  | 'final_nonconfirmation'
  | 'closed';

export interface EverifyCase {
  employeeId: string;
  caseNumber?: string;
  status: EverifyCaseStatus;
  createdAt?: string;
  /** Set only when status is 'tentative_nonconfirmation' — the date E-Verify itself issued the TNC result, which is what the employer's own referral deadline counts from. */
  tncIssuedAt?: string;
}

/** USCIS/E-Verify: a case must be created within this many business days of the hire date — the same window as I-9 Section 2, though a legally distinct requirement enforced by a different process, not derived from payroll/i9.ts's own deadline. */
export const CASE_CREATION_DEADLINE_BUSINESS_DAYS = 3;

/** USCIS: once E-Verify issues a Tentative Nonconfirmation, the employer must refer the case within this many federal-government working days. This module approximates "federal government working days" as ordinary Mon-Fri business days (no federal holiday calendar) — the same disclosed simplification payroll/i9.ts's own business-day counter carries. */
export const TNC_REFERRAL_DEADLINE_BUSINESS_DAYS = 10;

/** USCIS: after a case is referred, the EMPLOYEE (not the employer) has this many additional federal working days to contact DHS or visit an SSA office to contest the TNC — tracked here for informational display only, since it's the employee's own deadline, not an employer compliance obligation this module treats as a finding. */
export const EMPLOYEE_CONTEST_DEADLINE_BUSINESS_DAYS = 8;

function addBusinessDays(iso: string, businessDays: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  let date = new Date(Date.UTC(y, m - 1, d));
  let remaining = businessDays;
  while (remaining > 0) {
    date = new Date(date.getTime() + 86_400_000);
    const dayOfWeek = date.getUTCDay();
    if (dayOfWeek !== 0 && dayOfWeek !== 6) remaining--;
  }
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

export function caseCreationDeadline(hireDate: string): string {
  return addBusinessDays(hireDate, CASE_CREATION_DEADLINE_BUSINESS_DAYS);
}

export function tncReferralDeadline(tncIssuedAt: string): string {
  return addBusinessDays(tncIssuedAt, TNC_REFERRAL_DEADLINE_BUSINESS_DAYS);
}

export function employeeContestDeadline(referredAt: string): string {
  return addBusinessDays(referredAt, EMPLOYEE_CONTEST_DEADLINE_BUSINESS_DAYS);
}

/**
 * Real, missed compliance obligations as of `asOfDate` — matches
 * payroll/i9.ts's own i9ComplianceIssues() convention (a finding to
 * surface, never a block or a guess). A case not yet created isn't
 * flagged until its own 3-business-day window has actually passed; a
 * TNC isn't flagged until the 10-day referral window has passed.
 */
export function everifyComplianceIssues(employee: Employee, everifyCase: EverifyCase | undefined, asOfDate: string): string[] {
  const issues: string[] = [];
  const status = everifyCase?.status ?? 'not_created';

  if (status === 'not_created') {
    const deadline = caseCreationDeadline(employee.hireDate);
    if (asOfDate > deadline) {
      issues.push(`E-Verify case was due to be created by ${deadline} and is still not on file.`);
    }
  }

  if (status === 'tentative_nonconfirmation' && everifyCase?.tncIssuedAt) {
    const deadline = tncReferralDeadline(everifyCase.tncIssuedAt);
    if (asOfDate > deadline) {
      issues.push(`A Tentative Nonconfirmation was due to be referred by ${deadline} and has not been.`);
    }
  }

  return issues;
}
