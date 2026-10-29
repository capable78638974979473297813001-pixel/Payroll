import type { Cents } from './money.ts';
import { atLeastZero, dollars } from './money.ts';
import type { Deduction, Earning, PretaxCategory, YearToDate } from './types.ts';

/**
 * Earnings that enter a taxable base at all.
 *
 * Imputed income (group term life over $50k, personal use of a company car)
 * is taxable even though no cash changes hands. Reimbursements are the
 * mirror case: cash moves, nothing is taxable.
 *
 * A ministerial housing allowance is a third shape — cash that is excluded
 * from income tax — but ONLY for a minister, so it is excluded here only
 * when the caller says the worker is one. For anyone else it is ordinary
 * taxable pay; a category name is not a tax exemption.
 */
export function taxableEarnings(
  earnings: readonly Earning[],
  options: { housingAllowanceExcluded?: boolean } = {},
): Cents {
  return earnings
    .filter((e) => e.category !== 'reimbursement')
    .filter((e) => !(options.housingAllowanceExcluded && e.category === 'housing_allowance'))
    .reduce((sum, e) => sum + e.amount, 0);
}

/**
 * Supplemental earnings (bonus, commission) taxed for federal income tax at the
 * flat supplemental rate rather than through the annualize→bracket path.
 */
export function supplementalEarnings(earnings: readonly Earning[]): Cents {
  return earnings
    .filter((e) => e.category === 'supplemental')
    .reduce((sum, e) => sum + e.amount, 0);
}

/** Earnings actually paid in cash this period — the basis for net pay. */
export function cashEarnings(earnings: readonly Earning[]): Cents {
  return earnings
    .filter((e) => e.category !== 'imputed')
    .reduce((sum, e) => sum + e.amount, 0);
}

export function pretaxTotal(deductions: readonly Deduction[]): Cents {
  return deductions
    .filter((d) => d.category !== null)
    .reduce((sum, d) => sum + d.amount, 0);
}

export function posttaxTotal(deductions: readonly Deduction[]): Cents {
  return deductions
    .filter((d) => d.category === null)
    .reduce((sum, d) => sum + d.amount, 0);
}

/**
 * Build the taxable-wage resolver for one paycheck.
 *
 * Returns a function that, given the set of pre-tax categories a particular
 * tax exempts, produces that tax's own base. Two taxes on the same paycheck
 * routinely see different numbers here — that is the point, not a bug.
 */
export function makeTaxableWagesFn(
  earnings: readonly Earning[],
  deductions: readonly Deduction[],
  options: { housingAllowanceExcluded?: boolean } = {},
): (exempt: readonly PretaxCategory[]) => Cents {
  const gross = taxableEarnings(earnings, options);

  return (exempt) => {
    const exemptSet = new Set(exempt);
    const reduction = deductions
      .filter((d) => d.category !== null && exemptSet.has(d.category))
      .reduce((sum, d) => sum + d.amount, 0);
    return atLeastZero(gross - reduction);
  };
}

export interface ElectiveDeferralLimits {
  /** 401(k) and 403(b) share ONE combined IRC 402(g) limit, in dollars. */
  section402gAggregate: number;
  /** A governmental/tax-exempt 457(b) plan's own SEPARATE limit, in dollars — not aggregated with 401(k)/403(b). */
  deferral457: number;
  /** A SIMPLE plan's own separate, lower limit, in dollars (IRC 408(p)/401(k) SIMPLE). */
  simple: number;
  /** Extra room for an employee who reaches the age by December 31, in dollars. */
  catchUp?: {
    age50: number;
    age60to63: number;
    simpleAge50: number;
    simpleAge60to63: number;
  };
}

/**
 * Catch-up room, in dollars, for the plan family a group belongs to, for an
 * employee who reaches `ageAtYearEnd` by December 31. Zero when the age is
 * unknown, under 50, or the year's data carries no catch-up figures.
 */
function catchUpDollars(
  limits: ElectiveDeferralLimits,
  family: 'standard' | 'simple',
  ageAtYearEnd: number | undefined,
): number {
  const c = limits.catchUp;
  if (!c || ageAtYearEnd === undefined || ageAtYearEnd < 50) return 0;
  const enhanced = ageAtYearEnd >= 60 && ageAtYearEnd <= 63;
  if (family === 'simple') return enhanced ? c.simpleAge60to63 : c.simpleAge50;
  return enhanced ? c.age60to63 : c.age50;
}

interface DeferralGroup {
  categories: readonly PretaxCategory[];
  limitDollars: number;
  ytdKey: keyof NonNullable<YearToDate['electiveDeferrals']>;
}

