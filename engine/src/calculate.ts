import { toWholeDollars } from './money.ts';

/**
 * IRS whole-dollar rounding is for withheld income tax. FICA, FUTA, SUTA,
 * disability, paid leave, transit excise, and flat head taxes stay in cents.
 */
function isWithheldIncomeTax(id: string): boolean {
  if (id === 'US_FIT' || id === 'US_FIT_SUPP') return true;
  if (id.includes('_SIT')) return true;
  return (
    id.endsWith('_COUNTY') ||
    id === 'PA_EIT' ||
    id === 'MI_LOCAL' ||
    id === 'OH_LOCAL' ||
    id === 'OH_JEDD' ||
    id === 'OH_SDIT' ||
    id === 'KY_LOCAL' ||
    id === 'AL_LOCAL' ||
    id === 'WILMINGTON_WAGE' ||
    id === 'KC_EARN' ||
    id === 'STL_EARN' ||
    id === 'OR_METRO_SHS' ||
    id === 'OR_MULTNOMAH_PFA'
  );
}
import { PERIODS_PER_YEAR } from './types.ts';
import type {
  ComputeContext,
  DataNotice,
  PaycheckInput,
  PaycheckResult,
  TaxLine,
} from './types.ts';
import { assertTaxYearCovered, CannotComputeError, federalRuleset, provisionalYearWarnings, yearOf } from './registry.ts';
import { federalTaxes } from './taxes/federal.ts';
import { calculatePension } from './taxes/pension.ts';
import { stateIncomeTax } from './taxes/state.ts';
import { inputContractWarnings } from './contracts.ts';
import { assertEmploymentCategory } from './validate.ts';
import {
  capElectiveDeferrals,
  cashEarnings,
  makeTaxableWagesFn,
  posttaxTotal,
  pretaxTotal,
} from './wages.ts';

/**
 * Gross-to-net for a single paycheck.
 *
 * The driver knows nothing about specific taxes. It builds the context —
 * notably the per-tax taxable-wage resolver — and lets each rule declare its
 * own base, so a new jurisdiction never requires editing this function.
 */
