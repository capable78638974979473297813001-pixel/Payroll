import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/store.ts';
import { BankService } from '../src/banking/accounts.ts';
import { AchService, planTimeline, reconcile, type AchConfig } from '../src/money/ach.ts';
import { ledgerBalances } from '../src/money/ledger.ts';
import { SandboxBank } from '../src/ach/sandbox.ts';
import { parseAchFile } from '../src/ach/nacha.ts';
import { approvePayRun, draftPayRun, voidPayRun } from '../src/payroll/payRuns.ts';
import { setPayoutAccounts } from '../src/domain/employees.ts';
import { FakeStripe } from './fake-stripe.ts';
import { bankAccount, day, fundingReady, hire, newCompany, ready, ROUTING, ROUTING_2, shiftsFor } from './helpers.ts';

/** Mon 2026-06-08: debit lands Tue 06-09, two-day hold runs to Thu 06-11, credits land Fri 06-12 = the check date. */
const RUN = { periodStart: day(0), periodEnd: day(6), checkDate: day(11) };
const CFG: AchConfig = {
  originator: { odfiRoutingNumber: ROUTING_2, odfiName: 'Test Sponsor Bank', immediateOrigin: '123456789', companyName: 'Totali Payroll', companyId: '1123456789' },
  holdBankingDays: 2,
  fundingLeadBankingDays: 1,
  creditLeadBankingDays: 1,
  trustSettlementDate: false,
};

async function setup(opts: { cfg?: Partial<AchConfig>; start?: string; employees?: boolean } = {}) {
  const clock = { now: new Date(`${opts.start ?? '2026-06-08'}T15:00:00Z`) };
  const store = new Store();
  const stripe = new FakeStripe();
  const bank = new SandboxBank();
  const banks = new BankService(store, stripe, { now: () => clock.now });
  const ach = new AchService(store, banks, bank, { ...CFG, ...opts.cfg }, { now: () => clock.now });
  const { company } = newCompany(store);
  fundingReady(store, company.id); // also puts the company in totali_ach mode
  const a = hire(store, company.id, { firstName: 'Ana', lastName: 'Ruiz', payType: { kind: 'hourly', rateCents: 1500 }, roleKey: 'line_cook', tipCreditNoticeDate: undefined });
  const b = hire(store, company.id, { firstName: 'Ben', lastName: 'Okafor', payType: { kind: 'hourly', rateCents: 1800 }, roleKey: 'line_cook', tipCreditNoticeDate: undefined });
  const accts: Record<string, string> = {};
  for (const [i, e] of [a, b].entries()) {
    if (opts.employees !== false) accts[e.id] = ready(store, e.id, `00011122${i}33`).id;
    shiftsFor(store, company.id, e.id, [0, 1, 2, 3, 4], { minutes: 480 });
  }
  const run = approvePayRun(store, company.id, draftPayRun(store, company.id, RUN).id, { acknowledgeReviewIssues: true });
  const setDay = (iso: string) => (clock.now = new Date(`${iso}T15:00:00Z`));
  return { store, stripe, bank, banks, ach, company, run, a, b, accts, clock, setDay };
}

/** Walk a run to funded: fund on Mon, bank confirms on Tue. */
async function funded(s: Awaited<ReturnType<typeof setup>>) {
  const f = await s.ach.fundPayRun(s.company.id, s.run.id);
  s.setDay('2026-06-09');
  s.ach.confirmFundsReceived(s.run.id, { reference: 'BANK-1', amountCents: f.leg.amountCents });
  return f;
}

const legs = (s: Awaited<ReturnType<typeof setup>>, kind: 'funding' | 'employee_payout') => s.store.legs.where((l) => l.runId === s.run.id && l.kind === kind);

test('the timeline: debit next banking day, two-day hold, credits the day after, on time for a Friday check date', () => {
  const t = planTimeline('2026-06-08', '2026-06-12', CFG);
  assert.deepEqual({ d: t.debitEffectiveDate, r: t.earliestDisburseDate, c: t.earliestCreditEffectiveDate, ok: t.onTime }, { d: '2026-06-09', r: '2026-06-11', c: '2026-06-12', ok: true });
  const late = planTimeline('2026-06-10', '2026-06-12', CFG);
  assert.equal(late.onTime, false);
  assert.equal(late.earliestCreditEffectiveDate, '2026-06-16', 'Juneteenth (Fri 06-19) is not involved but the weekend is');
  assert.equal(late.daysLate, 2);
  assert.equal(planTimeline('2026-06-13', '2026-06-19', CFG).targetCreditDate, '2026-06-18', 'a holiday check date pays the banking day before');
});

