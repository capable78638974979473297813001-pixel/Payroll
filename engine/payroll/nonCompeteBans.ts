import type { Cents } from '../src/money.ts';
import { dollars } from '../src/money.ts';

/**
 * State non-compete bans and salary thresholds — LIVE-VERIFIED against
 * primary sources where available (Washington's own 2026 threshold
 * figures come directly from the Washington State Register's own
 * calculated-figure filing, lawfilesext.leg.wa.gov), corroborated across
 * multiple independent trade-secrets/employment-law sources for every
 * other figure, not assumed from trained memory. Fetched/cross-checked
 * 2026-09-14.
 *
 * SIX JURISDICTIONS ONLY, deliberately — this is a rapidly moving area
 * (a "growing block" of states adopting salary-threshold regimes, per
 * multiple sources) and every other state's own rule (or absence of one)
 * is a disclosed gap, the same "one jurisdiction modeled, the rest named
 * as missing" boundary `payroll/fairChanceAct.ts` and
 * `payroll/paidSickLeave.ts` already draw:
 *  - TOTAL BAN states: California (Bus. & Prof. Code § 16600, no
 *    exceptions for employees), North Dakota (banned since 1865), and
 *    Oklahoma (banned since 1890) void virtually every employee
 *    non-compete outright, with NO salary threshold or duration test at
 *    all. Minnesota's own ban (Minn. Stat. § 181.988) is NOT
 *    retroactive — it voids only agreements entered into on or after
 *    2023-07-01, so a pre-2023 Minnesota non-compete is a genuinely
 *    different case than a 2024 one, unlike the other three total-ban
 *    states.
 *  - THRESHOLD states use FOUR genuinely different mechanisms for
 *    computing the dollar line, not one shared formula: Colorado
 *    (C.R.S. § 8-2-113) sets ONE threshold ($130,014 for 2026, CPI-
 *    adjusted annually) for non-competes and derives a SECOND, lower
 *    threshold for customer non-solicitation agreements as a fixed 60%
 *    fraction of the first ($78,008.40) — a proportional relationship,
 *    not an independently-published figure. Illinois (Freedom to Work
 *    Act, 820 ILCS 90) instead uses TWO independently fixed dollar
 *    figures on a step schedule with NO cpi/inflation adjustment at all
 *    ($75,000 non-compete / $45,000 non-solicit through 2026, rising to
 *    $80,000 / $47,500 on 2027-01-01, then stepping again every five
 *    years through 2037). Washington (RCW 49.62) publishes separate,
 *    CPI-adjusted figures for EMPLOYEES ($126,858.83 for 2026) and
 *    INDEPENDENT CONTRACTORS ($317,147.09 for 2026) — roughly 2.5x
 *    apart, not the same figure applied to both worker types. Oregon
 *    (ORS 653.295) uses a single CPI-adjusted threshold ($119,541 for
 *    2026) but ALSO caps every enforceable non-compete's own duration at
 *    12 months and requires the employer to have disclosed the
 *    requirement in a written job offer at least two weeks before the
 *    employee's first day — genuinely different conditions than any
 *    other threshold state models here.
 *  - WASHINGTON'S OWN THRESHOLD REGIME IS ITSELF TEMPORARY: HB 1155
 *    (signed 2026-03-23) replaces RCW 49.62's threshold test with a
 *    near-total ban effective 2027-06-30, voiding noncompetes for
 *    employees AND independent contractors alike from that date forward.
 *    `isWaNonCompeteEnforceable()` takes the relevant date as an explicit
 *    input rather than assuming today's law is permanent, the same
 *    effective-dating discipline this project's own `data/states/*.json`
 *    configs apply to every other figure.
 *
 * SCOPE: does not evaluate whether a given restriction is "reasonable in
 * scope, geography, and duration" under the many states with NO statutory
 * threshold at all (governed instead by common-law reasonableness
 * balancing tests with no closed-form answer) — a fact-specific judgment
 * call, the same kind of scope boundary `payroll/warnAct.ts`'s own
 * exception guidance draws. Does not model non-solicitation-of-employees
 * (as opposed to customers) or confidentiality/trade-secret agreements,
 * which are governed by separate, and separately varying, state rules.
 */

export type NonCompeteTotalBanState = 'CA' | 'MN' | 'ND' | 'OK';
export type NonCompeteThresholdState = 'CO' | 'IL' | 'WA' | 'OR';

/** Minnesota's own ban applies only to agreements entered into on or after this date — NOT retroactive, unlike CA/ND/OK's own unconditional bans. */
export const MN_NON_COMPETE_BAN_EFFECTIVE_DATE = '2023-07-01';

/**
 * Whether a non-compete is void outright in one of the four total-ban
 * states, given the date the agreement was entered into. California,
 * North Dakota, and Oklahoma void every covered agreement regardless of
 * date; Minnesota only agreements from 2023-07-01 forward.
 */
export function isNonCompeteVoidInTotalBanState(state: NonCompeteTotalBanState, agreementDate: string): boolean {
  if (state === 'MN') return agreementDate >= MN_NON_COMPETE_BAN_EFFECTIVE_DATE;
  return true;
}

// --- Colorado (C.R.S. § 8-2-113) ---------------------------------------

/** 2026: the Colorado highly-compensated-worker threshold for non-compete agreements, CPI-adjusted annually. */
export const CO_NON_COMPETE_THRESHOLD_2026: Cents = dollars(130_014);

