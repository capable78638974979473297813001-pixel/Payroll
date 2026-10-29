import { minimumWage } from '../src/minimum-wage.ts';
import type { Cents } from '../src/money.ts';
import { dollars } from '../src/money.ts';

/**
 * FLSA tip credit shortfall and tip pooling eligibility — LIVE-VERIFIED
 * against DOL's own tip-regulations page (dol.gov/agencies/whd/flsa/tips)
 * and its own January 14, 2025 clarification on manager/supervisor tip-
 * pool exclusion, corroborated across multiple independent wage-and-hour
 * sources for the current federal dollar figures, not assumed from
 * trained memory. Fetched/cross-checked 2026-09-14.
 *
 * DELIBERATELY WIRES `src/minimum-wage.ts` DIRECTLY, the same pattern
 * `payroll/compliance.ts` already established, rather than re-deriving
 * any state's own tipped-cash-floor or tip-credit-allowed answer here:
 * that engine is already the source of truth this project's own
 * `npm run coverage:minimum-wage` measures every state/locality against,
 * including the genuinely different STRUCTURE of tip credit rules across
 * states (some states like California, Minnesota, Montana, Nevada,
 * Oregon, Washington, and Alaska allow NO tip credit at all — the full
 * rate is owed in cash regardless of tips — a fact `stateTipCredit()`
 * surfaces directly from that engine's own `tipCreditAllowed` field
 * rather than guessing at a list of states here). Reimplementing any of
 * that state-by-state logic in this module would risk the "two
 * different, possibly divergent, calculations of the same figure"
 * failure mode `payroll/cobra.ts`'s own header warns against.
 *
 * WHAT THIS MODULE ADDS THAT THE CORE ENGINE DOES NOT: the core engine
 * only answers "what floor applies," the same scope
 * `payroll/compliance.ts`'s own header draws for the STANDARD rate. This
 * module adds the two things that require an actual pay period's own
 * facts, not just a jurisdiction and a date:
 *  1. `tipCreditShortfall()` — an employer may pay the tipped cash floor
 *     ONLY IF the employee's actual tips, added to that cash wage, reach
 *     the full (non-tipped) minimum wage for the hours worked. Where they
 *     fall short — a slow shift, a bad night — 29 U.S.C. § 203(m)(2)(A)
 *     requires the employer to make up the difference; this function
 *     computes exactly how much.
 *  2. `isEligibleForTipPool()` — DOL's own current tip-pooling rule,
 *     which turns on TWO independent facts at once: a manager or
 *     supervisor (by FLSA executive-duties test) is NEVER eligible for a
 *     tip pool, full stop, regardless of tip-credit status; and where the
 *     employer DOES take a tip credit, non-management pool eligibility
 *     narrows further to only employees who customarily and regularly
 *     receive tips (so back-of-house staff are excluded) — a restriction
 *     that disappears entirely once the employer pays full minimum wage
 *     and claims no tip credit at all.
 *
 * SCOPE: does not evaluate the federal "80/20/30" dual-jobs rule (how
 * much of a shift a tipped employee may spend on non-tipped or tip-
 * supporting duties before the tip credit is lost for that time) — a
 * fact-specific, minute-by-minute judgment this project has no duty-
 * tracking model to check against, the same kind of scope boundary
 * `payroll/warnAct.ts`'s own exception guidance draws. Does not model
 * the written tip-credit notice requirement's own content (cash wage,
 * credit amount claimed, and that tips belong to the employee) as a
 * generated document — only the dollar test it protects.
 */

export const FEDERAL_MINIMUM_WAGE_PER_HOUR: Cents = dollars(7.25);
export const FEDERAL_TIPPED_CASH_WAGE_PER_HOUR: Cents = dollars(2.13);

/** 29 U.S.C. § 203(m)(2)(A): the maximum tip credit an employer may claim against the federal minimum wage. */
export function federalMaxTipCreditPerHour(): Cents {
  return FEDERAL_MINIMUM_WAGE_PER_HOUR - FEDERAL_TIPPED_CASH_WAGE_PER_HOUR;
}

