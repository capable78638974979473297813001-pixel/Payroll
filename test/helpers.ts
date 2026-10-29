import { Store } from '../src/store/store.ts';
import { createCompany } from '../src/domain/companies.ts';
import { addEmployee } from '../src/domain/employees.ts';
import { recordShift } from '../src/domain/timekeeping.ts';
import { encryptField } from '../src/lib/crypto.ts';
import type { BankAccount, Company, Employee } from '../src/domain/types.ts';

export const TEST_DATA_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.TOTALI_DATA_KEY ??= TEST_DATA_KEY;

export function newCompany(store: Store, over: Record<string, unknown> = {}): { company: Company; apiKey: string } {
  return createCompany(store, {
    legalName: 'Corner Table LLC',
    ein: '12-3456789',
    industry: 'restaurant',
    niche: 'full_service',
    homeState: 'TX',
    typicalDailyEmployees: 14,
    ...over,
  });
}

let ssnSeq = 1000;
export function hire(store: Store, companyId: string, over: Record<string, unknown> = {}): Employee {
  ssnSeq += 1;
  return addEmployee(store, companyId, {
    firstName: 'Test',
    lastName: `Person${ssnSeq}`,
    roleKey: 'server',
    hireDate: '2026-01-05',
    payType: { kind: 'hourly', rateCents: 213 },
    ssn: `512-34-${ssnSeq}`,
    tipCreditNoticeDate: '2026-01-05',
    ...over,
  });
}

export const MONDAY = '2026-06-01';
export const day = (n: number) => new Date(Date.UTC(2026, 5, 1 + n)).toISOString().slice(0, 10);

export function shiftsFor(store: Store, companyId: string, employeeId: string, days: number[], over: Record<string, unknown> = {}): void {
  for (const n of days) recordShift(store, companyId, { employeeId, workDate: day(n), minutes: 360, ...over });
}

/** Test routing numbers that pass the ABA checksum. */
export const ROUTING = '110000000';
export const ROUTING_2 = '021000021';

/** Put an active, verified bank account straight into the store, as a completed bank link would. */
export function bankAccount(store: Store, over: Partial<BankAccount> & { companyId: string; ownerKind: 'company' | 'employee'; ownerId: string; accountNumber?: string }): BankAccount {
  const { accountNumber = '000123456789', ...rest } = over;
  const acct: BankAccount = {
    id: `bank_${Math.random().toString(16).slice(2, 12)}`,
    holderType: over.ownerKind === 'company' ? 'business' : 'individual',
    accountType: 'checking',
    routingNumber: ROUTING,
    accountNumberEncrypted: encryptField(accountNumber),
    last4: accountNumber.slice(-4),
    institutionName: 'Test Bank',
    verification: { method: 'bank_link', status: 'verified', verifiedAt: '2026-01-01T00:00:00Z' },
    status: 'active',
    createdAt: '2026-01-01T00:00:00Z',
    ...rest,
  };
  store.tx(() => store.bankAccounts.put(acct));
  return acct;
}

/** Give an employee an active bank account that takes all of their net pay. */
export function ready(store: Store, employeeId: string, accountNumber = '000123456789'): BankAccount {
  const e = store.employees.require(employeeId, 'Employee');
  const acct = bankAccount(store, { companyId: e.companyId, ownerKind: 'employee', ownerId: e.id, accountNumber });
  store.tx(() => store.employees.put({ ...e, payoutAccounts: [{ bankAccountId: acct.id, allocation: { kind: 'remainder' } }] }));
  return acct;
}

/** Give a company an active, authorised funding account. */
export function fundingReady(store: Store, companyId: string): BankAccount {
  const acct = bankAccount(store, { companyId, ownerKind: 'company', ownerId: companyId, routingNumber: ROUTING_2, accountNumber: '000987654321' });
  const c = store.companies.require(companyId, 'Company');
  store.tx(() => store.companies.put({ ...c, funding: { bankAccountId: acct.id, debitAuthorization: { bankAccountId: acct.id, acceptedAt: '2026-01-02T00:00:00Z', acceptedBy: 'Owner Person', textVersion: 'draft-1' } } }));
  return acct;
}
