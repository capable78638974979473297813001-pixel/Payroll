import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/store.ts';
import { BankService } from '../src/banking/accounts.ts';
import { AchService, reconcile, type AchConfig } from '../src/money/ach.ts';
import { ledgerBalances } from '../src/money/ledger.ts';
import { ColumnClient } from '../src/column/client.ts';
import { ColumnSubmitter, mapColumnStatus } from '../src/column/submitter.ts';
import { BankApiError, type HttpRequest } from '../src/bankapi/types.ts';
import { loadConfig } from '../src/config.ts';
import { approvePayRun, draftPayRun } from '../src/payroll/payRuns.ts';
import { ApiError } from '../src/lib/errors.ts';
import { FakeStripe } from './fake-stripe.ts';
import { day, fundingReady, hire, newCompany, ready, ROUTING_2, shiftsFor } from './helpers.ts';

const KEY = 'test_abcdef1234567890';
const RUN = { periodStart: day(0), periodEnd: day(6), checkDate: day(11) };
const CFG: AchConfig = { originator: { odfiRoutingNumber: ROUTING_2, odfiName: 'COLUMN NA', immediateOrigin: ROUTING_2, companyName: 'Totali Payroll', companyId: 'TOTALI0001' }, holdBankingDays: 2, fundingLeadBankingDays: 1, creditLeadBankingDays: 1, trustSettlementDate: false };

type Resp = { status: number; body: string };
type Transfer = Record<string, any>;

/** A scripted Column that follows the documented behaviour: basic auth, idempotency keys, statuses, returns, cancel only while INITIATED. */
function fakeColumn() {
  const transfers = new Map<string, Transfer>();
  const byKey = new Map<string, string>();
  const reqs: HttpRequest[] = [];
  const posts = () => reqs.filter((r) => r.method === 'POST' && r.url.endsWith('/transfers/ach'));
  const state = { behave: undefined as undefined | ((n: number, body: Transfer) => Resp | 'lose_response' | undefined), n: 0 };
  const json = (o: unknown, status = 200): Resp => ({ status, body: JSON.stringify(o) });
  const http = async (req: HttpRequest): Promise<Resp> => {
    reqs.push(req);
    if (req.headers['authorization'] !== `Basic ${Buffer.from(`:${KEY}`).toString('base64')}`) return json({ message: 'bad key' }, 401);
    const path = req.url.replace('https://api.column.com', '');
    if (req.method === 'POST' && path === '/transfers/ach') {
      const key = req.headers['idempotency-key']!;
      const seen = byKey.get(key);
      if (seen) return json(transfers.get(seen));
      const body = JSON.parse(req.body!) as Transfer;
      state.n += 1;
      const over = state.behave?.(state.n, body);
      if (over && over !== 'lose_response') return over;
      const id = `acht_${String(state.n).padStart(6, '0')}`;
      const t: Transfer = { id, status: 'INITIATED', amount: body.amount, trace_number: `09100001${String(state.n).padStart(7, '0')}`, type: body.type, request: body };
      transfers.set(id, t);
      byKey.set(key, id);
      if (over === 'lose_response') throw new BankApiError('unknown', 'The connection to the bank failed after the request may have been sent.');
      return json(t, 200);
    }
    const get = path.match(/^\/transfers\/ach\/(acht_\d+)$/);
    if (req.method === 'GET' && get) return transfers.has(get[1]!) ? json(transfers.get(get[1]!)) : json({}, 404);
    const cancel = path.match(/^\/transfers\/ach\/(acht_\d+)\/cancel$/);
    if (req.method === 'POST' && cancel) {
      const t = transfers.get(cancel[1]!);
      if (!t || t.status !== 'INITIATED') return json({ message: 'not cancellable' }, 400);
      t.status = 'CANCELED';
      return json(t);
    }
    return json({}, 404);
  };
  const set = (id: string, status: string, extra: Transfer = {}) => Object.assign(transfers.get(id)!, { status }, extra);
  const all = () => [...transfers.values()];
  return { http, reqs, posts, transfers, state, set, all, byType: (type: string) => all().filter((t) => t.type === type) };
}

