/**
 * Try Totali's Column connection against Column's free sandbox. It makes one $1.00
 * test credit, reads it back, and cancels it: the three calls Totali relies on.
 * It refuses a live key, so it can never move real money.
 *
 *   COLUMN_API_KEY=test_... COLUMN_BANK_ACCOUNT_ID=bacc_... node scripts/check-column.ts
 */
import { ColumnClient } from '../src/column/client.ts';
import { BankApiError } from '../src/bankapi/types.ts';

const key = (process.env.COLUMN_API_KEY ?? '').trim();
const account = (process.env.COLUMN_BANK_ACCOUNT_ID ?? '').trim();
if (!key.startsWith('test_')) {
  console.error('COLUMN_API_KEY must be a sandbox key (it starts with test_). This script never uses a live key.');
  process.exit(2);
}
if (!account) {
  console.error('COLUMN_BANK_ACCOUNT_ID is required (a bank account id from your Column sandbox dashboard).');
  process.exit(2);
}

const client = new ColumnClient({ apiKey: key, bankAccountId: account });
const step = async <T>(name: string, fn: () => Promise<T>): Promise<T | undefined> => {
  try {
    const r = await fn();
    console.log(`ok    ${name}`);
    return r;
  } catch (e) {
    console.log(`FAIL  ${name}: ${e instanceof BankApiError ? `[${e.outcome}] ${e.message}` : (e as Error).message}`);
    return undefined;
  }
};

const tomorrow = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
const made = await step('create a $1.00 test credit', () => client.createTransfer({
  idempotencyKey: `totali-check-${Date.now()}`,
  type: 'CREDIT',
  amountCents: 100,
  entryClassCode: 'PPD',
  effectiveDate: tomorrow,
  companyName: 'TOTALI CHECK',
  entryDescription: 'PAYROLL',
  description: 'Totali connection check',
  receiverName: 'TEST EMPLOYEE',
  receiverId: 'CHECK1',
  counterparty: { routingNumber: '021000021', accountNumber: '000123456789', accountType: 'checking', name: 'TEST EMPLOYEE' },
}));
if (made) {
  console.log(`      transfer ${made.id}, status ${made.status}, trace ${made.trace_number ?? '(none yet)'}`);
  const read = await step('read it back', () => client.getTransfer(made.id));
  if (read) console.log(`      status ${read.status}`);
  await step('cancel it', () => client.cancelTransfer(made.id));
}
process.exit(made ? 0 : 1);