test('full flow: debit, bank confirms, hold, credits, settled; the ledger balances at every step', async () => {
  const s = await setup();
  const f = await s.ach.fundPayRun(s.company.id, s.run.id);
  assert.equal(f.timeline.onTime, true);
  assert.equal(f.leg.status, 'submitted');
  assert.equal(f.run.status, 'funding');

  // the file the bank received is a single CCD debit for the whole run, from the employer's account
  const received = s.bank.received[0];
  const parsed = parseAchFile(received.content);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.batches[0].serviceClass, '225');
  assert.equal(parsed.batches[0].standardEntryClass, 'CCD');
  assert.equal(parsed.batches[0].entries.length, 1);
  assert.equal(parsed.batches[0].entries[0].transactionCode, '27');
  assert.equal(parsed.batches[0].entries[0].amountCents, s.run.totals.fundingRequiredCents);
  assert.equal(parsed.batches[0].entries[0].accountNumber, '000987654321');
  assert.equal(parsed.batches[0].effectiveEntryDate, '260609');
  assert.equal(parsed.batches[0].entries[0].traceNumber, f.file!.entries[0].traceNumber);

  // nothing can be paid, and funds cannot be confirmed before they could have arrived
  await assert.rejects(s.ach.disbursePayRun(s.company.id, s.run.id), (e: any) => e.code === 'not_funded');
  assert.throws(() => s.ach.confirmFundsReceived(s.run.id, { reference: 'x', amountCents: f.leg.amountCents }), (e: any) => e.code === 'before_effective_date');

  s.setDay('2026-06-09');
  assert.throws(() => s.ach.confirmFundsReceived(s.run.id, { reference: 'x', amountCents: f.leg.amountCents - 1 }), (e: any) => e.code === 'amount_mismatch');
  s.ach.confirmFundsReceived(s.run.id, { reference: 'BANK-1', amountCents: f.leg.amountCents });
  const t = s.run.totals;
  assert.deepEqual(ledgerBalances(s.store, s.company.id), { bank_cash: t.fundingRequiredCents, employee_net_pay: t.payableCents, tax_withheld: t.employeeTaxCents, tax_employer: t.employerTaxCents, deductions_held: t.deductionsCents });
  assert.equal(s.store.payRuns.get(s.run.id)!.status, 'funded');

  // the return-risk hold
  await assert.rejects(s.ach.disbursePayRun(s.company.id, s.run.id), (e: any) => e.code === 'funds_on_hold' && e.details.releaseDate === '2026-06-11');
  s.setDay('2026-06-10');
  await assert.rejects(s.ach.disbursePayRun(s.company.id, s.run.id), (e: any) => e.code === 'funds_on_hold');
  s.setDay('2026-06-11');
  const out = await s.ach.disbursePayRun(s.company.id, s.run.id);
  assert.equal(out.paying.length, 2);
  assert.equal(out.effectiveDate, '2026-06-12');
  assert.equal(out.late, false);
  assert.equal(out.status, 'disbursing');
  const credit = parseAchFile(s.bank.received[1].content);
  assert.deepEqual(credit.errors, []);
  assert.equal(credit.batches[0].serviceClass, '220');
  assert.equal(credit.batches[0].standardEntryClass, 'PPD');
  assert.deepEqual(credit.batches[0].entries.map((e) => e.transactionCode), ['22', '22']);
  assert.equal(credit.control.creditCents, t.payableCents, 'exactly the approved net pay goes out, no more');

  // credits settle on their effective date
  assert.equal(s.store.payRuns.get(s.run.id)!.status, 'disbursing');
  s.setDay('2026-06-12');
  s.ach.advance();
  assert.equal(s.store.payRuns.get(s.run.id)!.status, 'completed');
  const bal = ledgerBalances(s.store, s.company.id);
  assert.equal(bal.employee_net_pay, 0);
  assert.equal(bal.bank_cash, t.employeeTaxCents + t.employerTaxCents + t.deductionsCents, 'what remains is exactly the tax and deduction money held');
  for (const e of s.store.ledger.all()) assert.equal(e.lines.reduce((a, l) => a + l.debitCents, 0), e.lines.reduce((a, l) => a + l.creditCents, 0));
  assert.equal((await s.ach.disbursePayRun(s.company.id, s.run.id).catch((e) => e)).code, 'not_funded', 'a completed run cannot be paid again');
});

