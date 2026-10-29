import type { Cents } from '../src/money.ts';
import { dollars } from '../src/money.ts';

/**
 * New York's Wage Theft Prevention Act (N.Y. Labor Law § 195) — the
 * at-hire "Notice and Acknowledgement of Pay Rate and Payday" and the
 * wage-statement (pay stub) content it requires — LIVE-VERIFIED against
 * the New York State Department of Labor's own Wage Theft Prevention Act
 * FAQ (dol.ny.gov/wage-theft-prevention-act-faq, fetched 2026-09-13), not
 * assumed from trained memory.
 *
 * ONE STATE ONLY. New York is the one jurisdiction this module models
 * explicitly — this project already carries NY-specific data elsewhere
 * (data/minimum-wage/states/NY-2026.json, data/employer-thresholds/
 * NY-2026.json), so this fills in the same state's own notice-and-
 * statement regime rather than starting a new one. Every other state
 * with its own wage-notice law (several do) remains a disclosed gap, the
 * same "one jurisdiction modeled, the rest named as missing" boundary
 * payroll/paidSickLeave.ts and payroll/workersComp.ts already draw.
 *
 * SCOPE: (1) validates that a notice contains every field § 195(1)
 * requires, (2) decides whether a pay-RATE change needs a brand-new
 * notice or may simply appear on the next wage statement instead, and
 * (3) estimates the DOL's own per-day civil penalty exposure (capped at
 * $5,000/worker either way) for a notice or wage-statement violation.
 * Does NOT generate the notice document itself or translate it (the
 * DOL's own templates exist for that) and does NOT track retaliation
 * claims, which are a genuinely separate § 215 cause of action this
 * module leaves out entirely.
 */

export type NyWageBasisOfPay = 'hourly' | 'shift' | 'day' | 'week' | 'salary' | 'piece' | 'commission' | 'other';

/** Every field NY DOL's own FAQ lists as required content for the notice. */
export interface NyWageNotice {
  rateOfPayCents: Cents;
  basisOfPay: NyWageBasisOfPay;
  /** 0 if the employer claims no tip/meal/lodging allowance as part of minimum wage — the notice must state this either way, not merely omit it when none is claimed. */
  allowancesClaimedCents: Cents;
  regularPayDay: string;
  employerLegalName: string;
  employerAddress: string;
  employerPhone: string;
}

/** DOL FAQ: employers must keep signed notices for this many years. */
export const NY_WAGE_NOTICE_RETENTION_YEARS = 6;

/** DOL FAQ: DOL-assessed damages per day per worker for a missing/deficient pay-rate notice. */
export const NY_WAGE_NOTICE_DAILY_PENALTY: Cents = dollars(50);

/** DOL FAQ: the cap on total notice-violation damages recoverable per worker (in an individual private action, or in practice where the daily rate stops accruing). */
export const NY_WAGE_NOTICE_MAX_DAMAGES: Cents = dollars(5_000);

/** DOL FAQ: DOL-assessed damages per day per worker for a missing/deficient wage statement. */
export const NY_WAGE_STATEMENT_DAILY_PENALTY: Cents = dollars(250);

/** DOL FAQ: the cap on total wage-statement-violation damages recoverable per worker. */
export const NY_WAGE_STATEMENT_MAX_DAMAGES: Cents = dollars(5_000);

/** Every notice field NY DOL requires — flags each one missing, rather than stopping at the first, the same "report every failing prong" pattern payroll/fmla.ts's own eligibility check uses. Accepts a Partial so a caller assembling a notice can check it before every field is filled in. */
export function nyWageNoticeComplianceIssues(notice: Partial<NyWageNotice>): string[] {
  const issues: string[] = [];
  if (notice.rateOfPayCents === undefined || notice.rateOfPayCents <= 0) issues.push('Missing rate of pay.');
  if (!notice.basisOfPay) issues.push('Missing basis of pay (hourly, shift, day, week, salary, piece, commission, or other).');
  if (notice.allowancesClaimedCents === undefined) issues.push('Missing a statement of allowances claimed as part of minimum wage (enter 0 if none claimed).');
  if (!notice.regularPayDay) issues.push('Missing regular payday.');
  if (!notice.employerLegalName) issues.push('Missing employer legal name.');
  if (!notice.employerAddress) issues.push('Missing employer address.');
  if (!notice.employerPhone) issues.push('Missing employer phone number.');
  return issues;
}

/**
 * DOL FAQ #14: a rate DECREASE always requires written notice before the
 * reduction takes effect, regardless of industry. A rate INCREASE needs
 * a new notice only if it will NOT appear on the employee's next wage
 * statement — EXCEPT in the hospitality industry, which currently must
 * issue a new notice for every rate change, increase or decrease, with
 * no wage-statement substitute available at all.
 */
export function isNewNoticeRequiredForRateChange(isRateIncrease: boolean, willAppearOnNextWageStatement: boolean, isHospitalityIndustry: boolean): boolean {
  if (isHospitalityIndustry) return true;
  if (!isRateIncrease) return true;
  return !willAppearOnNextWageStatement;
}

/** DOL's own per-day rate, capped at the maximum recoverable figure — never exceeds the cap no matter how many days elapse. */
export function estimatedNoticeViolationDamages(daysWithoutCompliantNotice: number): Cents {
  return Math.min(daysWithoutCompliantNotice * NY_WAGE_NOTICE_DAILY_PENALTY, NY_WAGE_NOTICE_MAX_DAMAGES);
}

/** Same capped-daily-rate structure as the notice penalty above, at the wage statement's own (higher) daily rate. */
export function estimatedWageStatementViolationDamages(daysWithoutCompliantStatement: number): Cents {
  return Math.min(daysWithoutCompliantStatement * NY_WAGE_STATEMENT_DAILY_PENALTY, NY_WAGE_STATEMENT_MAX_DAMAGES);
}
