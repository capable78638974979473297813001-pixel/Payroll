import { Store } from '../src/store/store.ts';
import { createCompany } from '../src/domain/companies.ts';
import { addEmployee } from '../src/domain/employees.ts';
import { recordShift } from '../src/domain/timekeeping.ts';
import type { Company, Employee } from '../src/domain/types.ts';

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

export function ready(store: Store, employeeId: string): void {
  const e = store.employees.require(employeeId, 'Employee');
  store.tx(() => store.employees.put({ ...e, payout: { status: 'ready', stripeAccountId: `acct_${employeeId}`, bankLast4: '6789' } }));
}
