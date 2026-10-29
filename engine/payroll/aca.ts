import { type Cents, dollars } from '../src/money.ts';

/**
 * ACA Employer Shared Responsibility (§4980H) determination, affordability
 * safe harbors, and Form 1095-C Part II code assignment.
 *
 * Every dollar figure and threshold here is LIVE-VERIFIED against IRS
 * primary sources (or, where marked, the best secondary sources available
 * when a primary source could not be reached), never assumed from trained
 * memory — this is the exact category of mistake this project's own
 * `payroll/contractors.ts` header warns about (the 1099-NEC threshold was
 * about to be built at its stale historical $600 figure instead of the
 * real 2026 $2,000 figure). ACA's own affordability percentage moves
 * every single year, so a hardcoded "current" figure here goes stale on
 * a predictable schedule — every constant below names the Rev. Proc. or
 * IRS page it came from and the year it applies to, on purpose.
 *
 * Two different "2026"s show up in ACA compliance and must not be
 * conflated: FILING SEASON 2026 furnishes/e-files Forms 1094-C/1095-C for
 * TAX YEAR 2025 (uses the 2025 affordability percentage, 9.02%).
 * COMPLIANCE YEAR 2026 is offers of coverage actually made during calendar
 * year 2026 (uses the 2026 percentage, 9.96%, per Rev. Proc. 2025-25 —
 * the highest figure on record, reflecting a new HHS premium-growth
 * methodology under the 2026 HHS Marketplace Integrity and Affordability
 * Rule). Every function below that takes an affordability percentage
 * takes it as an explicit parameter rather than picking a "current" one
 * internally, so the caller — not this module — decides which year
 * applies, the same "caller-supplied, never guessed" discipline
 * `src/types.ts`'s own EmployerContext uses throughout the tax engine.
 *
 * Disclosed scope (real gaps, not corners cut silently):
 *  - Hours-of-service for ALE/full-time determination must be supplied by
 *    the caller per employee per month. `payroll/types.ts`'s own
 *    PayRunLine does not retain hours worked (only the dollar amounts a
 *    paycheck produced), so this module cannot derive them from persisted
 *    pay run history yet — a further increment, not built here.
 *  - TRICARE/VA coverage exclusion from the ALE headcount (§4980H(c)(2)(F))
 *    is not modeled; a caller with such employees must exclude those
 *    employee-months from the input before calling determineAleStatus().
 *  - Line 14 Individual Coverage HRA codes (1G, 1L-1U) and the conditional
 *    spousal-offer codes (1J/1K) are NOT modeled — this module only
 *    determines the flat MEC/MV offer codes (1A-1F, 1H). An employer using
 *    an ICHRA or a conditional spousal offer needs those codes assigned
 *    by hand.
 *  - Line 16's multiemployer interim-rule code (2E) is not modeled.
 *  - The two 2025 Federal Poverty Line figures below ($15,650 / $15,960)
 *    could not be confirmed against HHS ASPE's own poverty-guidelines page
 *    directly (it returned an error to automated retrieval); they are
 *    corroborated by multiple independent compliance-industry secondary
 *    sources that agree with each other, not by the primary source itself.
 *    Re-verify against aspe.hhs.gov before relying on them for a real
 *    filing.
 */

/** Full-time = 30 hours/week, defined as its monthly equivalent of 130 hours/month. IRS — Determining if an Employer is an Applicable Large Employer (irs.gov/affordable-care-act/employers/determining-if-an-employer-is-an-applicable-large-employer). */
export const ACA_FULL_TIME_HOURS_PER_MONTH = 130;

/** FTE divisor: aggregate part-time hours of service for the month (each employee capped at this many hours) divided by this figure. Same IRS source as above. */
export const ACA_FTE_HOURS_DIVISOR = 120;
const ACA_FTE_HOURS_PER_EMPLOYEE_CAP = 120;

/** An employer averaging at least this many full-time-equivalent employees during the preceding calendar year is an Applicable Large Employer for the current year. Same IRS source as above. */
export const ALE_THRESHOLD = 50;

