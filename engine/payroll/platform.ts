import { randomUUID } from 'node:crypto';

import { calculatePaycheck } from '../src/calculate.ts';
import type { Cents } from '../src/money.ts';
import type { FederalW4, PayFrequency, PaycheckInput } from '../src/types.ts';
import { resolveProvider, type EmbeddedPayrollProvider, type ProviderPayrollItem, type ProviderPayrollResult } from './embeddedProvider.ts';

/**
 * Embedded-payroll platform — "our own Zeal", in software.
 *
 * A partner app (Crewtally, or any third party with an API key) sends us a
 * company's employees + this period's earnings; we run the whole payroll:
 *   1. compute gross-to-net for each employee with OUR engine (src/), including
 *      whatever the caller already resolved (prevailing wage, etc.) as gross,
 *   2. hand the computed payroll to an embedded provider to MOVE THE MONEY and
 *      FILE THE TAXES (payroll/embeddedProvider.ts).
 *
 * Step 1 is entirely ours and real. Step 2 is where "our own Zeal" needs what
 * Zeal actually is: a sponsor bank + money-transmitter/reporting-agent licensing
 * + a tax-filing operation. Until that exists, resolveProvider() returns the
 * sandbox, which accepts the payroll but moves no money and files nothing — and
 * this function reports that honestly (moneyMoved / taxesFiled on the result).
 * This module never pretends a payroll was really paid.
 */

/** One employee to run this period. `grossCents` is the caller's already-resolved gross (e.g. after prevailing-wage make-up). */
export interface PlatformEmployeeInput {
  employeeId: string;
  name: string;
  grossCents: Cents;
  workStateCode: string;
  federalW4: FederalW4;
}

export interface RunPayrollInput {
  companyId: string;
  checkDate: string; // ISO yyyy-mm-dd
  payFrequency: PayFrequency;
  employees: readonly PlatformEmployeeInput[];
  /** Override the provider (tests, or a real Check/Zeal adapter). Defaults to resolveProvider(). */
  provider?: EmbeddedPayrollProvider;
}

export interface PlatformPaycheck {
  employeeId: string;
  name: string;
  grossCents: Cents;
  netCents: Cents;
  taxWithheldCents: Cents;
}

export interface PayrollRun {
  runId: string;
  companyId: string;
  checkDate: string;
  paychecks: PlatformPaycheck[];
  totalGrossCents: Cents;
  totalNetCents: Cents;
  totalTaxCents: Cents;
  /** The provider's outcome — the honest source of truth for whether money actually moved / taxes were actually filed. */
  settlement: ProviderPayrollResult;
}

/** Compute one employee's net from their gross using the engine. taxWithheld is everything held back (gross − net). */
function computePaycheck(emp: PlatformEmployeeInput, checkDate: string, payFrequency: PayFrequency): PlatformPaycheck {
  const input: PaycheckInput = {
    checkDate,
    payFrequency,
    earnings: [{ code: 'REG', category: 'regular', amount: emp.grossCents }],
    deductions: [],
    federalW4: emp.federalW4,
    ytd: { socialSecurity: 0, medicare: 0, futa: 0 },
    workState: { code: emp.workStateCode },
  };
  const result = calculatePaycheck(input);
  return {
    employeeId: emp.employeeId,
    name: emp.name,
    grossCents: emp.grossCents,
    netCents: result.netPay,
    taxWithheldCents: emp.grossCents - result.netPay,
  };
}

/**
 * Run a full payroll: compute every employee with the engine, then submit the
 * result to the embedded provider to pay + file. The returned run's `settlement`
 * is the truth about what really happened — with the sandbox provider,
 * settlement.moneyMoved and settlement.taxesFiled are false.
 */
export async function runEmbeddedPayroll(input: RunPayrollInput): Promise<PayrollRun> {
  const provider = input.provider ?? resolveProvider();
  const paychecks = input.employees.map((e) => computePaycheck(e, input.checkDate, input.payFrequency));

  const items: ProviderPayrollItem[] = paychecks.map((p) => ({
    employeeId: p.employeeId,
    name: p.name,
    grossCents: p.grossCents,
    netCents: p.netCents,
    taxWithheldCents: p.taxWithheldCents,
  }));

  const settlement = await provider.runPayroll({ companyId: input.companyId, checkDate: input.checkDate, items });

  return {
    runId: `run_${randomUUID().slice(0, 8)}`,
    companyId: input.companyId,
    checkDate: input.checkDate,
    paychecks,
    totalGrossCents: paychecks.reduce((s, p) => s + p.grossCents, 0),
    totalNetCents: paychecks.reduce((s, p) => s + p.netCents, 0),
    totalTaxCents: paychecks.reduce((s, p) => s + p.taxWithheldCents, 0),
    settlement,
  };
}
