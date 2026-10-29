import type { Cents } from '../money.ts';
import { fmt, roundHalfUp, toWholeDollars } from '../money.ts';
import type { StatePensionEntry, StatePensionMethod } from '../registry.ts';
import { CannotComputeError, hasStateRuleset, stateRuleset, statePensionRules } from '../registry.ts';
import type { ComputeContext, PaycheckInput, StateCertificate, TaxLine } from '../types.ts';
import { PERIODS_PER_YEAR } from '../types.ts';
import { makeTaxableWagesFn } from '../wages.ts';
import { stateIncomeTax } from './state.ts';

/**
 * State income tax withholding on a pension, annuity or IRA payment.
 *
 * States differ more here than on wages: some require withholding unless the payee opts out, some
 * never require it and only withhold when asked, some follow the federal election, and a few
 * withhold on pensions "as on wages" with the payee's own state form. The rules are data, each with
 * the state agency document it was read from (data/pension/state-withholding-<year>.json). A state
 * that is not in that file, or is marked not_modelled, produces no line and a warning that says so;
 * silence would look like "no tax".
 *
 * Only the payee's own state ever withholds: 4 U.S.C. 114 bars a state from taxing a nonresident's
 * retirement income, so the state is the payee's residence (residenceState, else workState).
 */

export interface StatePensionResult {
  lines: TaxLine[];
  warnings: string[];
}

type Kind = 'periodic' | 'nonperiodic' | 'eligibleRollover';

const ZERO_YTD = { socialSecurity: 0, medicare: 0, futa: 0 };

function federalOptedOut(input: PaycheckInput): boolean {
  const p = input.pension!;
  if (p.deliveredOutsideUS) return false;
  if (p.kind === 'periodic') return Boolean(p.w4p?.noWithholding);
  if (p.kind === 'nonperiodic') return p.w4r?.withholdingRate === 0;
  return false; // an eligible rollover distribution cannot be opted out of
}

/** The state's income tax on `taxable`, figured as on wages with the given certificate. */
function wageMethodAmount(input: PaycheckInput, code: string, taxable: Cents, certificate: Record<string, unknown>): { amount: Cents; detail: string } {
  const pseudo: PaycheckInput = {
    checkDate: input.checkDate,
    payFrequency: input.payFrequency,
    earnings: [{ code: 'PENSION', category: 'regular', amount: taxable }],
    deductions: [],
    federalW4: { filingStatus: 'single', multipleJobs: false, dependentCredit: 0, otherIncome: 0, deductions: 0, extraWithholding: 0 },
    ytd: ZERO_YTD,
    workState: { code, certificate: certificate as StateCertificate },
  };
  const ctx: ComputeContext = {
    year: Number(input.checkDate.slice(0, 4)),
    periodsPerYear: PERIODS_PER_YEAR[input.payFrequency],
    taxableWagesFor: makeTaxableWagesFn(pseudo.earnings, [], { housingAllowanceExcluded: false }),
  };
  const line = stateIncomeTax(pseudo, ctx).find((l) => l.id === `${code}_SIT`);
  if (!line) throw new CannotComputeError(`${code} withholding on pension payments as on wages produced no income tax line.`);
  if (/NOT MODELLED/i.test(line.detail)) throw new CannotComputeError(line.detail);
  return { amount: line.amount, detail: line.detail };
}