/** One employee's hours of service for one calendar month, as the employer's own timekeeping records it — the input this module needs but cannot derive on its own (see module header). */
export interface EmployeeMonthlyHours {
  employeeId: string;
  /** "YYYY-MM" */
  month: string;
  hoursOfService: number;
}

export interface MonthlyAleCounts {
  month: string;
  fullTimeEmployeeCount: number;
  fullTimeEquivalentCount: number;
}

export interface AleDetermination {
  monthly: MonthlyAleCounts[];
  /** Sum of (full-time + FTE) across all months supplied, divided by 12, rounded DOWN to a whole number per the IRS's own rounding rule — never averaged over fewer than 12 months by this function; a caller with a partial year must decide for itself whether an annualized estimate is appropriate. */
  averageMonthlyFullTimeEquivalent: number;
  isApplicableLargeEmployer: boolean;
}

/**
 * Classifies each employee as full-time (>=130 hours that month) or not,
 * turns the rest into fractional FTEs (aggregate hours, each employee
 * capped at 120 for the month, divided by 120), sums full-time + FTE for
 * each month, and averages across exactly the 12 months supplied.
 *
 * Throws rather than silently averaging over the wrong number of months:
 * an ALE determination silently computed over 9 or 15 months is a wrong
 * legal conclusion, not a usable estimate.
 */
export function determineAleStatus(hours: readonly EmployeeMonthlyHours[]): AleDetermination {
  const byMonth = new Map<string, EmployeeMonthlyHours[]>();
  for (const h of hours) {
    const list = byMonth.get(h.month) ?? [];
    list.push(h);
    byMonth.set(h.month, list);
  }
  const months = [...byMonth.keys()].sort();
  if (months.length !== 12) {
    throw new Error(`determineAleStatus() requires exactly 12 distinct months of data, got ${months.length}`);
  }

  const monthly: MonthlyAleCounts[] = months.map((month) => {
    const records = byMonth.get(month)!;
    let fullTimeEmployeeCount = 0;
    let partTimeHoursTotal = 0;
    for (const r of records) {
      if (r.hoursOfService >= ACA_FULL_TIME_HOURS_PER_MONTH) {
        fullTimeEmployeeCount += 1;
      } else {
        partTimeHoursTotal += Math.min(r.hoursOfService, ACA_FTE_HOURS_PER_EMPLOYEE_CAP);
      }
    }
    return {
      month,
      fullTimeEmployeeCount,
      fullTimeEquivalentCount: partTimeHoursTotal / ACA_FTE_HOURS_DIVISOR,
    };
  });

  const annualTotal = monthly.reduce((sum, m) => sum + m.fullTimeEmployeeCount + m.fullTimeEquivalentCount, 0);
  const averageMonthlyFullTimeEquivalent = Math.floor(annualTotal / 12);

  return {
    monthly,
    averageMonthlyFullTimeEquivalent,
    isApplicableLargeEmployer: averageMonthlyFullTimeEquivalent >= ALE_THRESHOLD,
  };
}

/** IRS Rev. Proc. 2024-35 — the affordability percentage that applied to plan years beginning in 2025 (used for TY2025 Forms 1095-C, i.e. filing season 2026). */
export const ACA_AFFORDABILITY_PERCENTAGE_2025 = 0.0902;

/** IRS Rev. Proc. 2025-25 — the affordability percentage for plan years beginning in 2026, reflecting the 2026 HHS Marketplace Integrity and Affordability Rule's new premium-growth methodology. The highest figure on record. */
export const ACA_AFFORDABILITY_PERCENTAGE_2026 = 0.0996;

/** §4980H(a) "no offer" annual penalty per full-time employee (minus the first 30), for plan years beginning after Dec 31, 2025. IRS Rev. Proc. 2025-26. */
export const ESRP_4980H_A_ANNUAL_PENALTY_2026: Cents = dollars(3_340);

/** §4980H(b) "unaffordable/inadequate" annual penalty per affected full-time employee, for plan years beginning after Dec 31, 2025. IRS Rev. Proc. 2025-26. */
export const ESRP_4980H_B_ANNUAL_PENALTY_2026: Cents = dollars(5_010);