async function setup(opts: { employees?: number; run?: boolean } = {}) {
  const clock = { now: new Date('2026-06-08T15:00:00Z') };
  const store = new Store();
  const col = fakeColumn();
  const submitter = new ColumnSubmitter(new ColumnClient({ apiKey: KEY, bankAccountId: 'bacc_test', http: col.http }));
  const banks = new BankService(store, new FakeStripe(), { now: () => clock.now });
  const ach = new AchService(store, banks, submitter, CFG, { now: () => clock.now });
  const { company } = newCompany(store);
  fundingReady(store, company.id);
  const staff = opts.employees ?? 2;
  for (let i = 0; i < staff; i++) {
    const e = hire(store, company.id, { firstName: `Ana${'abcdefgh'[i]}`, lastName: 'Ruiz', payType: { kind: 'hourly', rateCents: 1500 }, roleKey: 'line_cook', tipCreditNoticeDate: undefined });
    ready(store, e.id, `00011122${i}33`);
    shiftsFor(store, company.id, e.id, [0, 1, 2, 3, 4], { minutes: 480 });
  }
  const run = opts.run === false ? (undefined as never) : approvePayRun(store, company.id, draftPayRun(store, company.id, RUN).id, { acknowledgeReviewIssues: true });
  const setDay = (iso: string) => (clock.now = new Date(`${iso}T15:00:00Z`));
  const legs = (kind: 'funding' | 'employee_payout') => store.legs.where((l) => l.runId === run?.id && l.kind === kind);
  const logs: string[] = [];
  const tick = () => reconcile(ach, store, { autoDisburse: false, log: (m) => logs.push(m) });
  return { store, col, ach, company, run, clock, setDay, legs, tick, logs };
}

/** Fund on Monday, Column settles the debit on Tuesday, the sync confirms it. */
async function funded(s: Awaited<ReturnType<typeof setup>>) {
  const f = await s.ach.fundPayRun(s.company.id, s.run.id);
  const debit = s.col.byType('DEBIT')[0]!;
  s.setDay('2026-06-09');
  s.col.set(debit.id, 'SETTLED');
  await s.ach.syncExternal();
  return { f, debit };
}

// ---------------------------------------------------------------- what is sent

test("the employer's debit goes to Column as a CCD debit of exactly the run, with an idempotency key", async () => {
  const s = await setup();
  const f = await s.ach.fundPayRun(s.company.id, s.run.id);
  const req = s.col.posts()[0]!;
  const body = JSON.parse(req.body!);
  assert.equal(req.url, 'https://api.column.com/transfers/ach');
  assert.equal(req.headers['authorization'], `Basic ${Buffer.from(`:${KEY}`).toString('base64')}`);
  assert.match(req.headers['idempotency-key']!, new RegExp(`^totali:${f.file!.id}:`));
  assert.deepEqual([body.type, body.entry_class_code, body.currency_code, body.same_day, body.bank_account_id], ['DEBIT', 'CCD', 'USD', false, 'bacc_test']);
  assert.equal(body.amount, f.leg.amountCents);
  assert.equal(body.effective_date, '2026-06-09');
  assert.equal(body.counterparty.routing_number, ROUTING_2);
  assert.equal(body.counterparty.account_number, '000987654321');
  assert.ok(body.company_name.length <= 16 && body.company_entry_description.length <= 10 && body.receiver_name.length <= 22 && body.receiver_id.length <= 15);
  assert.equal(f.leg.status, 'submitted');
  assert.equal(s.store.achFiles.get(f.file!.id)!.status, 'accepted');
  assert.equal(s.store.legs.get(f.leg.id)!.traceNumber, s.col.byType('DEBIT')[0]!.trace_number, "the leg carries the bank's own trace number");
  assert.ok(!JSON.stringify([...s.store.achFiles.all(), ...s.store.legs.all()]).includes(KEY), 'the API key is stored nowhere');
});

