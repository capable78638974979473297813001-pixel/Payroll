import { newId } from '../lib/ids.ts';
import type { Cents } from '../lib/money.ts';
import type { Store } from '../store/store.ts';
import type { LedgerAccount, LedgerEntry } from '../domain/types.ts';

/**
 * An append-only double-entry ledger. Every entry's debits equal its credits,
 * checked before it is written; a cent can only move between accounts, never
 * appear or vanish. Must be called inside store.tx() so the entry lands with
 * the state change it records.
 */
export function postEntry(
  store: Store,
  e: { companyId: string; runId?: string; memo: string; legId?: string; at?: string; lines: Array<{ account: LedgerAccount; debitCents?: Cents; creditCents?: Cents }> },
): LedgerEntry {
  const lines = e.lines.map((l) => ({ account: l.account, debitCents: l.debitCents ?? 0, creditCents: l.creditCents ?? 0 }));
  for (const l of lines) {
    if (!Number.isSafeInteger(l.debitCents) || !Number.isSafeInteger(l.creditCents) || l.debitCents < 0 || l.creditCents < 0) {
      throw new Error('Ledger lines must be non-negative integer cents');
    }
  }
  const debit = lines.reduce((a, l) => a + l.debitCents, 0);
  const credit = lines.reduce((a, l) => a + l.creditCents, 0);
  if (debit !== credit) throw new Error(`Unbalanced ledger entry: debits ${debit} != credits ${credit} (${e.memo})`);
  const entry: LedgerEntry = { id: newId('led'), companyId: e.companyId, ...(e.runId ? { runId: e.runId } : {}), at: e.at ?? new Date().toISOString(), memo: e.memo, lines, ...(e.legId ? { legId: e.legId } : {}) };
  return store.ledger.put(entry);
}

/** Net position per account. bank_cash is debit-positive; the liability accounts are credit-positive. */
export function ledgerBalances(store: Store, companyId: string, runId?: string): Record<LedgerAccount, Cents> {
  const out: Record<LedgerAccount, Cents> = { bank_cash: 0, employee_net_pay: 0, tax_withheld: 0, tax_employer: 0, deductions_held: 0 };
  for (const entry of store.ledger.where((x) => x.companyId === companyId && (!runId || x.runId === runId))) {
    for (const l of entry.lines) {
      out[l.account] += l.account === 'bank_cash' ? l.debitCents - l.creditCents : l.creditCents - l.debitCents;
    }
  }
  return out;
}