/** The first N full-time employees are excluded entirely from a §4980H(a) penalty calculation. Same source as ALE_THRESHOLD. */
export const ESRP_4980H_A_EXCLUDED_HEADCOUNT = 30;

/**
 * §4980H(a) potential annual exposure if the employer fails the 95%
 * minimum-essential-coverage offer threshold: (full-time headcount minus
 * the first 30) times the flat annual penalty. This is the "no offer"
 * penalty — it applies employer-wide regardless of how many employees
 * actually went to the Marketplace and got a subsidy, unlike 4980H(b).
 */
export function estimate4980hAAnnualExposure(fullTimeEmployeeCount: number, annualPenaltyPerEmployee: Cents = ESRP_4980H_A_ANNUAL_PENALTY_2026): Cents {
  const penalizedCount = Math.max(0, fullTimeEmployeeCount - ESRP_4980H_A_EXCLUDED_HEADCOUNT);
  return penalizedCount * annualPenaltyPerEmployee;
}

/**
 * §4980H(b) potential annual exposure: the flat per-employee penalty times
 * however many full-time employees both (a) got an unaffordable or
 * sub-minimum-value offer (or none, if the (a) test didn't already apply)
 * AND (b) actually received a premium tax credit on the Marketplace — a
 * fact this module cannot know and the caller must supply, since it
 * depends on what that individual employee actually did, not on anything
 * the employer's own payroll records capture.
 */
export function estimate4980hBAnnualExposure(affectedFullTimeEmployeeCount: number, annualPenaltyPerEmployee: Cents = ESRP_4980H_B_ANNUAL_PENALTY_2026): Cents {
  return affectedFullTimeEmployeeCount * annualPenaltyPerEmployee;
}

/** 2025 mainland single-individual Federal Poverty Line — used by the FPL safe harbor for calendar-year 2026 plans beginning before July 1, 2026. See module header for the sourcing caveat on this figure. */
export const FEDERAL_POVERTY_LINE_2025_ANNUAL: Cents = dollars(15_650);

/** 2026 mainland single-individual Federal Poverty Line — used by the FPL safe harbor only for non-calendar plan years beginning on or after July 1, 2026. Same sourcing caveat as the 2025 figure. */
export const FEDERAL_POVERTY_LINE_2026_ANNUAL: Cents = dollars(15_960);

/**
 * Federal Poverty Line safe harbor (Line 16 code 2G): an offer is
 * affordable if the employee's own monthly required contribution for
 * self-only coverage does not exceed (mainland single-individual FPL ÷
 * 12) × the applicable affordability percentage. The FPL used is the one
 * in effect roughly 6 months before the plan year starts — a calendar-year
 * plan uses the PRIOR year's FPL (see the two constants above), which is
 * why this function takes the FPL as an explicit parameter rather than
 * picking one internally.
 */
export function fplSafeHarborMonthlyCeiling(federalPovertyLineAnnual: Cents, affordabilityPercentage: number): Cents {
  return Math.round((federalPovertyLineAnnual * affordabilityPercentage) / 12);
}

/**
 * Rate of Pay safe harbor for an hourly employee (Line 16 code 2H): the
 * lesser of the employee's hourly rate on the first day of the coverage
 * period or the lowest hourly rate during the month, multiplied by a
 * FIXED 130 hours (never the employee's actual hours that month) and the
 * affordability percentage.
 */
export function ratePayHourlySafeHarborMonthlyCeiling(hourlyRate: Cents, affordabilityPercentage: number): Cents {
  return Math.round(hourlyRate * ACA_FULL_TIME_HOURS_PER_MONTH * affordabilityPercentage);
}

/** Rate of Pay safe harbor for a salaried employee: monthly salary × the affordability percentage. Not usable for an employee paid solely by tips or commission. */
export function ratePaySalariedSafeHarborMonthlyCeiling(monthlySalary: Cents, affordabilityPercentage: number): Cents {
  return Math.round(monthlySalary * affordabilityPercentage);
}

