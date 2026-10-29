import type { Cents } from '../src/money.ts';
import type { PretaxCategory } from '../src/types.ts';
import type { Company, DeductionPlan, Employee, PayRun, PayRunLine } from './types.ts';

/**
 * Turns a quarter's or a year's worth of APPROVED pay runs into the actual
 * filings a payroll company owes: the quarterly Form 941 liability figures,
 * and an employee's annual W-2 box figures. Both are pure aggregations over
 * already-computed pay_run_line data — no new tax logic lives here, only
 * the IRS's own definition of which lines roll into which box, so a wrong
 * number here is a wrong ROLLUP, never a wrong CALCULATION (that stays the
 * tax engine's job).
 *
 * SCOPE, stated plainly: this computes the LIABILITY figures Form 941 and
 * Form 940 themselves report and the core W-2 boxes (1-6, 10, 12, 15-20).
 * It does NOT prepare a filable return or PDF, does not handle Form 941's
 * credits/adjustments (COBRA premium assistance, sick/family leave credits
 * under FFCRA-successor provisions, the research credit payroll offset —
 * none of which this engine's PaycheckInput models an input for), and does
 * not e-file anything. Those are real, separate pieces of a filing
 * subsystem, not corners cut in this one.
 */

function quarterMonths(quarter: 1 | 2 | 3 | 4): [number, number, number] {
  const first = (quarter - 1) * 3 + 1;
  return [first, first + 1, first + 2];
}

function inQuarter(checkDate: string, year: number, quarter: 1 | 2 | 3 | 4): boolean {
  const [y, m] = checkDate.split('-').map(Number);
  if (y !== year) return false;
  const [m1, m2, m3] = quarterMonths(quarter);
  return m === m1 || m === m2 || m === m3;
}

function sumTaxLine(line: PayRunLine, id: string, field: 'taxableWages' | 'amount'): Cents {
  const found = line.taxLines.find((t) => t.id === id);
  return found ? found[field] : 0;
}

export interface Form941Summary {
  companyId: string;
  year: number;
  quarter: 1 | 2 | 3 | 4;
  /** Line 1: headcount for the pay period that includes the 12th of the quarter's LAST month — the one figure Form 941 itself asks for, not a monthly breakdown. Null when no approved run's period covers that date. */
  numberOfEmployees: number | null;
  /** Line 2: wages, tips and other compensation subject to federal income tax withholding — US_FIT + US_FIT_SUPP taxableWages, which is the true taxable figure whether or not any tax was actually withheld from it. */
  wagesTipsOtherCompensation: Cents;
  /** Line 3: federal income tax actually withheld. */
  federalIncomeTaxWithheld: Cents;
  /** Line 5a, column 1. */
  taxableSocialSecurityWages: Cents;
  /** Line 5a, column 2 — the COMBINED employee + employer 12.4%. */
  socialSecurityTax: Cents;
  /** Line 5c, column 1. */
  taxableMedicareWages: Cents;
  /** Line 5c, column 2 — the combined employee + employer 2.9%. */
  medicareTax: Cents;
  /** Line 5d, column 1 — wages actually subject to the 0.9% surtax this quarter. */
  taxableAdditionalMedicareWages: Cents;
  /** Line 5d, column 2 — employee-only, employer has no matching share. */
  additionalMedicareTaxWithheld: Cents;
  /** Line 6: total taxes before adjustments — this engine's credits/adjustments scope note applies, see this module's own header comment. */
  totalTaxesBeforeAdjustments: Cents;
}

/**
 * `approvedRuns` should be every APPROVED run for this company; runs
 * outside the requested quarter (by check date, the date wages were
 * actually paid — the basis Form 941 itself reports on) are filtered out
 * here, so a caller can safely pass a company's entire run history.
 */