test('each employee is a PPD credit to their own account, for exactly their net pay', async () => {
  const s = await setup();
  await funded(s);
  s.setDay('2026-06-11');
  await s.ach.disbursePayRun(s.company.id, s.run.id);
  const credits = s.col.byType('CREDIT');
  assert.equal(credits.length, 2);
  for (const c of credits) {
    assert.deepEqual([c.request.entry_class_code, c.request.effective_date, c.request.counterparty.account_type], ['PPD', '2026-06-12', 'checking']);
    assert.match(c.request.counterparty.account_number, /^00011122\d33$/);
  }
  const paid = credits.map((c) => c.amount).sort();
  assert.deepEqual(paid, s.run.paychecks.map((p) => p.payableCents).sort());
  assert.deepEqual(s.legs('employee_payout').map((l) => l.status), ['submitted', 'submitted']);
});

// ---------------------------------------------------------------- automatic funds confirmation

test('the debit settling confirms the funds by itself: no staff step, ledger balanced', async () => {
  const s = await setup();
  const f = await s.ach.fundPayRun(s.company.id, s.run.id);
  assert.equal(s.store.payRuns.get(s.run.id)!.status, 'funding');
  s.setDay('2026-06-09');
  const out = await s.ach.syncExternal();
  assert.equal(out.asked, 1);
  assert.equal(s.store.payRuns.get(s.run.id)!.status, 'funding', 'INITIATED is not settled');
  s.col.set(s.col.byType('DEBIT')[0]!.id, 'SETTLED');
  s.clock.now = new Date(s.clock.now.getTime() + 20 * 60_000);
  await s.ach.syncExternal();
  assert.equal(s.store.payRuns.get(s.run.id)!.status, 'funded');
  assert.equal(s.store.legs.get(f.leg.id)!.status, 'settled');
  const b = ledgerBalances(s.store, s.company.id);
  assert.equal(b.bank_cash, f.leg.amountCents);
});

test('a settlement dated in the future is not believed early', async () => {
  const s = await setup();
  await s.ach.fundPayRun(s.company.id, s.run.id);
  s.col.set(s.col.byType('DEBIT')[0]!.id, 'SETTLED'); // still Monday: the debit is dated Tuesday
  const out = await s.ach.syncExternal();
  assert.ok(out.failed.some((m) => /before_effective_date|cannot have settled/.test(m)), out.failed.join('|'));
  assert.equal(s.store.payRuns.get(s.run.id)!.status, 'funding');
});

test('a settled amount that differs from the debit is not treated as funded', async () => {
  const s = await setup();
  await s.ach.fundPayRun(s.company.id, s.run.id);
  s.setDay('2026-06-09');
  s.col.set(s.col.byType('DEBIT')[0]!.id, 'SETTLED', { amount: 1 });
  const out = await s.ach.syncExternal();
  assert.ok(out.failed.some((m) => /amount|not treated as funded/i.test(m)), out.failed.join('|'));
  assert.equal(s.store.payRuns.get(s.run.id)!.status, 'funding');
});

test('status is asked about at most every 15 minutes while in flight', async () => {
  const s = await setup();
  await s.ach.fundPayRun(s.company.id, s.run.id);
  const gets = () => s.col.reqs.filter((r) => r.method === 'GET').length;
  await s.ach.syncExternal();
  await s.ach.syncExternal();
  assert.equal(gets(), 1);
  s.clock.now = new Date(s.clock.now.getTime() + 16 * 60_000);
  await s.ach.syncExternal();
  assert.equal(gets(), 2);
});

test('the whole run, end to end: funds, hold, pay, settle, complete', async () => {
  const s = await setup();
  await funded(s);
  s.setDay('2026-06-10');
  await assert.rejects(() => s.ach.disbursePayRun(s.company.id, s.run.id), (e: ApiError) => e.code === 'funds_on_hold');
  s.setDay('2026-06-11');
  await s.ach.disbursePayRun(s.company.id, s.run.id);
  for (const c of s.col.byType('CREDIT')) s.col.set(c.id, 'SETTLED');
  s.setDay('2026-06-12');
  await s.tick();
  assert.equal(s.store.payRuns.get(s.run.id)!.status, 'completed');
  assert.deepEqual(s.legs('employee_payout').map((l) => l.status), ['settled', 'settled']);
  assert.deepEqual(s.logs, []);
});

// ---------------------------------------------------------------- returns and cancels