export interface StateTipCreditAnswer {
  /** Whether the binding jurisdiction allows a tip credit at all — false in CA, MN, MT, NV, OR, WA, AK, Guam, and Flagstaff AZ, straight from src/minimum-wage.ts's own `tipCreditAllowed`. */
  tipCreditAllowed: boolean;
  /** The binding CASH floor an employer may pay a tipped employee, before tips — equal to `standardFloorCentsPerHour` where no tip credit is allowed. */
  cashFloorCentsPerHour: Cents;
  /** The binding FULL (non-tipped) minimum wage floor for the same jurisdiction and date. */
  standardFloorCentsPerHour: Cents;
  /** The gap between the two — the maximum tip credit this jurisdiction allows, zero where no tip credit is allowed. */
  maxTipCreditCentsPerHour: Cents;
}

/**
 * Looks up the binding tipped-cash and standard floors for a work
 * location by calling `minimumWage()` directly (once with `tipped:
 * true`, once without), since the two floors are independently-highest
 * answers and the tipped one is never derived from the standard one, per
 * that engine's own header.
 */
export function stateTipCredit(checkDate: string, state: string, locality?: string): StateTipCreditAnswer {
  const tippedAnswer = minimumWage({ checkDate, state, locality, tipped: true });
  const standardAnswer = minimumWage({ checkDate, state, locality, tipped: false });
  return {
    tipCreditAllowed: tippedAnswer.tipCreditAllowed,
    cashFloorCentsPerHour: tippedAnswer.cents,
    standardFloorCentsPerHour: standardAnswer.cents,
    maxTipCreditCentsPerHour: Math.max(0, standardAnswer.cents - tippedAnswer.cents),
  };
}

export interface TipCreditShortfallInput {
  hoursWorked: number;
  /** The hourly cash wage actually paid, before tips. */
  cashWageCentsPerHour: Cents;
  /** Total tips actually received over the period. */
  tipsReceivedCents: Cents;
  /** The FULL (non-tipped) minimum wage floor that binds for the hours worked — e.g. `stateTipCredit()`'s own `standardFloorCentsPerHour`. */
  requiredMinimumWageCentsPerHour: Cents;
}

/**
 * The tip-credit make-up amount owed: zero if cash wages plus tips
 * actually received meet or exceed the full minimum wage for the hours
 * worked, otherwise the exact shortfall the employer must pay to close
 * the gap, per 29 U.S.C. § 203(m)(2)(A).
 */
export function tipCreditShortfall(input: TipCreditShortfallInput): Cents {
  const totalOwed = Math.round(input.requiredMinimumWageCentsPerHour * input.hoursWorked);
  const totalPaid = Math.round(input.cashWageCentsPerHour * input.hoursWorked) + input.tipsReceivedCents;
  return Math.max(0, totalOwed - totalPaid);
}

export interface TipPoolEligibilityInput {
  /** True if the worker satisfies the FLSA executive-duties test (hiring/firing authority, disciplinary authority, or personnel recommendations that carry significant weight) — DOL's own January 2025 clarification. */
  isManagerOrSupervisor: boolean;
  /** True if the worker's occupation customarily and regularly receives tips (e.g. server, bartender, busser) — false for back-of-house roles like cooks and dishwashers. */
  customarilyReceivesTips: boolean;
  /** True if the employer claims a tip credit for this workforce at all. */
  employerTakesTipCredit: boolean;
}

/**
 * DOL's own current tip-pooling rule: a manager or supervisor is NEVER
 * eligible, regardless of tip-credit status. Otherwise, where the
 * employer takes a tip credit, only customarily-tipped employees are
 * eligible (back-of-house staff excluded); where the employer takes no
 * tip credit and pays full minimum wage in cash, every non-management
 * employee is eligible regardless of whether their own role customarily
 * receives tips.
 */
export function isEligibleForTipPool(input: TipPoolEligibilityInput): boolean {
  if (input.isManagerOrSupervisor) return false;
  if (input.employerTakesTipCredit) return input.customarilyReceivesTips;
  return true;
}
