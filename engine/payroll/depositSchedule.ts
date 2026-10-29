import { type Cents, dollars } from '../src/money.ts';

/**
 * Federal employment tax DEPOSIT SCHEDULE — a genuinely separate concept
 * from Form 941 itself (which reports a quarter's total liability after
 * the fact) and from withholding (which this project already computes
 * correctly per paycheck): WHEN the employer must actually hand withheld
 * taxes to the government, which depends on how much tax the employer
 * has historically owed, not on anything about this quarter's own
 * filing. Getting this wrong is a real, first-class payroll failure mode
 * (a Failure-to-Deposit penalty), independent of whether the tax itself
 * was computed correctly.
 *
 * LIVE-VERIFIED against IRS Notice 931 (Rev. September 2025) and IRS
 * Publication 15 (Circular E), both explicitly "for use in 2026" —
 * fetched and read in full rather than assumed from trained memory, the
 * same discipline payroll/aca.ts and payroll/contractors.ts apply to
 * their own dollar figures. Every threshold below is confirmed UNCHANGED
 * from prior years in the 2026 revision of both documents.
 *
 * Disclosed scope:
 *  - The lookback-period threshold is measured against Form 941's own
 *    LINE 12 ("total taxes after adjustments and nonrefundable credits"
 *    per IRS Notice 931). This project does not model 941 credits or
 *    adjustments (see payroll/filings.ts's own header) and only computes
 *    LINE 6 ("total taxes BEFORE adjustments") — identical to Line 12
 *    for the common case this project already scopes to (an employer
 *    claiming no credits/adjustments), but an overestimate for one that
 *    does. Callers passing quarterly liability figures into this module
 *    should know that distinction rather than assume perfect parity with
 *    a real IRS determination.
 *  - Deposit-deadline dates are calendar-only (Mon-Fri business days);
 *    this module does not exclude Federal Reserve/federal holidays, the
 *    same disclosed gap payroll/directDepositVerification.ts's own
 *    business-day counter carries.
 *  - EFTPS mechanics themselves (the actual electronic transfer) are out
 *    of scope, the same "disclosed, not built" boundary this project
 *    draws around e-filing and bank-linking elsewhere.
 */

export type DepositorSchedule = 'monthly' | 'semiweekly';

/** IRS Notice 931: a lookback-period total tax liability at or below this amount makes an employer a MONTHLY schedule depositor; above it, SEMIWEEKLY. */
export const LOOKBACK_PERIOD_THRESHOLD: Cents = dollars(50_000);

/** IRS Notice 931: accumulating this much tax liability on any single day within a deposit period triggers the next-business-day deposit rule, regardless of the employer's regular schedule. */
export const NEXT_DAY_DEPOSIT_THRESHOLD: Cents = dollars(100_000);

/** IRS Notice 931 / Pub 15 §11: an employer may pay with its timely filed quarterly return instead of depositing if either the current or preceding quarter's total liability is under this amount AND no next-day deposit obligation was triggered during the current quarter. */
export const DE_MINIMIS_QUARTERLY_THRESHOLD: Cents = dollars(2_500);

/** IRS Notice 931: a monthly schedule depositor deposits by this day of the month following the month payments were made. */
export const MONTHLY_DEPOSIT_DAY_OF_MONTH = 15;

/**
 * The four quarters (in year/quarter form, matching payroll/filings.ts's
 * own computeForm941() signature) that make up the lookback period for a
 * given calendar year — July 1 two years prior through June 30 of the
 * immediately preceding year. For calendar year 2026 this is 2024 Q3,
 * 2024 Q4, 2025 Q1, 2025 Q2.
 */
export function lookbackPeriodQuarters(year: number): { year: number; quarter: 1 | 2 | 3 | 4 }[] {
  return [
    { year: year - 2, quarter: 3 },
    { year: year - 2, quarter: 4 },
    { year: year - 1, quarter: 1 },
    { year: year - 1, quarter: 2 },
  ];
}

/**
 * Monthly by default: a brand-new employer with no lookback-period
 * history is a MONTHLY schedule depositor for its first calendar year
 * (Form 941 filers) — pass `undefined` for `lookbackPeriodTotalLiability`
 * to get this default. An existing employer's actual lookback total
 * decides monthly vs. semiweekly against LOOKBACK_PERIOD_THRESHOLD.
 */