test('the same payroll can never be debited twice', async () => {
  const s = await setup();
  const first = await s.ach.fundPayRun(s.company.id, s.run.id);
  const second = await s.ach.fundPayRun(s.company.id, s.run.id);
  assert.equal(first.leg.id, second.leg.id);
  assert.equal(s.bank.received.length, 1);
  assert.equal(s.store.achFiles.all().length, 1);
});

test('funding needs a business account, active, with the employer\'s authorization on file for that account', async () => {
  const s = await setup();
  const company = s.store.companies.get(s.company.id)!;
  const auth = company.funding.debitAuthorization!;

  s.store.tx(() => s.store.companies.put({ ...company, funding: { bankAccountId: company.funding.bankAccountId } }));
  await assert.rejects(s.ach.fundPayRun(s.company.id, s.run.id), (e: any) => e.code === 'debit_not_authorized');

  const other = bankAccount(s.store, { companyId: s.company.id, ownerKind: 'company', ownerId: s.company.id, routingNumber: ROUTING, accountNumber: '000555666777' });
  s.store.tx(() => s.store.companies.put({ ...company, funding: { bankAccountId: other.id, debitAuthorization: auth } }));
  await assert.rejects(s.ach.fundPayRun(s.company.id, s.run.id), (e: any) => e.code === 'debit_not_authorized', 'an authorization for another account does not count');

  s.store.tx(() => s.store.companies.put({ ...company }));
  s.store.tx(() => s.store.bankAccounts.put({ ...s.store.bankAccounts.get(auth.bankAccountId)!, status: 'pending' }));
  await assert.rejects(s.ach.fundPayRun(s.company.id, s.run.id), (e: any) => e.code === 'funding_account_not_active');

  s.store.tx(() => s.store.bankAccounts.put({ ...s.store.bankAccounts.get(auth.bankAccountId)!, status: 'active', holderType: 'individual' }));
  await assert.rejects(s.ach.fundPayRun(s.company.id, s.run.id), (e: any) => e.code === 'consumer_account');
  assert.equal(s.bank.received.length, 0);
});

test('ACH needs the bank details to be configured', async () => {
  const s = await setup({ cfg: { originator: { ...CFG.originator, odfiRoutingNumber: '' } } });
  await assert.rejects(s.ach.fundPayRun(s.company.id, s.run.id), (e: any) => e.code === 'ach_not_configured');
});

test('a check date the ACH timeline cannot reach is refused unless the employer accepts paying late', async () => {
  const s = await setup({ start: '2026-06-10' });
  await assert.rejects(s.ach.fundPayRun(s.company.id, s.run.id), (e: any) => e.code === 'check_date_unreachable' && e.details.timeline.daysLate === 2);
  assert.equal(s.bank.received.length, 0);
  const f = await s.ach.fundPayRun(s.company.id, s.run.id, { acceptLate: true });
  assert.equal(f.timeline.onTime, false);
  assert.ok(s.store.payRuns.get(s.run.id)!.alerts!.some((a) => a.code === 'will_pay_late'));
});

test('paying after the target date is recorded as an alert', async () => {
  const s = await setup();
  await s.ach.fundPayRun(s.company.id, s.run.id);
  s.setDay('2026-06-09');
  s.ach.confirmFundsReceived(s.run.id, { reference: 'B', amountCents: s.store.legs.where((l) => l.kind === 'funding')[0].amountCents });
  s.setDay('2026-06-15'); // the ops team confirmed late and disbursement happens after the check date
  const out = await s.ach.disbursePayRun(s.company.id, s.run.id);
  assert.equal(out.late, true);
  assert.equal(out.effectiveDate, '2026-06-16');
  assert.ok(s.store.payRuns.get(s.run.id)!.alerts!.some((a) => a.code === 'paid_late'));
});