/**
 * Applied in order, so a SIMPLE deferral is checked against the shared 402(g)
 * limit FIRST (the IRS aggregates "all elective deferrals you made to all
 * plans" — 401(k), 403(b), SARSEP and SIMPLE IRA — under the one 402(g)
 * limit) and then, for what survives, against the SIMPLE plan's own lower
 * limit. Giving SIMPLE a group of its own only, as this once did, let a
 * participant with $20,000 already counted toward the $24,500 limit defer
 * another $10,000 to a SIMPLE as pretax, when $4,500 of room was left.
 */
const DEFERRAL_GROUPS = (
  limits: ElectiveDeferralLimits,
  ageAtYearEnd: number | undefined,
): readonly DeferralGroup[] => [
  { categories: ['deferral_401k', 'deferral_403b', 'deferral_simple'], limitDollars: limits.section402gAggregate + catchUpDollars(limits, 'standard', ageAtYearEnd), ytdKey: 'section402gAggregate' },
  { categories: ['deferral_457'], limitDollars: limits.deferral457 + catchUpDollars(limits, 'standard', ageAtYearEnd), ytdKey: 'deferral457' },
  { categories: ['deferral_simple'], limitDollars: limits.simple + catchUpDollars(limits, 'simple', ageAtYearEnd), ytdKey: 'simple' },
];

/**
 * Caps this period's elective-deferral pretax deductions (401(k)/403(b)/
 * 457/SIMPLE) at their IRC annual limits, given YTD contributions so far
 * at THIS employer. Any amount that would push cumulative YTD deferrals
 * past the applicable limit is reclassified from pretax (category set) to
 * post-tax (category null) — net pay is unaffected either way (the same
 * total dollar amount still leaves the paycheck); only which taxes see
 * the excess as taxable changes, because it no longer legally qualifies
 * as a pretax deferral once the annual ceiling is reached.
 *
 * Limit groups, matching how the IRC actually aggregates them (see
 * ElectiveDeferralLimits' own field comments): 401(k), 403(b) and SIMPLE
 * together under the one 402(g) limit; 457(b) separate; and SIMPLE ALSO under
 * its own lower limit on top of that.
 *
 * Catch-up: when the caller supplies the age the employee reaches by
 * December 31 (employee.ageAtYearEnd), each group's limit grows by the
 * year's catch-up figure — age 50+ gets the ordinary catch-up, ages 60-63
 * the SECURE 2.0 enhanced one. With no age the standard limit applies,
 * because guessing eligibility would risk under-capping (treating money as
 * taxable that the law still exempts is the safe direction to be wrong in;
 * the opposite is not). Not modelled: deferrals at a DIFFERENT employer
 * earlier in the same calendar year, since `ytd` only reflects what THIS
 * employer has paid; the requirement that catch-up be Roth for employees
 * above the prior-year FICA wage threshold; and the 457(b) final-years
 * catch-up. See data/federal/2026.json's knownGaps.
 *
 * Splits a single over-limit deduction into two lines (same code, the
 * post-tax remainder suffixed `_OVER_LIMIT`) rather than recharacterizing
 * the whole thing, so a partially-exempt contribution stays traceable in
 * the result.
 */
export function capElectiveDeferrals(
  deductions: readonly Deduction[],
  ytd: YearToDate['electiveDeferrals'] | undefined,
  limits: ElectiveDeferralLimits,
  ageAtYearEnd?: number,
): Deduction[] {
  let result: Deduction[] = deductions.slice();

  for (const group of DEFERRAL_GROUPS(limits, ageAtYearEnd)) {
    const categorySet = new Set<PretaxCategory>(group.categories);
    const groupTotal = result
      .filter((d) => d.category !== null && categorySet.has(d.category))
      .reduce((sum, d) => sum + d.amount, 0);
    if (groupTotal === 0) continue;

    const ytdSoFar = ytd?.[group.ytdKey] ?? 0;
    const room = atLeastZero(dollars(group.limitDollars) - ytdSoFar);
    if (groupTotal <= room) continue;

    let remainingRoom = room;
    result = result.flatMap((d) => {
      if (d.category === null || !categorySet.has(d.category)) return [d];
      const pretaxPart = Math.min(d.amount, remainingRoom);
      remainingRoom -= pretaxPart;
      const overLimitPart = d.amount - pretaxPart;
      if (overLimitPart === 0) return [d];
      const lines: Deduction[] = [];
      if (pretaxPart > 0) lines.push({ ...d, amount: pretaxPart });
      lines.push({ code: `${d.code}_OVER_LIMIT`, category: null, amount: overLimitPart });
      return lines;
    });
  }

  return result;
}