export function computeForm941(
  companyId: string,
  year: number,
  quarter: 1 | 2 | 3 | 4,
  approvedRuns: readonly PayRun[],
): Form941Summary {
  const runsInQuarter = approvedRuns.filter(
    (r) => r.companyId === companyId && r.status === 'approved' && inQuarter(r.checkDate, year, quarter),
  );

  let wagesTipsOtherCompensation = 0;
  let federalIncomeTaxWithheld = 0;
  let taxableSocialSecurityWages = 0;
  let socialSecurityTax = 0;
  let taxableMedicareWages = 0;
  let medicareTax = 0;
  let taxableAdditionalMedicareWages = 0;
  let additionalMedicareTaxWithheld = 0;

  for (const run of runsInQuarter) {
    for (const line of run.lines) {
      wagesTipsOtherCompensation += sumTaxLine(line, 'US_FIT', 'taxableWages') + sumTaxLine(line, 'US_FIT_SUPP', 'taxableWages');
      federalIncomeTaxWithheld += sumTaxLine(line, 'US_FIT', 'amount') + sumTaxLine(line, 'US_FIT_SUPP', 'amount');
      // SS/Medicare taxable wages: read off the EMPLOYEE line only (US_SS_EE,
      // US_MED_EE) even though the employer line reports the identical
      // figure (see payroll/ytd.ts's own dedup header comment) — reading
      // both would double the column-1 wage figure, not just column 2.
      taxableSocialSecurityWages += sumTaxLine(line, 'US_SS_EE', 'taxableWages');
      socialSecurityTax += sumTaxLine(line, 'US_SS_EE', 'amount') + sumTaxLine(line, 'US_SS_ER', 'amount');
      taxableMedicareWages += sumTaxLine(line, 'US_MED_EE', 'taxableWages');
      medicareTax += sumTaxLine(line, 'US_MED_EE', 'amount') + sumTaxLine(line, 'US_MED_ER', 'amount');
      taxableAdditionalMedicareWages += sumTaxLine(line, 'US_MED_ADDL', 'taxableWages');
      additionalMedicareTaxWithheld += sumTaxLine(line, 'US_MED_ADDL', 'amount');
    }
  }

  const lastMonth = quarterMonths(quarter)[2];
  const twelfth = `${year}-${String(lastMonth).padStart(2, '0')}-12`;
  const headcountRun = runsInQuarter.find((r) => r.periodStart <= twelfth && twelfth <= r.periodEnd);

  return {
    companyId,
    year,
    quarter,
    numberOfEmployees: headcountRun ? headcountRun.lines.length : null,
    wagesTipsOtherCompensation,
    federalIncomeTaxWithheld,
    taxableSocialSecurityWages,
    socialSecurityTax,
    taxableMedicareWages,
    medicareTax,
    taxableAdditionalMedicareWages,
    additionalMedicareTaxWithheld,
    totalTaxesBeforeAdjustments:
      federalIncomeTaxWithheld + socialSecurityTax + medicareTax + additionalMedicareTaxWithheld,
  };
}

/** Deduction-plan pretax categories that get their own W-2 box 12 code. Section 125/FSA/commuter deliberately have NO entry: those reduce box 1/3/5 already and the IRS does not require (or in FSA's case, define) a separate box 12 code for them the way it does for a retirement deferral or an HSA contribution. */
const BOX12_CODE_BY_PRETAX_CATEGORY: Partial<Record<PretaxCategory, string>> = {
  deferral_401k: 'D',
  deferral_403b: 'E',
  deferral_457: 'G',
  deferral_simple: 'S',
  hsa: 'W',
};

export interface W2StateWages {
  state: string;
  wages: Cents;
  incomeTaxWithheld: Cents;
}

export interface W2LocalWages {
  /** The tax line's own human-readable name (e.g. "Kentucky Local Occupational Tax") — this engine's local tax ids don't carry a clean, uniform "locality name" field to key on, so the tax's own name is what a box 18-20 label is built from. See this module's own header comment on scope. */
  localityLabel: string;
  wages: Cents;
  incomeTaxWithheld: Cents;
}

export interface W2Summary {
  employeeId: string;
  year: number;
  box1_wages: Cents;
  box2_federalIncomeTaxWithheld: Cents;
  box3_socialSecurityWages: Cents;
  box4_socialSecurityTaxWithheld: Cents;
  box5_medicareWages: Cents;
  /** Includes Additional Medicare tax withheld, per the W-2 instructions' own box 6 definition — never a separate box. */
  box6_medicareTaxWithheld: Cents;
  box10_dependentCareBenefits: Cents;
  box12: { code: string; amount: Cents }[];
  box15to17_state: W2StateWages[];
  box18to20_local: W2LocalWages[];
}