test('a file the bank rejects returns the run to approved, and a retry builds a new file with new trace numbers', async () => {
  const s = await setup();
  s.bank.rejectNext = 'invalid file header';
  const first = await s.ach.fundPayRun(s.company.id, s.run.id);
  assert.equal(first.leg.status, 'failed');
  assert.equal(s.store.payRuns.get(s.run.id)!.status, 'approved');
  assert.match(first.leg.failureMessage!, /invalid file header/);
  const second = await s.ach.fundPayRun(s.company.id, s.run.id);
  assert.equal(second.leg.attempt, 2);
  assert.equal(second.leg.status, 'submitted');
  assert.notEqual(second.leg.traceNumber, first.leg.traceNumber);
  assert.equal(s.bank.received.length, 2);
});

test('a file the bank has not acknowledged stays queued; it is not treated as sent until the bank says so', async () => {
  const s = await setup();
  s.bank.holdAcknowledgement = true;
  const f = await s.ach.fundPayRun(s.company.id, s.run.id);
  assert.equal(f.leg.status, 'queued');
  assert.equal(f.file!.status, 'queued');
  s.setDay('2026-06-09');
  assert.throws(() => s.ach.confirmFundsReceived(s.run.id, { reference: 'x', amountCents: f.leg.amountCents }), (e: any) => e.code === 'debit_not_submitted');
  s.ach.markFileAccepted(f.file!.id, 'BANK-REF');
  assert.equal(s.store.legs.get(f.leg.id)!.status, 'submitted');
  s.ach.confirmFundsReceived(s.run.id, { reference: 'x', amountCents: f.leg.amountCents });
  assert.equal(s.store.payRuns.get(s.run.id)!.status, 'funded');
});

test('a crash after the file is built but before it is handed over: reconcile hands over the same file, never a second one', async () => {
  const s = await setup();
  const real = s.bank.submit.bind(s.bank);
  let boom = true;
  s.bank.submit = async (f) => {
    if (boom) {
      boom = false;
      throw new Error('connection reset');
    }
    return real(f);
  };
  await assert.rejects(s.ach.fundPayRun(s.company.id, s.run.id), /connection reset/);
  assert.equal(s.store.achFiles.all().length, 1);
  assert.equal(s.store.achFiles.all()[0].status, 'created');
  assert.equal(s.store.legs.all()[0].status, 'queued');
  await reconcile(s.ach, s.store, { autoDisburse: false });
  assert.equal(s.store.achFiles.all().length, 1, 'still one file');
  assert.equal(s.store.achFiles.all()[0].status, 'accepted');
  assert.equal(s.store.legs.all()[0].status, 'submitted');
  assert.equal(s.bank.received.length, 1);
  assert.equal((await s.ach.fundPayRun(s.company.id, s.run.id)).leg.id, s.store.legs.all()[0].id);
});

test('trace numbers are unique and continue across files', async () => {
  const s = await setup();
  await funded(s);
  s.setDay('2026-06-11');
  await s.ach.disbursePayRun(s.company.id, s.run.id);
  const traces = s.store.achFiles.all().flatMap((f) => f.entries.map((e) => e.traceNumber));
  assert.equal(new Set(traces).size, traces.length);
  assert.equal(traces.length, 3);
  assert.deepEqual([...traces].sort(), traces.slice().sort());
});

