import type { Cents } from '../src/money.ts';
import type { DirectDepositAccount } from './types.ts';
import { allocateNetPay, buildNachaFile, type AchCredit, type AchFileConfig } from './directDeposit.ts';

/**
 * Payment run — the step AFTER a pay run is approved: turn each employee's net
 * pay into the actual ACH credits, assemble the NACHA batch, and hand it to a
 * bank/ACH provider to originate.
 *
 * READ THIS FIRST — the honesty boundary this module holds to:
 * generating a NACHA file is NOT moving money. Real money movement requires a
 * bank of record and an ACH origination agreement, or an embedded provider
 * (Increase, Column, Modern Treasury for raw ACH; Check or Zeal for full
 * embedded payroll incl. tax filing) that holds those relationships. Doing it
 * without one isn't a missing function — it's unlicensed money transmission.
 *
 * So this module builds the batch and routes it through a PaymentSubmitter
 * SEAM. The default submitter is deliberately inert: it returns the generated
 * file and says, plainly, that nothing was transmitted and no money moved —
 * the same discipline trades/nudge.ts holds for SMS ("never claim delivery")
 * and payroll/directDeposit.ts's own header holds for account custody. A real
 * deployment implements PaymentSubmitter against its provider and returns
 * submitted:true ONLY after the provider confirms the batch was accepted.
 *
 * (Tax deposits — remitting withheld amounts to the IRS/EFTPS and the states —
 * are a separate, also-regulated flow, not this one. This module pays
 * EMPLOYEES; it does not file or deposit taxes.)
 */

/** One employee to pay: their net pay and their own split-deposit accounts. */
export interface Payee {
  employeeId: string;
  name: string;
  netPayCents: Cents;
  accounts: readonly DirectDepositAccount[];
}

/** The assembled batch: the credits, the NACHA file, the totals, and who couldn't be paid by ACH. */
export interface PaymentBatch {
  credits: AchCredit[];
  nachaFile: string;
  totalCents: Cents;
  entryCount: number;
  payeeCount: number;
  /** Employees with net pay but no bank account on file — they need a paper check, not an ACH entry. */
  unbanked: Array<{ employeeId: string; name: string; netPayCents: Cents }>;
}

/**
 * Assemble the ACH credit batch for a set of approved paychecks. Splits each
 * employee's net pay across their own accounts (allocateNetPay), maps the
 * result to live ACH credits, and builds the NACHA file. Employees with no
 * accounts are returned in `unbanked` rather than silently dropped — the
 * caller decides they get a paper check.
 */
export function buildPaymentBatch(payees: readonly Payee[], config: AchFileConfig): PaymentBatch {
  const credits: AchCredit[] = [];
  const unbanked: PaymentBatch['unbanked'] = [];

  for (const payee of payees) {
    if (payee.netPayCents <= 0) continue;
    if (payee.accounts.length === 0) {
      unbanked.push({ employeeId: payee.employeeId, name: payee.name, netPayCents: payee.netPayCents });
      continue;
    }
    const byId = new Map(payee.accounts.map((a) => [a.id, a]));
    for (const alloc of allocateNetPay(payee.netPayCents, payee.accounts)) {
      if (alloc.amount <= 0) continue; // don't emit zero-dollar live entries
      const account = byId.get(alloc.accountId)!;
      credits.push({
        routingNumber: account.routingNumber,
        accountNumber: account.accountNumber,
        accountType: account.accountType,
        amount: alloc.amount,
        individualId: payee.employeeId,
        individualName: payee.name,
        entryType: 'live',
      });
    }
  }

  const nachaFile = credits.length ? buildNachaFile(credits, config) : '';
  return {
    credits,
    nachaFile,
    totalCents: credits.reduce((s, c) => s + c.amount, 0),
    entryCount: credits.length,
    payeeCount: payees.filter((p) => p.netPayCents > 0 && p.accounts.length > 0).length,
    unbanked,
  };
}

/** The result of trying to originate a batch. `submitted` is true ONLY when a real provider accepted it. */
export interface PaymentSubmission {
  submitted: boolean;
  /** Which rail actually carried it, or why nothing did. */
  via: string;
  note: string;
  /** The provider's own reference for the submitted batch, when there is one. */
  providerRef?: string;
  totalCents: Cents;
  entryCount: number;
}

/** A bank/ACH origination adapter. A real deployment implements this against its provider. */
export interface PaymentSubmitter {
  submit(batch: PaymentBatch): PaymentSubmission | Promise<PaymentSubmission>;
}

/**
 * The default submitter — the honest one. It transmits NOTHING: it hands back
 * the generated NACHA file and states plainly that no bank is connected and no
 * money has moved. Swap it for a real PaymentSubmitter once a provider/bank is
 * wired; until then a caller can never mistake "file generated" for "employees
 * paid".
 */
export const unbankedSubmitter: PaymentSubmitter = {
  submit(batch) {
    return {
      submitted: false,
      via: 'none — no bank/ACH provider connected',
      note:
        'A NACHA batch was generated but NOT transmitted. No money has moved. Connect a bank of record or an ' +
        'embedded provider (Increase/Column/Modern Treasury, or Check/Zeal) and implement PaymentSubmitter to originate it.',
      totalCents: batch.totalCents,
      entryCount: batch.entryCount,
    };
  },
};

/** Route an assembled batch through a submitter (the inert default unless one is supplied). */
export function submitPaymentBatch(batch: PaymentBatch, submitter: PaymentSubmitter = unbankedSubmitter): PaymentSubmission | Promise<PaymentSubmission> {
  return submitter.submit(batch);
}