test('a returned credit is undone with Column\'s own return code, and a bad account is disabled', async () => {
  const s = await setup();
  await funded(s);
  s.setDay('2026-06-11');
  await s.ach.disbursePayRun(s.company.id, s.run.id);
  const [first] = s.col.byType('CREDIT');
  s.col.set(first!.id, 'RETURNED', { return_details: [{ return_code: 'R02', description: 'Account closed' }] });
  s.setDay('2026-06-12');
  await s.ach.syncExternal();
  const leg = s.legs('employee_payout').find((l) => l.returnCode === 'R02')!;
  assert.equal(leg.status, 'returned');
  assert.equal(s.store.bankAccounts.get(leg.bankAccountId)!.status, 'disabled');
  assert.ok(s.store.payRuns.get(s.run.id)!.alerts!.some((a) => a.code === 'payout_returned'));
  await s.ach.syncExternal();
  assert.equal(s.legs('employee_payout').filter((l) => l.status === 'returned').length, 1, 'applied once');
});

test('a returned employer debit after the funds settled is flagged as an exposure', async () => {
  const s = await setup();
  const { debit } = await funded(s);
  s.setDay('2026-06-11');
  await s.ach.disbursePayRun(s.company.id, s.run.id);
  s.col.set(debit.id, 'RETURNED', { return_details: [{ return_code: 'R01' }] });
  s.setDay('2026-06-12');
  await s.ach.syncExternal();
  assert.equal(s.legs('funding')[0]!.status, 'returned');
  assert.ok(s.store.payRuns.get(s.run.id)!.alerts!.some((a) => a.code === 'debit_returned_after_payout'));
});

test('a return with no code is not assumed harmless', async () => {
  const s = await setup();
  await funded(s);
  s.setDay('2026-06-11');
  await s.ach.disbursePayRun(s.company.id, s.run.id);
  s.col.set(s.col.byType('CREDIT')[0]!.id, 'RETURNED', { return_details: [{ return_code: null }] });
  await s.ach.syncExternal();
  const leg = s.legs('employee_payout').find((l) => l.status === 'returned')!;
  assert.equal(leg.returnCode, 'R99');
  assert.equal(s.store.bankAccounts.get(leg.bankAccountId)!.status, 'disabled', 'an unrecognised return disables the account until someone looks');
});

test('a cancelled debit fails the funding so the run can be funded again', async () => {
  const s = await setup();
  const f = await s.ach.fundPayRun(s.company.id, s.run.id);
  s.col.set(s.col.byType('DEBIT')[0]!.id, 'CANCELED');
  await s.ach.syncExternal();
  assert.equal(s.store.legs.get(f.leg.id)!.status, 'failed');
  assert.equal(s.store.payRuns.get(s.run.id)!.status, 'approved');
});

test('a held or unrecognised status raises one alert and is never assumed fine', async () => {
  const s = await setup();
  await s.ach.fundPayRun(s.company.id, s.run.id);
  const id = s.col.byType('DEBIT')[0]!.id;
  s.col.set(id, 'MANUAL_REVIEW');
  await s.ach.syncExternal();
  s.clock.now = new Date(s.clock.now.getTime() + 20 * 60_000);
  await s.ach.syncExternal();
  assert.equal(s.store.payRuns.get(s.run.id)!.alerts!.filter((a) => a.code === 'bank_transfer_held').length, 1);
  s.col.set(id, 'SOMETHING_NEW');
  s.clock.now = new Date(s.clock.now.getTime() + 20 * 60_000);
  await s.ach.syncExternal();
  assert.ok(s.store.payRuns.get(s.run.id)!.alerts!.some((a) => a.code === 'bank_transfer_needs_review'));
  assert.equal(s.store.payRuns.get(s.run.id)!.status, 'funding');
});

test('every documented Column status maps to a deliberate outcome', () => {
  const expect: Record<string, string> = { INITIATED: 'in_flight', PENDING_SUBMISSION: 'in_flight', SUBMITTED: 'in_flight', SCHEDULED: 'in_flight', PENDING_RETURN: 'in_flight', PRE_REVIEW: 'held', HOLD: 'held', MANUAL_REVIEW: 'held', MANUAL_REVIEW_APPROVED: 'held', SETTLED: 'settled', COMPLETED: 'settled', RETURNED: 'returned', CANCELED: 'cancelled', RETURN_CONTESTED: 'needs_review', RETURN_DISHONORED: 'needs_review', RETURN_DISHONORED_FUNDS_UNLOCKED: 'needs_review' };
  for (const [k, v] of Object.entries(expect)) assert.equal(mapColumnStatus(k), v, k);
  assert.equal(mapColumnStatus('NEVER_SEEN'), 'needs_review');
});

