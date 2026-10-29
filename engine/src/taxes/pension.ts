import type { Cents } from '../money.ts';
import { atLeastZero, dollars, fmt, roundHalfUp, toWholeDollars } from '../money.ts';
import type { Bracket, FederalRuleset } from '../registry.ts';
import { CannotComputeError, federalRuleset } from '../registry.ts';
import type { FilingStatus, PaycheckInput, PaycheckResult, TaxLine } from '../types.ts';
import { PERIODS_PER_YEAR } from '../types.ts';
import { cashEarnings, posttaxTotal } from '../wages.ts';
import { statePensionLines } from './pension-state.ts';

/**
 * Federal income tax withholding on pension, annuity, profit-sharing, stock-bonus and IRA payments.
 *
 * Periodic payments follow Publication 15-T (2026) Worksheet 1B, driven by Form W-4P. Nonperiodic
 * payments and eligible rollover distributions follow Form W-4R. Line numbers in the comments map
 * to Worksheet 1B so the code can be diffed against the published form each year.
 *
 * What differs from wages: there is no FICA, FUTA or unemployment tax; the Worksheet 1B standard
 * adjustment (line 1g) always applies, with no multiple-jobs checkbox; the credit in Step 3 comes off
 * the annual tax before it is divided into payments (a wage paycheck divides first); and a payee
 * with no Form W-4P is Single with no entries. State and local withholding is not calculated: states
 * differ on whether and how they withhold on pensions, and the result says so.
 */

function scheduleKey(status: FilingStatus): string {
  return status === 'married_separate' ? 'single' : status;
}

function findBracket(schedule: Bracket[], annual: Cents): Bracket {
  for (const b of schedule) {
    const from = dollars(b.from);
    const to = b.to === null ? Infinity : dollars(b.to);
    if (annual >= from && annual < to) return b;
  }
  return schedule[schedule.length - 1]!;
}

/** Worksheet 1B lines 2e-2j (also 2n-2s): the annual tax from the STANDARD schedule for an amount. */
function annualTax(schedule: Bracket[], amount: Cents): Cents {
  const bracket = findBracket(schedule, amount);
  return dollars(bracket.base) + roundHalfUp((amount - dollars(bracket.from)) * bracket.rate);
}

const wholePercent = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 100;

function periodicLine(input: PaycheckInput, rules: FederalRuleset, taxable: Cents): { amount: Cents; detail: string } {
  const pension = input.pension!;
  const cfg = rules.incomeTax;
  const p = pension.w4p ?? {};
  const periods = PERIODS_PER_YEAR[input.payFrequency];
  const allowed = rules.pensionWithholding!.periodicPaymentFrequencies;
  if (!allowed.includes(input.payFrequency)) {
    throw new CannotComputeError(
      `Periodic pension payments paid ${input.payFrequency} cannot be withheld here: Pub 15-T Table 4 lists ${allowed.join(', ')} only.`,
    );
  }

  if (p.noWithholding && !pension.deliveredOutsideUS) {
    return { amount: 0, detail: 'Payee elected no federal income tax withholding on Form W-4P' };
  }
  const ignoredElection = Boolean(p.noWithholding && pension.deliveredOutsideUS);
  const note = ignoredElection ? 'No-withholding election not honored: the payment is delivered outside the United States and its territories; ' : '';
  // A payee who elected none but cannot is withheld as Single with no entries.
  const form = ignoredElection ? ('2022_or_later' as const) : (p.form ?? '2022_or_later');
  const entries = ignoredElection ? {} : p;

  const annualPayment = taxable * periods; // 1c
  let adjusted: Cents; // 1i or 1l
  let status: FilingStatus;
  let credits = 0;
  let step2: Cents = 0;
  let extra: Cents;
  let formLabel: string;

  if (form === '2021_or_earlier') {
    const allowances = entries.allowances ?? 0;
    if (!Number.isInteger(allowances) || allowances < 0 || allowances > 99) {
      throw new Error(`pension.w4p.allowances must be a whole number from 0 to 99, got ${JSON.stringify(allowances)}.`);
    }
    status = entries.maritalStatus === 'married' ? 'married_joint' : 'single';
    adjusted = atLeastZero(annualPayment - allowances * dollars(cfg.legacyW4!.allowanceAmount)); // 1k, 1l
    extra = entries.extraWithholding ?? 0; // line 3
    formLabel = `2021-or-earlier Form W-4P (${entries.maritalStatus ?? 'single'}, ${allowances} allowance(s))`;
  } else {
    status = entries.filingStatus ?? 'single';
    const standardAdj = dollars(status === 'married_joint' ? cfg.step1StandardAdjustment.married_joint : cfg.step1StandardAdjustment.other); // 1g
    adjusted = annualPayment + (entries.otherIncome ?? 0) - ((entries.deductions ?? 0) + standardAdj); // 1d-1i; may be negative
    credits = entries.credits ?? 0; // 3a
    step2 = entries.multiplePensionsAmount ?? 0; // Step 2(b)(iii)
    extra = entries.extraWithholding ?? 0; // 4b
    formLabel = pension.w4p ? `2022-or-later Form W-4P (${status})` : 'no Form W-4P (treated as Single, no entries)';
  }
  const schedule = cfg.standardSchedules[scheduleKey(status)];
  if (!schedule) throw new Error(`No federal schedule for filing status "${status}"`);

  let tentative: Cents; // 2u
  if (form === '2022_or_later' && step2 !== 0) {
    // Parts I, II and III: the extra withholding that the other jobs and lower-paying pensions call for.
    const standardAdj = dollars(status === 'married_joint' ? cfg.step1StandardAdjustment.married_joint : cfg.step1StandardAdjustment.other);
    const part1 = annualTax(schedule, atLeastZero(step2 - standardAdj)); // 2a-2j
    const part2 = annualTax(schedule, atLeastZero(step2 + adjusted)); // 2k-2s
    tentative = atLeastZero(part2 - part1); // 2t, 2u
  } else {
    tentative = annualTax(schedule, atLeastZero(adjusted)); // 2d-2j, 2u
  }

  const afterCredits = atLeastZero(tentative - credits); // 3b
  const perPayment = roundHalfUp(afterCredits / periods); // 4a
  const amount = perPayment + extra; // 4c
  const detail =
    note +
    `${formLabel}; Pub 15-T Worksheet 1B: annualised ${fmt(annualPayment)} → adjusted ${fmt(adjusted)}` +
    (step2 !== 0 ? `, other jobs and pensions ${fmt(step2)} (Step 2 Parts I-III)` : '') +
    `; tentative/yr ${fmt(tentative)}` +
    (credits ? ` less credits ${fmt(credits)}` : '') +
    ` ÷ ${periods}` +
    (extra ? `; plus extra ${fmt(extra)}` : '');
  return { amount, detail };
}