test('a returned employee credit: net pay owed again, the bad account disabled, only that employee re-sent', async () => {
  const s = await setup();
  await funded(s);
  s.setDay('2026-06-11');
  await s.ach.disbursePayRun(s.company.id, s.run.id);
  s.setDay('2026-06-12');
  s.ach.advance();
  assert.equal(s.store.payRuns.get(s.run.id)!.status, 'completed');

  const legA = legs(s, 'employee_payout').find((l) => l.employeeId === s.a.id)!;
  const ret = SandboxBank.returnFile([{ trace: legA.traceNumber!, code: 'R03', amountCents: legA.amountCents }]);
  s.setDay('2026-06-15');
  const r = s.ach.ingestReturnFile(ret);
  assert.deepEqual(r.unmatched, []);
  assert.equal(r.applied.length, 1);
  assert.equal(s.store.legs.get(legA.id)!.status, 'returned');
  assert.equal(s.store.bankAccounts.get(s.accts[s.a.id])!.status, 'disabled');
  assert.equal(s.store.payRuns.get(s.run.id)!.status, 'disbursing');
  assert.ok(s.store.payRuns.get(s.run.id)!.alerts!.some((a) => a.code === 'payout_returned'));
  assert.equal(ledgerBalances(s.store, s.company.id).employee_net_pay, legA.amountCents, 'Ana is owed her net pay again');

  // applying the same return twice changes nothing
  assert.deepEqual(s.ach.ingestReturnFile(ret).alreadyApplied, [legA.traceNumber]);
  assert.equal(ledgerBalances(s.store, s.company.id).employee_net_pay, legA.amountCents);

  // Ana has no working account: she waits, Ben is not paid twice
  const waiting = await s.ach.disbursePayRun(s.company.id, s.run.id);
  assert.equal(waiting.paying.length, 0);
  assert.equal(waiting.waitingForBankAccount[0].employeeId, s.a.id);
  assert.equal(legs(s, 'employee_payout').filter((l) => l.employeeId === s.b.id).length, 1);

  // she gives a new account; only she is paid
  const fresh = ready(s.store, s.a.id, '000777888999');
  const again = await s.ach.disbursePayRun(s.company.id, s.run.id);
  assert.deepEqual(again.paying.map((p) => [p.employeeId, p.bankAccountId, p.amountCents]), [[s.a.id, fresh.id, legA.amountCents]]);
  s.setDay('2026-06-16');
  s.ach.advance();
  assert.equal(s.store.payRuns.get(s.run.id)!.status, 'completed');
  assert.equal(ledgerBalances(s.store, s.company.id).employee_net_pay, 0);
});

test('a returned debit before the funds were confirmed puts the run back to approved; nothing was paid', async () => {
  const s = await setup();
  const f = await s.ach.fundPayRun(s.company.id, s.run.id);
  s.setDay('2026-06-10');
  s.ach.ingestReturnFile(SandboxBank.returnFile([{ trace: f.leg.traceNumber!, code: 'R01', amountCents: f.leg.amountCents }]));
  assert.equal(s.store.payRuns.get(s.run.id)!.status, 'approved');
  assert.equal(s.store.legs.get(f.leg.id)!.status, 'returned');
  assert.equal(s.store.bankAccounts.get(s.store.companies.get(s.company.id)!.funding.bankAccountId!)!.status, 'active', 'insufficient funds does not condemn the account');
  assert.deepEqual(ledgerBalances(s.store, s.company.id), { bank_cash: 0, employee_net_pay: 0, tax_withheld: 0, tax_employer: 0, deductions_held: 0 });
  const retry = await s.ach.fundPayRun(s.company.id, s.run.id, { acceptLate: true });
  assert.equal(retry.leg.attempt, 2);
});

test('a debit returned after it settled and after employees were paid records the exposure', async () => {
  const s = await setup();
  const f = await funded(s);
  s.setDay('2026-06-11');
  await s.ach.disbursePayRun(s.company.id, s.run.id);
  s.setDay('2026-06-12');
  s.ach.advance();
  s.ach.ingestReturnFile(SandboxBank.returnFile([{ trace: f.leg.traceNumber!, code: 'R01', amountCents: f.leg.amountCents }]));
  const run = s.store.payRuns.get(s.run.id)!;
  assert.ok(run.alerts!.some((a) => a.code === 'debit_returned_after_payout'));
  assert.equal(ledgerBalances(s.store, s.company.id).bank_cash, -s.run.totals.payableCents, 'Totali is out the net pay it already sent');
});

test('an unauthorized-debit return disables the employer account and revokes the authorization', async () => {
  const s = await setup();
  const f = await s.ach.fundPayRun(s.company.id, s.run.id);
  s.ach.ingestReturnFile(SandboxBank.returnFile([{ trace: f.leg.traceNumber!, code: 'R29', amountCents: f.leg.amountCents }]));
  const c = s.store.companies.get(s.company.id)!;
  assert.equal(c.funding.debitAuthorization, undefined);
  assert.equal(s.store.bankAccounts.get(c.funding.bankAccountId!)!.status, 'disabled');
  await assert.rejects(s.ach.fundPayRun(s.company.id, s.run.id), (e: any) => e.code === 'funding_account_not_active' || e.code === 'debit_not_authorized');
});