// ---------------------------------------------------------------- never paying twice

test('a payment Column refuses fails that employee only; the rest go ahead', async () => {
  const s = await setup();
  await funded(s);
  s.col.state.behave = (n) => (n === 3 ? { status: 400, body: JSON.stringify({ code: 'invalid_routing', message: 'routing number not recognised' }) } : undefined);
  s.setDay('2026-06-11');
  const out = await s.ach.disbursePayRun(s.company.id, s.run.id);
  assert.equal(s.col.byType('CREDIT').length, 1);
  assert.deepEqual(s.legs('employee_payout').map((l) => l.status).sort(), ['failed', 'submitted']);
  const failed = s.legs('employee_payout').find((l) => l.status === 'failed')!;
  assert.match(failed.failureMessage!, /routing number not recognised/);
  assert.equal(s.store.achFiles.get(s.legs('employee_payout').find((l) => l.status === 'submitted')!.fileId!)!.status, 'accepted');
  assert.ok(out);
});

test('a lost answer is retried with the same key and never creates a second transfer', async () => {
  const s = await setup();
  await funded(s);
  s.col.state.behave = (n) => (n === 2 ? 'lose_response' : undefined); // Column creates the second credit, then the answer is lost
  s.setDay('2026-06-11');
  await s.ach.disbursePayRun(s.company.id, s.run.id);
  const file = s.store.achFiles.where((f) => f.runId === s.run.id && f.kind === 'credit')[0]!;
  assert.equal(file.status, 'queued');
  assert.equal(file.retryable, true);
  s.col.state.behave = undefined;
  await s.tick();
  assert.equal(s.col.byType('CREDIT').length, 2, 'two employees, two transfers, however many tries');
  assert.equal(s.store.achFiles.get(file.id)!.status, 'accepted');
  assert.deepEqual(s.legs('employee_payout').map((l) => l.status), ['submitted', 'submitted']);
  const keys = s.col.posts().filter((r) => JSON.parse(r.body!).type === 'CREDIT').map((r) => r.headers['idempotency-key']);
  assert.equal(new Set(keys).size, 2, 'the repeated try used the same key as the first');
});

test('a payment already at the bank is not sent again when the rest are retried', async () => {
  const s = await setup();
  await funded(s);
  s.col.state.behave = (n) => (n === 3 ? { status: 503, body: '' } : undefined); // first credit goes through, second fails
  s.setDay('2026-06-11');
  await s.ach.disbursePayRun(s.company.id, s.run.id);
  const before = s.col.posts().length;
  s.col.state.behave = undefined;
  await s.tick();
  assert.equal(s.col.posts().length, before + 1, 'only the missing payment was sent');
  assert.deepEqual(s.logs, [], 'the retry ran without complaint');
  const file = s.store.achFiles.where((f) => f.runId === s.run.id && f.kind === 'credit')[0]!;
  assert.ok(file.entries.every((e) => e.externalId && e.bankTraceNumber && e.traceNumber !== e.bankTraceNumber), "the file's own trace numbers are kept alongside the bank's");
  assert.equal(s.col.byType('CREDIT').length, 2);
});

test('bad credentials leave every payment queued and retryable, and pay no one', async () => {
  const s = await setup();
  await funded(s);
  s.col.state.behave = () => ({ status: 401, body: '{}' });
  s.setDay('2026-06-11');
  await s.ach.disbursePayRun(s.company.id, s.run.id);
  assert.equal(s.col.byType('CREDIT').length, 0);
  assert.deepEqual(s.legs('employee_payout').map((l) => l.status), ['queued', 'queued']);
  s.col.state.behave = undefined;
  await s.tick();
  assert.equal(s.col.byType('CREDIT').length, 2);
});