function rateLine(input: PaycheckInput, rules: FederalRuleset, taxable: Cents): { amount: Cents; detail: string } {
  const pension = input.pension!;
  const cfg = rules.pensionWithholding!;
  const rollover = pension.kind === 'eligible_rollover';
  const chosen = pension.w4r?.withholdingRate;
  if (chosen !== undefined && !wholePercent(chosen)) {
    throw new Error(`pension.w4r.withholdingRate must be a whole-number percent from 0 to 100 (Form W-4R line 2), got ${JSON.stringify(chosen)}.`);
  }
  const base = rollover ? cfg.eligibleRolloverDefaultRate : cfg.nonperiodicDefaultRate;
  const basePct = Math.round(base * 100);
  let pct = chosen ?? basePct;
  let why = chosen === undefined ? `default ${basePct}% (no Form W-4R)` : `${chosen}% chosen on Form W-4R`;
  // The default is a floor for an eligible rollover, and for a nonperiodic payment delivered abroad.
  if (chosen !== undefined && chosen < basePct && (rollover || pension.deliveredOutsideUS)) {
    pct = basePct;
    why = `${basePct}% (Form W-4R rate of ${chosen}% not honored: ${rollover ? 'an eligible rollover distribution cannot be withheld below 20%' : 'payments delivered outside the United States and its territories cannot be withheld below 10%'})`;
  }
  const amount = roundHalfUp((taxable * pct) / 100);
  const kind = rollover ? 'Eligible rollover distribution' : 'Nonperiodic payment';
  return { amount, detail: `${kind}: ${why} of the taxable ${fmt(taxable)}` };
}

export function calculatePension(input: PaycheckInput): PaycheckResult {
  const pension = input.pension!;
  const rules = federalRuleset(input.checkDate);
  if (!rules.pensionWithholding) {
    throw new CannotComputeError(`Pension and annuity withholding is not available for ${rules.year}: that year's federal data has not been checked against the IRS forms.`);
  }
  if (!['periodic', 'nonperiodic', 'eligible_rollover'].includes(pension.kind)) {
    throw new Error(`pension.kind must be "periodic", "nonperiodic" or "eligible_rollover", got ${JSON.stringify(pension.kind)}.`);
  }
  if (input.deductions.some((d) => d.category !== null)) {
    throw new Error('A pension payment takes no pre-tax deductions. Send only post-tax deductions (category null).');
  }
  if (input.employmentCategory && input.employmentCategory !== 'standard') {
    throw new Error('pension cannot be combined with an employmentCategory other than "standard".');
  }
  if ((input.federalW4 as { nonresidentAlien?: boolean } | undefined)?.nonresidentAlien) {
    throw new CannotComputeError('The pension withholding methods do not apply to nonresident aliens and foreign estates (Pub 515).');
  }

  const gross = cashEarnings(input.earnings);
  const taxable = pension.taxableAmount ?? gross;
  if (!Number.isInteger(taxable) || taxable < 0 || taxable > gross) {
    throw new Error(`pension.taxableAmount must be whole cents between 0 and the payment (${gross}), got ${JSON.stringify(taxable)}.`);
  }

  const { amount, detail } = pension.kind === 'periodic' ? periodicLine(input, rules, taxable) : rateLine(input, rules, taxable);
  const withheld = input.roundToWholeDollars ? toWholeDollars(amount) : amount;
  const line: TaxLine = {
    id: 'US_FIT_PENSION',
    name: 'Federal Income Tax (pension/annuity)',
    payer: 'employee',
    jurisdiction: 'federal',
    taxableWages: taxable,
    amount: withheld,
    detail,
  };
  const posttax = posttaxTotal(input.deductions);
  const state = statePensionLines(input, taxable, withheld);
  const taxes = [line, ...state.lines];
  const employeeTaxTotal = taxes.reduce((sum, t) => sum + t.amount, 0);
  const netPay = gross - posttax - employeeTaxTotal;
  const warnings = [...state.warnings, 'Local income tax withholding on pension payments is not calculated.'];
  if (netPay < 0) {
    warnings.push(`Withholding and deductions are $${(-netPay / 100).toFixed(2)} more than the payment. Net pay is negative; nothing was reduced automatically.`);
  }
  return {
    checkDate: input.checkDate,
    grossPay: gross,
    pretaxDeductions: 0,
    posttaxDeductions: posttax,
    taxes,
    employeeTaxTotal,
    employerTaxTotal: 0,
    netPay,
    warnings,
  };
}
