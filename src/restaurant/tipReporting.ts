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

/** Cash tips of $20 or more in a calendar month must be reported by the employee. */
export const MONTHLY_CASH_TIP_REPORTING_THRESHOLD: Cents = 2000;

export function mustReportCashTips(monthCashTipsCents: Cents): boolean {
  return monthCashTipsCents >= MONTHLY_CASH_TIP_REPORTING_THRESHOLD;
}

/** Large food or beverage establishment test. `typicalDailyEmployees` is the prior year's usual headcount on a business day. */
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
 * wages to $5.15 an hour, times the employer's 7.65% FICA share. This applies
 * the formula to whatever period of hours, wages and tips the caller passes in;
 * Form 8846 itself is figured for the tax year. It does not cap the Social
 * Security part at the wage base, so for an employee above the base the figure
 * is an overstatement. Treat it as an estimate for planning.
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
    note: 'Estimate. Form 8846 is figured for the tax year, and the Social Security part is not capped at the wage base here. Confirm with your preparer before claiming.',
  };
}