test('the client treats 401, 429 as not sent; 400 as rejected; 409 and 5xx as unknown', async () => {
  const answer = (status: number) => new ColumnClient({ apiKey: KEY, bankAccountId: 'b', http: async () => ({ status, body: '{"message":"x"}' }) }).createTransfer({ idempotencyKey: 'k', type: 'CREDIT', amountCents: 1, entryClassCode: 'PPD', effectiveDate: '2026-06-12', companyName: 'X', entryDescription: 'PAYROLL', description: 'd', receiverName: 'A', receiverId: '1', counterparty: { routingNumber: ROUTING_2, accountNumber: '1', accountType: 'checking', name: 'A' } }).then(() => 'ok', (e: BankApiError) => e.outcome);
  assert.deepEqual(await Promise.all([401, 403, 429, 400, 404, 409, 500, 503].map(answer)), ['not_sent', 'not_sent', 'not_sent', 'rejected', 'rejected', 'unknown', 'unknown', 'unknown']);
  assert.equal(await answer(200).then((r) => r), 'unknown', 'a success with no transfer id is not trusted');
});

// ---------------------------------------------------------------- cancel and prenotes

test('a transfer can be cancelled while Column still has it', async () => {
  const s = await setup();
  await s.ach.fundPayRun(s.company.id, s.run.id);
  const id = s.col.byType('DEBIT')[0]!.id;
  const client = new ColumnClient({ apiKey: KEY, bankAccountId: 'bacc_test', http: s.col.http });
  await client.cancelTransfer(id);
  assert.equal(s.col.transfers.get(id)!.status, 'CANCELED');
  await assert.rejects(() => client.cancelTransfer(id), (e: BankApiError) => e.outcome === 'rejected');
  await assert.rejects(() => client.cancelTransfer('../../etc'), (e: BankApiError) => e.outcome === 'unknown', 'ids are checked before they go in a URL');
});

test('prenotes go to Column as zero-dollar entries', async () => {
  const s = await setup({ employees: 0, run: false });
  const e = hire(s.store, s.company.id, { firstName: 'New', lastName: 'Hire', payType: { kind: 'hourly', rateCents: 1500 }, roleKey: 'line_cook', tipCreditNoticeDate: undefined });
  const acct = ready(s.store, e.id, '000555666777');
  s.store.tx(() => s.store.bankAccounts.put({ ...acct, status: 'pending', verification: { method: 'prenote', status: 'pending' } } as never));
  const out = await s.ach.submitPrenotes(s.company.id);
  assert.equal(out.accounts.length, 1);
  const t = s.col.all()[0]!;
  assert.equal(t.amount, 0);
  assert.equal(t.type, 'CREDIT');
});

// ---------------------------------------------------------------- configuration

test('column mode needs its key, account and routing number, and refuses a test key in production', () => {
  const base = { TOTALI_ACH_MODE: 'column', COLUMN_API_KEY: 'test_abc', COLUMN_BANK_ACCOUNT_ID: 'bacc_1', COLUMN_ROUTING_NUMBER: ROUTING_2 };
  const cfg = loadConfig(base);
  assert.equal(cfg.ach.mode, 'column');
  assert.deepEqual(cfg.ach.column, { apiKey: 'test_abc', bankAccountId: 'bacc_1' });
  assert.deepEqual([cfg.ach.config.originator.odfiRoutingNumber, cfg.ach.config.originator.odfiName, cfg.ach.config.originator.companyId], [ROUTING_2, 'COLUMN NA', 'TOTALI0001']);
  assert.throws(() => loadConfig({ ...base, COLUMN_API_KEY: '' }), /COLUMN_API_KEY/);
  assert.throws(() => loadConfig({ ...base, COLUMN_BANK_ACCOUNT_ID: '' }), /COLUMN_BANK_ACCOUNT_ID/);
  assert.throws(() => loadConfig({ ...base, COLUMN_API_KEY: 'sk_whatever' }), /test_/);
  assert.throws(() => loadConfig({ ...base, COLUMN_ROUTING_NUMBER: '123456789' }), /COLUMN_ROUTING_NUMBER/);
  assert.throws(() => loadConfig({ ...base, NODE_ENV: 'production' }), /sandbox key/);
  assert.equal(loadConfig({ ...base, COLUMN_API_KEY: 'live_abc', NODE_ENV: 'production' }).ach.mode, 'column');
});