/**
 * Form W-2 safe harbor (Line 16 code 2F): a full-YEAR reconciliation,
 * only knowable after year-end once Box 1 wages are final — the
 * employee's full-year required contribution must not exceed the
 * affordability percentage of their own Box 1 wages for that year. Unlike
 * the other two safe harbors this is never a monthly test.
 */
export function isAffordableUnderW2SafeHarbor(annualEmployeeContribution: Cents, annualBox1Wages: Cents, affordabilityPercentage: number): boolean {
  return annualEmployeeContribution <= Math.round(annualBox1Wages * affordabilityPercentage);
}

/** Minimum value: the plan pays at least this share of the total allowed cost of benefits for a standard population. IRS — Minimum Value and Affordability (irs.gov/affordable-care-act/employers/minimum-value-and-affordability). */
export const ACA_MINIMUM_VALUE_THRESHOLD = 0.6;

export interface CoverageOffer {
  offeredMinimumEssentialCoverage: boolean;
  /** Only meaningful if offeredMinimumEssentialCoverage is true. */
  offeredMinimumValue: boolean;
  offeredToSpouse: boolean;
  offeredToDependents: boolean;
  employeeEnrolled: boolean;
  /** The employee's own monthly required contribution for the lowest-cost self-only MV option — needed to distinguish a Qualifying Offer (1A) from an ordinary full offer (1E). */
  employeeMonthlyContribution: Cents;
}

export type Line14Code = '1A' | '1B' | '1C' | '1D' | '1E' | '1F' | '1H';

/**
 * Form 1095-C Part II, Line 14 — the offer-of-coverage code for one
 * employee for one month. Only the flat MEC/MV codes this module models
 * (see header for the ICHRA and conditional-spousal-offer codes NOT
 * modeled).
 */
export function lineFourteenCode(offer: CoverageOffer, qualifyingOfferMonthlyCeiling: Cents): Line14Code {
  if (!offer.offeredMinimumEssentialCoverage) return '1H';
  if (!offer.offeredMinimumValue) return '1F';
  if (offer.offeredToSpouse && offer.offeredToDependents) {
    return offer.employeeMonthlyContribution <= qualifyingOfferMonthlyCeiling ? '1A' : '1E';
  }
  if (offer.offeredToDependents) return '1C';
  if (offer.offeredToSpouse) return '1D';
  return '1B';
}

export type Line16Code = '2A' | '2B' | '2C' | '2D' | '2F' | '2G' | '2H' | undefined;

export interface Line16Inputs {
  employedThisMonth: boolean;
  fullTimeThisMonth: boolean;
  enrolledInOffer: boolean;
  inLimitedNonAssessmentPeriod: boolean;
  affordabilitySafeHarborUsed?: 'w2' | 'fpl' | 'rate-of-pay';
  /** True only if the ALE-wide 95% minimum-essential-coverage offer test failed this month — an affordability safe harbor code must never be entered for a month the employer failed that test outright. */
  aleFailed95PercentOfferTest?: boolean;
}

/**
 * Form 1095-C Part II, Line 16 — the safe harbor / relief code for one
 * employee for one month, applying the IRS's own priority order (2C
 * enrollment takes priority over nearly everything; only one code is ever
 * entered per employee per month). Returns undefined when no code applies
 * (a real, valid outcome on this form).
 */
export function lineSixteenCode(inputs: Line16Inputs): Line16Code {
  if (!inputs.employedThisMonth) return '2A';
  if (inputs.enrolledInOffer) return '2C';
  if (!inputs.fullTimeThisMonth) return '2B';
  if (inputs.inLimitedNonAssessmentPeriod) return '2D';
  if (inputs.affordabilitySafeHarborUsed && !inputs.aleFailed95PercentOfferTest) {
    if (inputs.affordabilitySafeHarborUsed === 'w2') return '2F';
    if (inputs.affordabilitySafeHarborUsed === 'fpl') return '2G';
    return '2H';
  }
  return undefined;
}