const STATE_INCOME_TAX_ID = /^([A-Z]{2})_SIT$/;

export function computeW2(employeeId: string, year: number, approvedRuns: readonly PayRun[]): W2Summary {
  const runsForYear = approvedRuns.filter((r) => r.status === 'approved' && r.checkDate.startsWith(String(year)));
  const linesForEmployee = runsForYear
    .map((r) => r.lines.find((l) => l.employeeId === employeeId))
    .filter((l): l is PayRunLine => l !== undefined);

  let box1 = 0;
  let box2 = 0;
  let box3 = 0;
  let box4 = 0;
  let box5 = 0;
  let box6 = 0;
  const stateWages = new Map<string, W2StateWages>();
  const localWages = new Map<string, W2LocalWages>();

  for (const line of linesForEmployee) {
    box1 += sumTaxLine(line, 'US_FIT', 'taxableWages') + sumTaxLine(line, 'US_FIT_SUPP', 'taxableWages');
    box2 += sumTaxLine(line, 'US_FIT', 'amount') + sumTaxLine(line, 'US_FIT_SUPP', 'amount');
    box3 += sumTaxLine(line, 'US_SS_EE', 'taxableWages');
    box4 += sumTaxLine(line, 'US_SS_EE', 'amount');
    box5 += sumTaxLine(line, 'US_MED_EE', 'taxableWages');
    box6 += sumTaxLine(line, 'US_MED_EE', 'amount') + sumTaxLine(line, 'US_MED_ADDL', 'amount');

    for (const t of line.taxLines) {
      if (t.payer !== 'employee') continue;
      const sitMatch = STATE_INCOME_TAX_ID.exec(t.id);
      if (sitMatch) {
        const state = sitMatch[1];
        const existing = stateWages.get(state) ?? { state, wages: 0, incomeTaxWithheld: 0 };
        existing.wages += t.taxableWages;
        existing.incomeTaxWithheld += t.amount;
        stateWages.set(state, existing);
        continue;
      }
      if (t.jurisdiction === 'local') {
        const existing = localWages.get(t.name) ?? { localityLabel: t.name, wages: 0, incomeTaxWithheld: 0 };
        existing.wages += t.taxableWages;
        existing.incomeTaxWithheld += t.amount;
        localWages.set(t.name, existing);
      }
    }
  }

  return {
    employeeId,
    year,
    box1_wages: box1,
    box2_federalIncomeTaxWithheld: box2,
    box3_socialSecurityWages: box3,
    box4_socialSecurityTaxWithheld: box4,
    box5_medicareWages: box5,
    box6_medicareTaxWithheld: box6,
    box10_dependentCareBenefits: 0, // filled in below once deduction plans are known — see computeW2FromEmployee()
    box12: [],
    box15to17_state: [...stateWages.values()],
    box18to20_local: [...localWages.values()],
  };
}

/**
 * computeW2() above works purely off pay run history, which is enough for
 * boxes 1-6 and 15-20 — those are all rollups of tax lines the engine
 * already produced. Box 10 (dependent care) and box 12 (401(k)/HSA/...)
 * are different: they're rollups of DEDUCTION amounts, which a PayRunLine
 * deliberately does NOT itemize per deduction code (only pretax/posttax
 * TOTALS — see PayRunLine's own doc comment), so this second function
 * takes the employee's CURRENT deductionPlans and replays each plan
 * against every period's own ACTUAL grossPay (a percentOfGross plan
 * reduces to the exact same cents payroll/engine.ts's resolveDeductions()
 * would have computed for that period, since PayRunLine.grossPay is the
 * identical cash-gross basis it uses) rather than an averaged estimate.
 *
 * DISCLOSED SIMPLIFICATION: a plan's amount/percent/active-status that
 * CHANGED partway through the year (a raise to the 401(k) percent, a
 * benefit enrolled mid-year) is not reconstructed period-by-period — this
 * replays the plan's CURRENT configuration against every period the
 * employee was paid, which is exact for a plan unchanged all year and
 * approximate otherwise. Closing that requires a deduction-amount HISTORY
 * table, which this project's file-backed store doesn't keep (see
 * payroll/store.ts's own header comment on scope) — the same "exact for
 * the common case, disclosed for the rest" tradeoff this module's own
 * header comment already draws for Form 941.
 */
