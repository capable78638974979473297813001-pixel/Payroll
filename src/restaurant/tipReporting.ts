import { applyBps, type Cents } from '../lib/money.ts';

/**
 * Tip reporting and the FICA tip credit.
 *
 * Sources: IRS Publication 531 (employees report cash tips of $20 or more in a
 * month to the employer by the 10th of the next month); Form 8027 instructions
 * (a large food or beverage establishment is one that normally employed more
 * than 10 employees on a typical business day in the prior year, where tipping
 * is customary); IRC § 45B and Form 8846 (employer credit for its share of
 * FICA on tips above what is needed to bring wages to the $5.15 federal
 * minimum wage in effect on 1 January 2007).
 */

/**
 * An employee reports their cash, check, and debit and credit card tips to the
 * employer unless the month's total from that job is under $20 (IRS Pub. 531,
 * read 2026-10-29). The report is due by the 10th of the next month, or the next
 * business day if that is a weekend or legal holiday.
 */
export const MONTHLY_TIP_REPORTING_THRESHOLD: Cents = 2000;

export function mustReportTips(monthTipsCents: Cents): boolean {
  return monthTipsCents >= MONTHLY_TIP_REPORTING_THRESHOLD;
}

/**
 * Large food or beverage establishment test (Form 8027 instructions, read 2026-10-29):
 * in the 50 states or DC, tipping customary, and normally more than 10 employees on
 * a typical business day last year. The IRS counts employee hours: the test is met
 * when the worksheet total exceeds 80 hours a day. Tipping is generally not customary
 * when at least 95% of non-carryout sales carry a service charge of 10% or more.
 * `typicalDailyEmployees` is the prior year's usual headcount on a business day.
 */
export function form8027Applies(typicalDailyEmployees: number, tippingCustomary: boolean): boolean {
  return tippingCustomary && typicalDailyEmployees > 10;
}

/** Federal minimum wage frozen at its 2007 value for § 45B. */
export const SECTION_45B_MINIMUM_WAGE_PER_HOUR: Cents = 515;

/** Employer's share of FICA: 6.2% Social Security + 1.45% Medicare. */
export const EMPLOYER_FICA_BPS = 765;

export interface TipCreditRow {
  employeeId: string;
  hours: number;
  /** Wages paid in cash for the period, not counting tips. */
  nonTipWagesCents: Cents;
  tipsCents: Cents;
}

export interface TipCreditResult {
  creditableTipsCents: Cents;
  creditCents: Cents;
  perEmployee: Array<{ employeeId: string; creditableTipsCents: Cents }>;
  note: string;
}

/**
 * The § 45B credit: for each employee, tips beyond what is needed to lift cash
 * wages to $5.15 an hour, times the employer's 7.65% FICA share. The IRS's own
 * Form 8846 example works one employee-month at a time, so pass one row per
 * employee per month. It does not cap the Social Security part at the wage base,
 * so for an employee above the base the figure is an overstatement. Treat it as an
 * estimate for planning.
 */
export function ficaTipCredit(rows: readonly TipCreditRow[]): TipCreditResult {
  const perEmployee = rows.map((r) => {
    const neededForMinimum = Math.max(0, Math.round(SECTION_45B_MINIMUM_WAGE_PER_HOUR * r.hours) - r.nonTipWagesCents);
    return { employeeId: r.employeeId, creditableTipsCents: Math.max(0, r.tipsCents - neededForMinimum) };
  });
  const creditableTipsCents = perEmployee.reduce((a, r) => a + r.creditableTipsCents, 0);
  return {
    creditableTipsCents,
    creditCents: applyBps(creditableTipsCents, EMPLOYER_FICA_BPS),
    perEmployee,
    note: 'Estimate, figured one employee-month at a time as the IRS Form 8846 example does. The Social Security part is not capped at the wage base here. Confirm with your preparer before claiming.',
  };
}
