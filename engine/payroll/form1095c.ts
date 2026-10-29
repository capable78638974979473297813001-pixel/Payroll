import type { BenefitElection } from './benefits.ts';
import type { CoverageOffer, Line14Code, Line16Code } from './aca.ts';
import { lineFourteenCode, lineSixteenCode } from './aca.ts';
import type { Cents } from '../src/money.ts';

/**
 * Wires payroll/aca.ts's own Line 14/16 code functions across a real
 * employee's 12 months, using data this project actually has — hire/
 * termination dates and BenefitElection history — the same "no new
 * business logic, just apply the existing rule to real records" pattern
 * payroll/compliance.ts uses to wire src/minimum-wage.ts into a pay run.
 *
 * Disclosed scope, on top of payroll/aca.ts's own header:
 *  - This project has no MONTH-BY-MONTH coverage-offer tracking (what was
 *    actually offered, and at what price, can change mid-year — a new
 *    plan year, a rate change) — only BenefitElection's own effective/end
 *    dates, which say whether an employee was ENROLLED that month, not
 *    what the employer OFFERED. EmployerCoverageOfferPolicy is therefore
 *    a single set of offer terms applied to every month an employee was
 *    employed, which is right for the common case (an employer's terms
 *    are stable across its plan year) and wrong the month those terms
 *    actually change — the caller must call this again with a different
 *    policy for the months after a real change, rather than this module
 *    guessing when one happened.
 *  - Full-time status is a single caller-supplied fact for the whole
 *    year, not derived monthly — a real determination needs the same
 *    monthly hours-of-service payroll/aca.ts's own determineAleStatus()
 *    needs and this project doesn't persist (see that module's header).
 *  - A Limited Non-Assessment Period (a new hire's own waiting period,
 *    for instance) must be named explicitly by month; nothing here
 *    infers one from a hire date.
 */

export interface EmployerCoverageOfferPolicy {
  offeredMinimumEssentialCoverage: boolean;
  offeredMinimumValue: boolean;
  offeredToSpouse: boolean;
  offeredToDependents: boolean;
  /** The lowest-cost self-only monthly contribution this offer requires of the employee. */
  employeeMonthlyContribution: Cents;
  /** See payroll/aca.ts's own lineFourteenCode() — the FPL-based monthly ceiling below which a full family offer counts as a Qualifying Offer (1A) rather than an ordinary one (1E). */
  qualifyingOfferMonthlyCeiling: Cents;
  affordabilitySafeHarborUsed?: 'w2' | 'fpl' | 'rate-of-pay';
  /** Months (YYYY-MM) this employee was in a Limited Non-Assessment Period — a new-hire waiting period, most commonly. */
  limitedNonAssessmentPeriodMonths?: readonly string[];
  /** True only for a month the ALE-wide 95% minimum-essential-coverage offer test failed outright — see lineSixteenCode()'s own doc comment on why a safe harbor code must never be entered for such a month. */
  aleFailed95PercentOfferTest?: boolean;
}

export interface Form1095CMonth {
  month: string; // YYYY-MM
  line14: Line14Code;
  line16: Line16Code;
}

export interface Form1095CSummary {
  employeeId: string;
  year: number;
  months: Form1095CMonth[];
}

function monthBounds(year: number, month: number): { start: string; end: string } {
  const mm = String(month).padStart(2, '0');
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { start: `${year}-${mm}-01`, end: `${year}-${mm}-${String(lastDay).padStart(2, '0')}` };
}

/**
 * Builds all 12 months of Form 1095-C Part II for one employee in
 * `year`, from real hire/termination dates and their actual benefit
 * election history — see this module's own header for what's assumed
 * constant across the year rather than tracked month by month.
 */
export function compute1095CForEmployee(
  employee: { id: string; hireDate: string; terminationDate?: string },
  benefitElections: readonly BenefitElection[],
  isFullTimeAllYear: boolean,
  policy: EmployerCoverageOfferPolicy,
  year: number,
): Form1095CSummary {
  const ownElections = benefitElections.filter((e) => e.employeeId === employee.id);
  const lnapMonths = new Set(policy.limitedNonAssessmentPeriodMonths ?? []);

  const months: Form1095CMonth[] = [];
  for (let m = 1; m <= 12; m++) {
    const { start, end } = monthBounds(year, m);
    const monthKey = `${year}-${String(m).padStart(2, '0')}`;
    const employedThisMonth = employee.hireDate <= end && (!employee.terminationDate || employee.terminationDate >= start);

    if (!employedThisMonth) {
      months.push({ month: monthKey, line14: '1H', line16: '2A' });
      continue;
    }

    const enrolledInOffer = ownElections.some((e) => e.effectiveDate <= end && (!e.endDate || e.endDate >= start));

    const offer: CoverageOffer = {
      offeredMinimumEssentialCoverage: policy.offeredMinimumEssentialCoverage,
      offeredMinimumValue: policy.offeredMinimumValue,
      offeredToSpouse: policy.offeredToSpouse,
      offeredToDependents: policy.offeredToDependents,
      employeeEnrolled: enrolledInOffer,
      employeeMonthlyContribution: policy.employeeMonthlyContribution,
    };

    const line14 = lineFourteenCode(offer, policy.qualifyingOfferMonthlyCeiling);
    const line16 = lineSixteenCode({
      employedThisMonth: true,
      fullTimeThisMonth: isFullTimeAllYear,
      enrolledInOffer,
      inLimitedNonAssessmentPeriod: lnapMonths.has(monthKey),
      affordabilitySafeHarborUsed: policy.affordabilitySafeHarborUsed,
      aleFailed95PercentOfferTest: policy.aleFailed95PercentOfferTest,
    });

    months.push({ month: monthKey, line14, line16 });
  }

  return { employeeId: employee.id, year, months };
}