export function computeW2FromEmployee(employee: Employee, year: number, approvedRuns: readonly PayRun[]): W2Summary {
  const base = computeW2(employee.id, year, approvedRuns);
  const linesForEmployee = approvedRuns
    .filter((r) => r.status === 'approved' && r.checkDate.startsWith(String(year)))
    .map((r) => r.lines.find((l) => l.employeeId === employee.id))
    .filter((l): l is PayRunLine => l !== undefined);

  let dependentCare = 0;
  const box12 = new Map<string, Cents>();

  for (const plan of employee.deductionPlans) {
    if (!plan.active) continue;
    const annual = linesForEmployee.reduce((sum, line) => sum + deductionPlanAmountForPeriod(plan, line.grossPay), 0);
    if (plan.category === 'dependent_care') {
      dependentCare += annual;
      continue;
    }
    const code = plan.category ? BOX12_CODE_BY_PRETAX_CATEGORY[plan.category] : undefined;
    if (code) box12.set(code, (box12.get(code) ?? 0) + annual);
  }

  return {
    ...base,
    box10_dependentCareBenefits: dependentCare,
    box12: [...box12.entries()].map(([code, amount]) => ({ code, amount })),
  };
}

function deductionPlanAmountForPeriod(plan: DeductionPlan, periodGrossPay: Cents): Cents {
  return plan.amount.kind === 'flat' ? plan.amount.cents : Math.round(periodGrossPay * (plan.amount.percent / 100));
}

export interface Form940Summary {
  companyId: string;
  year: number;
  /** Line 3: total payments to all employees this year, before any exemption or wage-base exclusion. */
  totalPayments: Cents;
  /**
   * Lines 4+5 combined: payments exempt from FUTA entirely (fringe
   * benefits, retirement contributions, etc.) PLUS each employee's own
   * payments above the $7,000 FUTA wage base — reported as ONE figure
   * because totalPayments minus this equals line 7 exactly, and this
   * engine's PayRunLine doesn't retain enough per-earning-category detail
   * to split "exempt payment types" from "excess over the wage base"
   * separately (the same disclosed limitation class as W-2 box 12 needing
   * the employee's OWN deductionPlans rather than pay-run history alone —
   * see computeW2FromEmployee()'s own header comment). A filer completing
   * the literal two-line form needs that split; the total LIABILITY this
   * module computes does not depend on it.
   */
  exemptPaymentsAndExcessOverWageBase: Cents;
  /** Line 7: total taxable FUTA wages — read directly off US_FUTA's own taxableWages, which the engine already nets against both exemptions and the wage base correctly. */
  totalTaxableFutaWages: Cents;
  /** Line 8 (this project's terms: the actual FUTA tax liability) — US_FUTA's own amount, already at the correct net rate including any state credit-reduction addition. */
  futaTax: Cents;
}

export function computeForm940(companyId: string, year: number, approvedRuns: readonly PayRun[]): Form940Summary {
  const runsInYear = approvedRuns.filter((r) => r.companyId === companyId && r.status === 'approved' && r.checkDate.startsWith(String(year)));

  let totalPayments = 0;
  let totalTaxableFutaWages = 0;
  let futaTax = 0;

  for (const run of runsInYear) {
    for (const line of run.lines) {
      totalPayments += line.grossPay;
      totalTaxableFutaWages += sumTaxLine(line, 'US_FUTA', 'taxableWages');
      futaTax += sumTaxLine(line, 'US_FUTA', 'amount');
    }
  }

  return {
    companyId,
    year,
    totalPayments,
    exemptPaymentsAndExcessOverWageBase: totalPayments - totalTaxableFutaWages,
    totalTaxableFutaWages,
    futaTax,
  };
}