export function statePensionLines(input: PaycheckInput, taxable: Cents, federalAmount: Cents): StatePensionResult {
  const pension = input.pension!;
  const warnings: string[] = [];
  const none = (w: string): StatePensionResult => ({ lines: [], warnings: [w] });

  const rules = statePensionRules(input.checkDate);
  const code = (input.residenceState?.code ?? input.workState?.code)?.toUpperCase();
  if (!code) {
    return none('No state was sent, so no state income tax was calculated. Send the payee\'s state as residenceState (or workState).');
  }
  if (!rules) {
    return none(`State income tax withholding on pension payments is not calculated for ${input.checkDate.slice(0, 4)}: those rules have not been checked for that year.`);
  }
  const entry: StatePensionEntry | undefined = rules.states[code];
  if (!entry) {
    if (hasStateRuleset(code, input.checkDate) && stateRuleset(code, input.checkDate).method === 'no_income_tax') {
      return { lines: [], warnings: [`${code} has no state income tax on wages, so none is withheld from this payment.`] };
    }
    return none(`State income tax withholding on pension payments is not calculated for ${code}: that state's rule has not been checked against its revenue agency's guidance.`);
  }
  if (entry.status === 'not_modelled') {
    return none(`State income tax withholding on pension payments is not calculated for ${code}: ${entry.reason}`);
  }

  const kind: Kind = pension.kind === 'eligible_rollover' ? 'eligibleRollover' : pension.kind;
  const election = pension.stateElection ?? {};
  const electable = new Set(entry.electable ?? []);
  const optOutAllowed = Boolean(entry.optOut?.[kind]) && !(entry.entireBalanceNoOptOut && pension.entireAccountBalance);
  const refuse = (msg: string): never => {
    throw new CannotComputeError(`${code} ${msg}`);
  };

  // What the payee chose, checked against what the state lets a payee choose.
  const chosen = [election.none && 'none', election.percent !== undefined && 'percent', election.amount !== undefined && 'amount', election.certificate && 'certificate'].filter(Boolean);
  if (chosen.length > 1) refuse(`state election can use only one of none, percent, amount or certificate (got ${chosen.join(', ')}).`);
  // A state that withholds nothing by default has nothing to opt out of: accept the choice and say so.
  const defaultIsNone = entry.status !== 'required' || entry[kind]?.kind === 'none';
  if (election.none && !defaultIsNone && !optOutAllowed) {
    refuse(`does not let a payee opt out of withholding on ${kind === 'eligibleRollover' ? 'an eligible rollover distribution' : kind === 'periodic' ? 'periodic payments' : 'this kind of payment'}${entry.entireBalanceNoOptOut && pension.entireAccountBalance ? ' of the entire account balance' : ''}.`);
  }
  if (election.percent !== undefined) {
    if (!electable.has('percent')) refuse('does not let a payee choose a percentage.');
    if (entry.percentChoices && !entry.percentChoices.includes(election.percent)) refuse(`allows only these percentages: ${entry.percentChoices.join(', ')}.`);
    if (!(election.percent > 0 && election.percent <= 100)) refuse('percent must be greater than 0 and at most 100.');
  }
  if (election.amount !== undefined && !electable.has('amount')) refuse('does not let a payee name a dollar amount.');
  if (election.certificate && !electable.has('certificate')) refuse('does not use a payee withholding certificate for pension payments.');
  if (election.additionalAmount !== undefined && !(electable.has('additionalAmount') || electable.has('percent') || electable.has('amount'))) refuse('does not let a payee add an extra amount.');
  for (const [name, v] of [['amount', election.amount], ['additionalAmount', election.additionalAmount]] as const) {
    if (v !== undefined && (!Number.isInteger(v) || v < 0)) refuse(`${name} must be whole cents, zero or more.`);
  }

  const asked = election.percent !== undefined || election.amount !== undefined;
  const label = `${code} Income Tax (pension/annuity)`;
  const finish = (amount: Cents, detail: string, extra: string[] = []): StatePensionResult => {
    const total = amount + (election.additionalAmount ?? 0);
    const out = input.roundToWholeDollars ? toWholeDollars(total) : total;
    const line: TaxLine = {
      id: `${code}_PENSION_SIT`,
      name: label,
      payer: 'employee',
      jurisdiction: 'state',
      taxableWages: taxable,
      amount: out,
      detail: detail + (election.additionalAmount ? `; plus extra ${fmt(election.additionalAmount)}` : '') + `. Source: ${entry.sources?.[0]?.title ?? 'state agency guidance'}`,
    };
    return { lines: [line], warnings: extra };
  };

  // Withholding the state does not require.
  if (entry.status === 'not_required') {
    return { lines: [], warnings: [`${code} does not withhold income tax on pension payments. ${entry.notes ?? ''}`.trim()] };
  }
  if (election.none) return { lines: [], warnings: [`No ${code} income tax withheld: ${defaultIsNone ? `${code} withholds on this kind of payment only when the payee asks` : 'the payee opted out'}.`] };

  if (asked && election.percent !== undefined) {
    return finish(roundHalfUp((taxable * election.percent) / 100), `Payee chose ${election.percent}% of the taxable ${fmt(taxable)}`);
  }
  if (election.amount !== undefined) {
    return finish(election.amount, `Payee chose a fixed ${fmt(election.amount)} per payment`);
  }

  let method: StatePensionMethod = entry[kind] ?? { kind: 'not_modelled', reason: 'no rule for this kind of payment' };
  if (method.kind === 'percent' && method.onlyWhen === 'entireAccountBalance' && !pension.entireAccountBalance) method = method.otherwise ?? { kind: 'none' };

  if (entry.status === 'election_only') {
    // The payee asked for nothing: nothing is withheld, and the result says the state would withhold on request.
    const extra = election.additionalAmount ? finish(0, 'Extra amount the payee asked for').lines : [];
    return { lines: extra, warnings: [`${code} withholds on pension payments only when the payee asks. ${entry.notes ?? ''} Nothing was withheld; send pension.stateElection to ask for it.`.replace(/\s+/g, ' ')] };
  }

  if (method.kind === 'not_modelled') return none(`State income tax withholding on this payment is not calculated for ${code}: ${method.reason}`);

  // Conditions under which a required state does not withhold.
  if (entry.gate === 'federal_required' && federalOptedOut(input)) {
    return { lines: [], warnings: [`No ${code} income tax withheld: ${code} follows the federal election and the payee opted out of federal withholding.`] };
  }
  if (entry.gate === 'iowa_exclusion') {
    const age = input.employee?.ageAtYearEnd;
    const excluded = (age !== undefined && age >= 55) || election.retirementExclusion;
    if (federalOptedOut(input)) return { lines: [], warnings: ['No IA income tax withheld: Iowa withholding is required only where federal withholding is, and the payee opted out of federal withholding.'] };
    if (excluded) return { lines: [], warnings: ['No IA income tax withheld: the payee qualifies for Iowa\'s retirement-income exclusion (age 55 or older, disabled, or a surviving spouse). Send stateElection.percent to withhold anyway.'] };
    if (age === undefined && !election.retirementExclusion) warnings.push('Iowa does not require withholding for a payee who is 55 or older, disabled, or a surviving spouse. Send employee.ageAtYearEnd (or stateElection.retirementExclusion) if that applies; 3.8% was withheld.');
  }

  const useCertificate = election.certificate && (electable.has('certificate')) && (kind === 'periodic' || code === 'CA');
  if (method.kind === 'none') return { lines: [], warnings: [`No ${code} income tax withheld on this kind of payment.`] };

  if (useCertificate && code === 'CA') {
    // California's own schedules with the payee's DE 4P filing status and allowances.
    const r = wageMethodAmount(input, code, taxable, election.certificate as Record<string, unknown>);
    return finish(r.amount, `Payee's DE 4P: ${r.detail}`, warnings);
  }
  if (method.kind === 'percent' && method.whenCertificate === 'wage_method' && useCertificate) {
    const r = wageMethodAmount(input, code, taxable, election.certificate as Record<string, unknown>);
    return finish(r.amount, `Payee's state certificate: ${r.detail}`, warnings);
  }
  if (method.kind === 'percent') {
    return finish(roundHalfUp((taxable * method.percent) / 100), `${method.percent}% of the taxable ${fmt(taxable)} (${code}'s rate when the payee has given no other instruction)`, warnings);
  }
  if (method.kind === 'percent_of_federal') {
    return finish(roundHalfUp((federalAmount * method.percent) / 100), `${method.percent}% of the ${fmt(federalAmount)} withheld federally`, warnings);
  }
  if (method.kind === 'wage_method') {
    const cert = { ...method.certificate, ...(useCertificate ? (election.certificate as Record<string, unknown>) : {}) };
    const r = wageMethodAmount(input, code, taxable, cert);
    return finish(r.amount, `${useCertificate ? 'Payee\'s state certificate' : 'No state certificate; the state\'s default'}: ${r.detail}`, warnings);
  }
  return none(`State income tax withholding on this payment is not calculated for ${code}.`);
}