export function calculatePaycheck(input: PaycheckInput): PaycheckResult {
  const periodsPerYear = PERIODS_PER_YEAR[input.payFrequency];
  if (!periodsPerYear) {
    throw new Error(`Unknown pay frequency: ${input.payFrequency}`);
  }
  if (input.pension) return calculatePension(input);
  assertEmploymentCategory(input.employmentCategory);
  // 2025 is covered for federal tax and only some states; a paycheck
  // touching any other state that year is refused, not computed federal-only.
  assertTaxYearCovered(input.checkDate, [input.workState?.code, input.residenceState?.code]);

  // Cap 401(k)/403(b)/457/SIMPLE deductions at their IRC annual elective-
  // deferral limits before ANY tax reads the deduction list — see
  // capElectiveDeferrals()'s own doc comment in wages.ts. Net pay is
  // unaffected (the same total dollar amount still leaves the paycheck);
  // this only changes which taxes see an over-limit amount as taxable.
  const age = input.employee?.ageAtYearEnd;
  if (age !== undefined && (!Number.isInteger(age) || age < 0 || age > 120)) {
    throw new Error(
      `employee.ageAtYearEnd must be a whole number of years from 0 to 120 (the age the employee reaches by December 31), got ${JSON.stringify(age)}.`,
    );
  }
  const effectiveDeductions = capElectiveDeferrals(
    input.deductions,
    input.ytd.electiveDeferrals,
    federalRuleset(input.checkDate).electiveDeferralLimits,
    age,
  );
  const cappedDeferral = effectiveDeductions.some((d) => d.code.endsWith('_OVER_LIMIT'));

  const ctx: ComputeContext = {
    year: yearOf(input.checkDate),
    periodsPerYear,
    taxableWagesFor: makeTaxableWagesFn(input.earnings, effectiveDeductions, {
      // A designated housing allowance leaves the tax base only for a
      // minister — see EarningCategory's own doc comment.
      housingAllowanceExcluded: input.employmentCategory === 'clergy',
    }),
  };

  let taxes: TaxLine[];
  try {
    taxes = [...federalTaxes(input, ctx), ...stateIncomeTax(input, ctx)];
  } catch (err) {
    // Rules throw "... cannot compute X" when the agency publishes no method
    // for this input. Give those a type so callers can show the reason.
    if (err instanceof Error && !(err instanceof CannotComputeError) && /cannot compute/i.test(err.message)) {
      throw new CannotComputeError(err.message);
    }
    throw err;
  }

  if (input.roundToWholeDollars) {
    taxes = taxes.map((t) =>
      isWithheldIncomeTax(t.id) ? { ...t, amount: toWholeDollars(t.amount) } : t,
    );
  }

  const employeeTaxTotal = taxes
    .filter((t) => t.payer === 'employee')
    .reduce((sum, t) => sum + t.amount, 0);
  const employerTaxTotal = taxes
    .filter((t) => t.payer === 'employer')
    .reduce((sum, t) => sum + t.amount, 0);

  const gross = cashEarnings(input.earnings);
  const pretax = pretaxTotal(effectiveDeductions);
  const posttax = posttaxTotal(effectiveDeductions);

  const netPay = gross - pretax - posttax - employeeTaxTotal;
  const warnings: string[] = [
    ...inputContractWarnings(input),
    ...provisionalYearWarnings(input.checkDate, [input.workState?.code, input.residenceState?.code]),
  ];
  if (cappedDeferral && age === undefined) {
    warnings.push(
      `A retirement deferral reached the standard annual limit, so the excess was taxed as ordinary pay. ` +
        `If this employee reaches age 50 or more by December 31, send employee.ageAtYearEnd to apply the catch-up limit.`,
    );
  }
  if (netPay < 0) {
    warnings.push(
      `Taxes and deductions are $${(-netPay / 100).toFixed(2)} more than this paycheck. ` +
        `Net pay is negative; nothing was dropped or reduced automatically. ` +
        `Reduce a deduction or withholding election, or pay the difference another way.`,
    );
  }

  // The deferrals that stayed pretax, bucketed the way ytd.electiveDeferrals
  // is: 401(k), 403(b) and SIMPLE share the 402(g) total, SIMPLE also has its
  // own, and 457(b) is separate.
  const deferred = (...categories: string[]) =>
    effectiveDeductions.filter((d) => d.category !== null && categories.includes(d.category)).reduce((sum, d) => sum + d.amount, 0);
  const deferrals = {
    section402gAggregate: deferred('deferral_401k', 'deferral_403b', 'deferral_simple'),
    deferral457: deferred('deferral_457'),
    simple: deferred('deferral_simple'),
  };
  const electiveDeferrals = Object.fromEntries(Object.entries(deferrals).filter(([, v]) => v > 0)) as NonNullable<PaycheckResult['electiveDeferrals']>;

  return {
    checkDate: input.checkDate,
    grossPay: gross,
    ...(Object.keys(electiveDeferrals).length ? { electiveDeferrals } : {}),
    pretaxDeductions: pretax,
    posttaxDeductions: posttax,
    taxes,
    employeeTaxTotal,
    employerTaxTotal,
    // Employer taxes are a cost to the employer, never a reduction of net pay.
    netPay,
    ...noticesFor(taxes),
    ...(warnings.length ? { warnings } : {}),
  };
}

/** Every data-quality-marked line, lifted to the result so it can't be missed. */
function noticesFor(taxes: TaxLine[]): { notices?: DataNotice[] } {
  const notices = taxes
    .filter((t) => t.dataQuality)
    .map((t) => ({ taxId: t.id, ...t.dataQuality! }));
  return notices.length ? { notices } : {};
}