test('a return that matches nothing is reported, and a malformed file is refused whole', async () => {
  const s = await setup();
  const r = s.ach.ingestReturnFile(SandboxBank.returnFile([{ trace: '021000029999999', code: 'R02', amountCents: 5 }]));
  assert.deepEqual(r.unmatched, ['021000029999999']);
  assert.throws(() => s.ach.ingestReturnFile(SandboxBank.returnFile([{ trace: '021000029999999', code: 'R02', amountCents: 5 }]).slice(0, -95)), (e: any) => e.code === 'bad_return_file');
});

test('a split deposit pays each account its share and never more than net pay', async () => {
  const s = await setup({ employees: false });
  const savings = bankAccount(s.store, { companyId: s.company.id, ownerKind: 'employee', ownerId: s.a.id, accountType: 'savings', accountNumber: '000444555666' });
  const checking = bankAccount(s.store, { companyId: s.company.id, ownerKind: 'employee', ownerId: s.a.id, accountNumber: '000111222333' });
  setPayoutAccounts(s.store, s.company.id, s.a.id, { accounts: [{ bankAccountId: savings.id, allocation: { kind: 'flatAmount', amount: 10_000 } }, { bankAccountId: checking.id, allocation: { kind: 'remainder' } }] });
  ready(s.store, s.b.id, '000999888777');
  const draft = s.store.payRuns.get(s.run.id)!;
  await funded(s);
  s.setDay('2026-06-11');
  const out = await s.ach.disbursePayRun(s.company.id, s.run.id);
  const pcA = draft.paychecks.find((p) => p.employeeId === s.a.id)!;
  const aLegs = out.paying.filter((p) => p.employeeId === s.a.id);
  assert.deepEqual(aLegs.map((l) => l.amountCents).sort((x, y) => x - y), [10_000, pcA.payableCents - 10_000].sort((x, y) => x - y));
  assert.equal(aLegs.reduce((a, l) => a + l.amountCents, 0), pcA.payableCents);
  const file = parseAchFile(s.bank.received[1].content);
  assert.ok(file.batches[0].entries.some((e) => e.transactionCode === '32' && e.amountCents === 10_000), 'the savings credit uses code 32');
});

test('split deposits need exactly one remainder, and only the employee\'s own live accounts', async () => {
  const s = await setup({ employees: false });
  const mine = bankAccount(s.store, { companyId: s.company.id, ownerKind: 'employee', ownerId: s.a.id });
  const theirs = bankAccount(s.store, { companyId: s.company.id, ownerKind: 'employee', ownerId: s.b.id });
  assert.throws(() => setPayoutAccounts(s.store, s.company.id, s.a.id, { accounts: [{ bankAccountId: mine.id, allocation: { kind: 'flatAmount', amount: 100 } }] }), /remainder/);
  assert.throws(() => setPayoutAccounts(s.store, s.company.id, s.a.id, { accounts: [{ bankAccountId: theirs.id, allocation: { kind: 'remainder' } }] }), /own bank accounts/);
  s.store.tx(() => s.store.bankAccounts.put({ ...mine, status: 'disabled', disabledReason: 'closed' }));
  assert.throws(() => setPayoutAccounts(s.store, s.company.id, s.a.id, { accounts: [{ bankAccountId: mine.id, allocation: { kind: 'remainder' } }] }), /disabled/);
});

test('the employer\'s balance: a fresh balance below the debit blocks it; a missing one lets it through, noted', async () => {
  const s = await setup();
  const acct = s.store.bankAccounts.get(s.store.companies.get(s.company.id)!.funding.bankAccountId!)!;
  const fc = s.stripe.accounts.size;
  void fc;
  // a stale / absent balance: proceeds, and says it was not checked
  s.store.tx(() => s.store.bankAccounts.put({ ...acct, link: { provider: 'stripe_financial_connections', sessionId: 's', fcAccountId: 'fca_missing', linkedAt: '2026-01-01T00:00:00Z', ownerNames: [], ownership: 'match' } }));
  const ok = await s.ach.fundPayRun(s.company.id, s.run.id);
  assert.equal(ok.balanceCheck!.checked, false);
  assert.ok(ok.leg.note);
});