export function determineDepositorSchedule(lookbackPeriodTotalLiability: Cents | undefined): DepositorSchedule {
  if (lookbackPeriodTotalLiability === undefined) return 'monthly';
  return lookbackPeriodTotalLiability > LOOKBACK_PERIOD_THRESHOLD ? 'semiweekly' : 'monthly';
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Monthly schedule depositor: taxes on payments made during `paymentYear`/`paymentMonth` (1-12) are due the 15th of the following month. Calendar-only — see this module's own header on the holiday-calendar gap. */
export function monthlyDepositDeadline(paymentYear: number, paymentMonth: number): string {
  const nextMonth = paymentMonth === 12 ? 1 : paymentMonth + 1;
  const nextYear = paymentMonth === 12 ? paymentYear + 1 : paymentYear;
  return `${nextYear}-${pad2(nextMonth)}-${pad2(MONTHLY_DEPOSIT_DAY_OF_MONTH)}`;
}

/** The next date on/after `fromDate` (exclusive) that falls on the given ISO weekday (0=Sunday..6=Saturday). */
function nextWeekdayAfter(fromDate: string, targetDay: number): string {
  const date = new Date(`${fromDate}T00:00:00Z`);
  do {
    date.setUTCDate(date.getUTCDate() + 1);
  } while (date.getUTCDay() !== targetDay);
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

/**
 * Semiweekly schedule depositor: IRS Notice 931's own table. A payday
 * falling Wednesday, Thursday or Friday is due the FOLLOWING Wednesday;
 * a payday falling Saturday, Sunday, Monday or Tuesday is due the
 * FOLLOWING Friday. Always at least 3 business days out.
 */
export function semiweeklyDepositDeadline(payDate: string): string {
  const day = new Date(`${payDate}T00:00:00Z`).getUTCDay(); // 0=Sun..6=Sat
  const isWedThruFri = day === 3 || day === 4 || day === 5;
  return nextWeekdayAfter(payDate, isWedThruFri ? 3 : 5);
}

/** The next business day (Mon-Fri) strictly after `date` — calendar-only, no federal holiday calendar (see this module's own header). */
export function nextBusinessDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  do {
    d.setUTCDate(d.getUTCDate() + 1);
  } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** Whether accumulating this much liability within one deposit period triggers the $100,000 next-day rule. */
export function nextDayDepositRuleApplies(accumulatedLiabilityThisPeriod: Cents): boolean {
  return accumulatedLiabilityThisPeriod >= NEXT_DAY_DEPOSIT_THRESHOLD;
}

/**
 * IRS Notice 931: a MONTHLY schedule depositor who accumulates $100,000+
 * within a deposit period becomes a SEMIWEEKLY schedule depositor
 * starting the next day, for the rest of that calendar year and all of
 * the following one. A depositor already semiweekly doesn't change —
 * it's already the stricter schedule.
 */
export function nextDayRuleChangesFutureSchedule(currentSchedule: DepositorSchedule, accumulatedLiabilityThisPeriod: Cents): boolean {
  return currentSchedule === 'monthly' && nextDayDepositRuleApplies(accumulatedLiabilityThisPeriod);
}

/**
 * The actual deposit deadline for one payment: the $100,000 next-day
 * rule overrides the regular monthly/semiweekly schedule whenever it's
 * triggered, for either kind of depositor.
 */
export function depositDeadlineFor(
  schedule: DepositorSchedule,
  payDate: string,
  accumulatedLiabilityThisPeriod: Cents,
): string {
  if (nextDayDepositRuleApplies(accumulatedLiabilityThisPeriod)) {
    return nextBusinessDay(payDate);
  }
  if (schedule === 'monthly') {
    const [y, m] = payDate.split('-').map(Number);
    return monthlyDepositDeadline(y, m);
  }
  return semiweeklyDepositDeadline(payDate);
}

/**
 * IRS Notice 931 / Pub 15 §11's de minimis exception: pay with the
 * timely filed quarterly return instead of depositing at all, if EITHER
 * the current or the preceding quarter's total liability is under
 * $2,500 AND no $100,000 next-day deposit obligation was triggered
 * during the current quarter.
 */
export function qualifiesForDeMinimisException(
  currentQuarterLiability: Cents,
  precedingQuarterLiability: Cents,
  hadNextDayDepositObligationThisQuarter: boolean,
): boolean {
  if (hadNextDayDepositObligationThisQuarter) return false;
  return currentQuarterLiability < DE_MINIMIS_QUARTERLY_THRESHOLD || precedingQuarterLiability < DE_MINIMIS_QUARTERLY_THRESHOLD;
}