/** The customer non-solicitation threshold is always this fraction of the non-compete threshold, not an independently-published figure. */
export const CO_NON_SOLICIT_THRESHOLD_FRACTION = 0.6;

export function coNonSolicitThreshold2026(): Cents {
  return Math.round(CO_NON_COMPETE_THRESHOLD_2026 * CO_NON_SOLICIT_THRESHOLD_FRACTION);
}

export function isCoNonCompeteEnforceable(annualCompensationCents: Cents): boolean {
  return annualCompensationCents >= CO_NON_COMPETE_THRESHOLD_2026;
}

export function isCoNonSolicitEnforceable(annualCompensationCents: Cents): boolean {
  return annualCompensationCents >= coNonSolicitThreshold2026();
}

// --- Illinois (Freedom to Work Act, 820 ILCS 90) ------------------------

/** The Illinois thresholds step up on a fixed schedule, NOT a CPI/inflation adjustment — this is the one date the figures below change before this module needs revisiting. */
export const IL_NON_COMPETE_THRESHOLD_STEP_DATE_2027 = '2027-01-01';

export const IL_NON_COMPETE_THRESHOLD_THROUGH_2026: Cents = dollars(75_000);
export const IL_NON_SOLICIT_THRESHOLD_THROUGH_2026: Cents = dollars(45_000);
export const IL_NON_COMPETE_THRESHOLD_FROM_2027: Cents = dollars(80_000);
export const IL_NON_SOLICIT_THRESHOLD_FROM_2027: Cents = dollars(47_500);

export function ilNonCompeteThreshold(asOfDate: string): Cents {
  return asOfDate >= IL_NON_COMPETE_THRESHOLD_STEP_DATE_2027 ? IL_NON_COMPETE_THRESHOLD_FROM_2027 : IL_NON_COMPETE_THRESHOLD_THROUGH_2026;
}

export function ilNonSolicitThreshold(asOfDate: string): Cents {
  return asOfDate >= IL_NON_COMPETE_THRESHOLD_STEP_DATE_2027 ? IL_NON_SOLICIT_THRESHOLD_FROM_2027 : IL_NON_SOLICIT_THRESHOLD_THROUGH_2026;
}

export function isIlNonCompeteEnforceable(annualCompensationCents: Cents, asOfDate: string): boolean {
  return annualCompensationCents >= ilNonCompeteThreshold(asOfDate);
}

export function isIlNonSolicitEnforceable(annualCompensationCents: Cents, asOfDate: string): boolean {
  return annualCompensationCents >= ilNonSolicitThreshold(asOfDate);
}

// --- Washington (RCW 49.62) ---------------------------------------------

/** HB 1155 (signed 2026-03-23) replaces the threshold regime below with a near-total ban from this date forward. */
export const WA_NON_COMPETE_TOTAL_BAN_EFFECTIVE_DATE = '2027-06-30';

export const WA_NON_COMPETE_EMPLOYEE_THRESHOLD_2026: Cents = dollars(126_858.83);
export const WA_NON_COMPETE_INDEPENDENT_CONTRACTOR_THRESHOLD_2026: Cents = dollars(317_147.09);

/**
 * Whether a Washington non-compete is enforceable as of the given date:
 * void outright from the 2027-06-30 total-ban date forward, regardless
 * of compensation; before that, enforceable only above the worker's own
 * threshold (employee vs. independent contractor use different figures).
 */
export function isWaNonCompeteEnforceable(annualCompensationCents: Cents, isIndependentContractor: boolean, asOfDate: string): boolean {
  if (asOfDate >= WA_NON_COMPETE_TOTAL_BAN_EFFECTIVE_DATE) return false;
  const threshold = isIndependentContractor ? WA_NON_COMPETE_INDEPENDENT_CONTRACTOR_THRESHOLD_2026 : WA_NON_COMPETE_EMPLOYEE_THRESHOLD_2026;
  return annualCompensationCents >= threshold;
}

// --- Oregon (ORS 653.295) ------------------------------------------------

export const OR_NON_COMPETE_THRESHOLD_2026: Cents = dollars(119_541);

/** ORS 653.295: any non-compete term longer than this many months is void, even for a worker who otherwise meets the salary threshold. */
export const OR_NON_COMPETE_MAX_DURATION_MONTHS = 12;

/** ORS 653.295: the employer must have disclosed the non-compete requirement in a written job offer at least this many days before the employee's first day. */
export const OR_NON_COMPETE_MIN_ADVANCE_NOTICE_DAYS = 14;

export interface OrNonCompeteEnforceabilityInput {
  annualCompensationCents: Cents;
  termMonths: number;
  advanceNoticeDays: number;
}

/** Oregon requires ALL THREE conditions at once: meets the salary threshold, the term doesn't exceed 12 months, and the employer gave at least two weeks' written advance notice. */
export function isOrNonCompeteEnforceable(input: OrNonCompeteEnforceabilityInput): boolean {
  return (
    input.annualCompensationCents >= OR_NON_COMPETE_THRESHOLD_2026 &&
    input.termMonths <= OR_NON_COMPETE_MAX_DURATION_MONTHS &&
    input.advanceNoticeDays >= OR_NON_COMPETE_MIN_ADVANCE_NOTICE_DAYS
  );
}