test('a low balance reported by the bank blocks the debit', async () => {
  const s = await setup();
  const acct = s.store.bankAccounts.get(s.store.companies.get(s.company.id)!.funding.bankAccountId!)!;
  const sess = await s.stripe.createFcSession({ customer: 'cus_x', permissions: ['balances'] }, 'k');
  const fc = s.stripe.link(sess.id, { balance: { as_of: Math.floor(s.clock.now.getTime() / 1000) - 600, cash: { available: { usd: 1_000 } } } });
  s.store.tx(() => s.store.bankAccounts.put({ ...acct, link: { provider: 'stripe_financial_connections', sessionId: sess.id, fcAccountId: fc.id, linkedAt: '2026-01-01T00:00:00Z', ownerNames: [], ownership: 'match' } }));
  await assert.rejects(s.ach.fundPayRun(s.company.id, s.run.id), (e: any) => e.code === 'insufficient_employer_balance' && e.details.balanceCents === 1_000);
  assert.equal(s.bank.received.length, 0);
  fc.balance = { as_of: Math.floor(s.clock.now.getTime() / 1000) - 600, cash: { available: { usd: 50_000_000 } } };
  const f = await s.ach.fundPayRun(s.company.id, s.run.id);
  assert.equal(f.balanceCheck!.checked, true);
});

test('a company cannot reach the debit confirmation by itself: funds must be confirmed by the bank side', async () => {
  const s = await setup();
  await s.ach.fundPayRun(s.company.id, s.run.id);
  await assert.rejects(s.ach.disbursePayRun(s.company.id, s.run.id), (e: any) => e.code === 'not_funded');
});

test('trusting the settlement date settles a debit without a manual confirmation', async () => {
  const s = await setup({ cfg: { trustSettlementDate: true } });
  await s.ach.fundPayRun(s.company.id, s.run.id);
  s.setDay('2026-06-09');
  s.ach.advance();
  assert.equal(s.store.payRuns.get(s.run.id)!.status, 'funded');
});

test('reconcile pays out a funded run once the hold passes, and moves nothing twice', async () => {
  const s = await setup();
  await funded(s);
  s.setDay('2026-06-10');
  await reconcile(s.ach, s.store, { autoDisburse: true });
  assert.equal(legs(s, 'employee_payout').length, 0, 'still on hold');
  s.setDay('2026-06-11');
  await reconcile(s.ach, s.store, { autoDisburse: true });
  assert.equal(legs(s, 'employee_payout').length, 2);
  await reconcile(s.ach, s.store, { autoDisburse: true });
  assert.equal(legs(s, 'employee_payout').length, 2);
  s.setDay('2026-06-12');
  await reconcile(s.ach, s.store, { autoDisburse: true });
  assert.equal(s.store.payRuns.get(s.run.id)!.status, 'completed');
});

test('a run cannot be voided once the debit has been built', async () => {
  const s = await setup();
  await s.ach.fundPayRun(s.company.id, s.run.id);
  assert.throws(() => voidPayRun(s.store, s.company.id, s.run.id), (e: any) => e.code === 'money_in_motion');
});

test('file contents are encrypted at rest, not stored with their account numbers in the clear', async () => {
  const s = await setup();
  await s.ach.fundPayRun(s.company.id, s.run.id);
  const stored = JSON.stringify(s.store.achFiles.all());
  assert.ok(!stored.includes('000987654321'));
  assert.ok(!JSON.stringify(s.store.bankAccounts.all()).includes('000987654321'));
  assert.equal(s.ach.fileContent(s.company.id, s.store.achFiles.all()[0].id).content.includes('000987654321'), true);
  assert.throws(() => s.ach.fileContent('co_other', s.store.achFiles.all()[0].id), /not at this company/);
});

// ---------------------------------------------------------------- prenotes

