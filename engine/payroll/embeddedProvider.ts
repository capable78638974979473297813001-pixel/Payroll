import type { Cents } from '../src/money.ts';

/**
 * Embedded-payroll provider port — Model A in docs/PAYMENTS.md.
 *
 * An embedded provider (Check, Zeal) IS the licensed, bank-backed payroll
 * company: given a computed payroll it moves the money (direct deposit) AND
 * files the taxes. Our engine stays the source of truth for the NUMBERS
 * (gross-to-net, prevailing wage, certified payroll — the things they don't do
 * well); the provider is the regulated rail underneath.
 *
 * This file is the seam. `sandboxProvider` runs the whole flow as an honest
 * simulation — it accepts the payroll but MOVES NO MONEY and FILES NOTHING, and
 * says so, the same discipline paymentRun.ts and nudge.ts hold. `checkProvider`
 * / `zealProvider` are the real adapters; they are intentionally unimplemented
 * until a provider is chosen and its sandbox credentials exist (see
 * docs/PAYMENTS.md), so nothing here can pretend a payroll was really run.
 */

/** One employee on a payroll the provider will pay + report. Amounts come from OUR engine. */
export interface ProviderPayrollItem {
  employeeId: string;
  name: string;
  grossCents: Cents;
  netCents: Cents;
  /** Total taxes withheld (what the provider deposits/files on the employee's behalf). */
  taxWithheldCents: Cents;
}

export interface ProviderPayrollInput {
  companyId: string;
  checkDate: string; // ISO yyyy-mm-dd
  items: readonly ProviderPayrollItem[];
}

export interface ProviderPayrollResult {
  provider: string;
  /** The provider accepted the payroll for processing. */
  submitted: boolean;
  /** Real funds actually moved. Only ever true from a real provider in live mode — never from the sandbox. */
  moneyMoved: boolean;
  /** Tax deposits/filings were actually submitted. Same rule: never true in sandbox. */
  taxesFiled: boolean;
  providerRef: string | null;
  note: string;
  totalNetCents: Cents;
  totalTaxCents: Cents;
  perEmployee: Array<{ employeeId: string; netCents: Cents; status: string }>;
}

export interface EmbeddedPayrollProvider {
  readonly name: string;
  /** Whether this provider has the credentials it needs to run for real. */
  configured(): boolean;
  runPayroll(input: ProviderPayrollInput): Promise<ProviderPayrollResult>;
}

function totals(input: ProviderPayrollInput): { net: Cents; tax: Cents } {
  return {
    net: input.items.reduce((s, i) => s + i.netCents, 0),
    tax: input.items.reduce((s, i) => s + i.taxWithheldCents, 0),
  };
}

/**
 * The honest simulator. It "accepts" the payroll so the whole app flow works
 * end to end in a demo — but it moves no money and files nothing, and every
 * field says so. Use it for demos and tests; swap in a real provider for
 * production.
 */
export const sandboxProvider: EmbeddedPayrollProvider = {
  name: 'sandbox',
  configured() {
    return true;
  },
  async runPayroll(input) {
    const { net, tax } = totals(input);
    return {
      provider: 'sandbox',
      submitted: true,
      moneyMoved: false, // never real
      taxesFiled: false, // never real
      providerRef: `sandbox_${input.companyId}_${input.checkDate}`,
      note:
        'SANDBOX — simulated only. No money moved and no taxes were filed. ' +
        'Connect Check or Zeal (see docs/PAYMENTS.md) to run this for real.',
      totalNetCents: net,
      totalTaxCents: tax,
      perEmployee: input.items.map((i) => ({ employeeId: i.employeeId, netCents: i.netCents, status: 'simulated' })),
    };
  },
};

/** Raised by a provider adapter that has not been implemented/connected yet. */
export class ProviderNotConnectedError extends Error {
  constructor(providerName: string) {
    super(
      `The ${providerName} adapter is not connected yet. Pick a provider and get sandbox credentials ` +
        `(docs/PAYMENTS.md), then implement runPayroll() against its API. Until then, use sandboxProvider.`,
    );
    this.name = 'ProviderNotConnectedError';
  }
}

/**
 * Real adapter skeletons. They report configured() from their API-key env var
 * so the app can tell whether they're set up, but runPayroll() refuses rather
 * than guess an API this repo can't test against. Implementing one is the step
 * that needs a chosen provider + sandbox credentials.
 */
export const checkProvider: EmbeddedPayrollProvider = {
  name: 'check',
  configured() {
    return Boolean(process.env.CHECK_API_KEY);
  },
  async runPayroll() {
    throw new ProviderNotConnectedError('Check');
  },
};

export const zealProvider: EmbeddedPayrollProvider = {
  name: 'zeal',
  configured() {
    return Boolean(process.env.ZEAL_API_KEY);
  },
  async runPayroll() {
    throw new ProviderNotConnectedError('Zeal');
  },
};

/**
 * Pick the provider to use: a real one only when it's both configured AND
 * actually connected (implemented). Today that means the sandbox, unless/until
 * a real adapter is finished — which is exactly the honest state of things.
 */
export function resolveProvider(): EmbeddedPayrollProvider {
  // A real provider is used only once its adapter is implemented; the skeletons
  // above throw, so we keep the sandbox as the safe default until then.
  return sandboxProvider;
}