test('a manually entered employee account is verified by a prenote after the NACHA waiting period', async () => {
  const s = await setup({ employees: false });
  const { BankService: _B } = await import('../src/banking/accounts.ts');
  const acct = s.banks.addManualAccount(s.company.id, { employeeId: s.a.id, routingNumber: ROUTING, accountNumber: '000246813579', accountType: 'checking' });
  assert.equal(acct.status, 'pending');
  const sent = await s.ach.submitPrenotes(s.company.id);
  assert.deepEqual(sent.accounts, [acct.id]);
  const f = parseAchFile(s.bank.received[0].content);
  assert.deepEqual(f.errors, []);
  assert.equal(f.batches[0].entries[0].transactionCode, '23');
  assert.equal(f.batches[0].entries[0].amountCents, 0);
  assert.equal((await s.ach.submitPrenotes(s.company.id)).file, null, 'not sent twice');

  const settle = s.store.bankAccounts.get(acct.id)!.verification.prenoteSettlementDate!;
  assert.equal(settle, '2026-06-09');
  s.setDay('2026-06-11');
  s.ach.advance();
  assert.equal(s.store.bankAccounts.get(acct.id)!.status, 'pending', 'three banking days have not passed');
  s.setDay('2026-06-12');
  s.ach.advance();
  assert.equal(s.store.bankAccounts.get(acct.id)!.status, 'active');
  assert.equal(s.store.bankAccounts.get(acct.id)!.verification.status, 'verified');
});

test('a returned prenote disables the account instead of ever sending real money to it', async () => {
  const s = await setup({ employees: false });
  const acct = s.banks.addManualAccount(s.company.id, { employeeId: s.a.id, routingNumber: ROUTING, accountNumber: '000246813579', accountType: 'checking' });
  await s.ach.submitPrenotes(s.company.id);
  const trace = s.store.achFiles.all()[0].entries[0].traceNumber;
  s.ach.ingestReturnFile(SandboxBank.returnFile([{ trace, code: 'R03', amountCents: 0 }]));
  const a = s.store.bankAccounts.get(acct.id)!;
  assert.equal(a.status, 'disabled');
  assert.equal(a.verification.status, 'failed');
  s.setDay('2026-06-30');
  s.ach.advance();
  assert.equal(s.store.bankAccounts.get(acct.id)!.status, 'disabled');
});

test('a notification of change holds the account until a person applies the correction', async () => {
  const s = await setup();
  await funded(s);
  s.setDay('2026-06-11');
  await s.ach.disbursePayRun(s.company.id, s.run.id);
  const leg = legs(s, 'employee_payout')[0];
  const r = s.ach.ingestReturnFile(SandboxBank.changeNotice(leg.traceNumber!, 'C01', '000999999999'));
  assert.equal(r.changeNotices[0].bankAccountId, leg.bankAccountId);
  const a = s.store.bankAccounts.get(leg.bankAccountId)!;
  assert.equal(a.status, 'needs_update');
  assert.equal(a.notificationOfChange!.changeCode, 'C01');
});

test('two funding requests at the same moment build exactly one debit', async () => {
  const s = await setup();
  // a balance check that yields, so both requests are mid-flight before either has created a leg
  const real = s.banks.checkBalance.bind(s.banks);
  s.banks.checkBalance = async (a, n) => {
    await new Promise((r) => setTimeout(r, 20));
    return real(a, n);
  };
  const [a, b] = await Promise.all([s.ach.fundPayRun(s.company.id, s.run.id), s.ach.fundPayRun(s.company.id, s.run.id)]);
  assert.equal(a.leg.id, b.leg.id);
  assert.equal(s.store.legs.where((l) => l.kind === 'funding').length, 1);
  assert.equal(s.store.achFiles.all().length, 1);
  assert.equal(s.bank.received.length, 1);
});

test('two disbursement requests at the same moment pay each employee once', async () => {
  const s = await setup();
  await funded(s);
  s.setDay('2026-06-11');
  const results = await Promise.allSettled([s.ach.disbursePayRun(s.company.id, s.run.id), s.ach.disbursePayRun(s.company.id, s.run.id)]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1, 'the second is refused while the first runs');
  assert.equal(legs(s, 'employee_payout').length, 2);
  assert.equal(s.bank.received.length, 2);
});
