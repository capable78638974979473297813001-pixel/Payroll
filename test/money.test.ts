import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/store.ts';
import { MoneyService, type StripeEvent } from '../src/money/service.ts';
import { ledgerBalances } from '../src/money/ledger.ts';
import { approvePayRun, draftPayRun, voidPayRun } from '../src/payroll/payRuns.ts';
import { FakeStripe } from './fake-stripe.ts';
import { day, hire, newCompany, shiftsFor } from './helpers.ts';

const RUN = { periodStart: day(0), periodEnd: day(6), checkDate: day(11) };
let evSeq = 0;
const ev = (type: string, object: Record<string, any>, account?: string): StripeEvent => ({ id: `evt_${++evSeq}`, type, ...(account ? { account } : {}), data: { object } });

/** A company with a linked bank, two onboarded employees and one approved run. */
async function setup(opts: { holdHours?: number; ready?: boolean } = {}) {
  const store = new Store();
  const stripe = new FakeStripe();
  const money = new MoneyService(store, stripe, { holdHours: opts.holdHours ?? 0 });
  const { company } = newCompany(store);

  // employer links a bank: customer + SetupIntent, then Stripe's webhook says it succeeded
  const setup = await money.setupCompanyFunding(company.id);
  assert.match(setup.clientSecret, /^seti_secret_/);
  await money.handleEvent(ev('setup_intent.succeeded', { id: setup.setupIntentId, payment_method: 'pm_bank_1', metadata: { company_id: company.id } }));

  const a = hire(store, company.id, { firstName: 'Ana', lastName: 'Ruiz', payType: { kind: 'hourly', rateCents: 1500 }, roleKey: 'line_cook', tipCreditNoticeDate: undefined });
  const b = hire(store, company.id, { firstName: 'Ben', lastName: 'Okafor', payType: { kind: 'hourly', rateCents: 1800 }, roleKey: 'line_cook', tipCreditNoticeDate: undefined });
  for (const e of [a, b]) {
    if (opts.ready !== false) {
      await money.startEmployeePayoutOnboarding(company.id, e.id, { returnUrl: 'https://app.totali.test/done', refreshUrl: 'https://app.totali.test/retry' });
      const acct = store.employees.get(e.id)!.payout.stripeAccountId!;
      await money.handleEvent(ev('account.updated', { id: acct, payouts_enabled: true, details_submitted: true, external_accounts: { data: [{ last4: '6789' }] } }));
    }
    shiftsFor(store, company.id, e.id, [0, 1, 2, 3, 4], { minutes: 480 });
  }
  const draft = draftPayRun(store, company.id, RUN);
  const run = approvePayRun(store, company.id, draft.id, { acknowledgeReviewIssues: true });
  return { store, stripe, money, company, run, a, b };
}

test('linking a bank and onboarding employees happens through Stripe, never through Totali', async () => {
  const { store, company, a, stripe } = await setup();
  const c = store.companies.get(company.id)!;
  assert.equal(c.funding.status, 'ready');
  assert.equal(c.funding.paymentMethodId, 'pm_bank_1');
  assert.equal(c.funding.bankLast4, '6789');
  const e = store.employees.get(a.id)!;
  assert.equal(e.payout.status, 'ready');
  assert.match(e.payout.stripeAccountId!, /^acct_/);
  // no account or routing number ever passed through Totali's stored state
  assert.ok(!JSON.stringify(store.employees.all()).match(/routing|accountNumber/i));
  assert.ok(stripe.calls.some((x) => x.op === 'createAccountLink'));
});

test('full flow: fund, debit settles, hold, disburse, completed; ledger balances at every step', async () => {
  const { store, stripe, money, company, run } = await setup({ holdHours: 0 });
  const funded = await money.fundPayRun(company.id, run.id);
  assert.equal(funded.leg.status, 'processing');
  assert.equal(funded.leg.amountCents, run.totals.fundingRequiredCents);
  assert.equal(store.payRuns.get(run.id)!.status, 'funding');
  await assert.rejects(money.disbursePayRun(company.id, run.id), (e: any) => e.code === 'not_funded');

  // the bank settles the debit days later: Stripe tells us by webhook
  const pi = stripe.settle([...stripe.intents.keys()][0]);
  await money.handleEvent(ev('payment_intent.succeeded', { id: pi.id, amount: pi.amount, latest_charge: pi.latest_charge, metadata: { run_id: run.id, leg_id: funded.leg.id } }));
  assert.equal(store.payRuns.get(run.id)!.status, 'funded');
  let bal = ledgerBalances(store, company.id);
  const t = run.totals;
  assert.deepEqual(bal, { stripe_cash: t.fundingRequiredCents, employee_net_pay: t.payableCents, tax_withheld: t.employeeTaxCents, tax_employer: t.employerTaxCents, deductions_held: t.deductionsCents });

  const out = await money.disbursePayRun(company.id, run.id);
  assert.equal(out.status, 'completed');
  assert.equal(out.paid.length, 2);
  assert.equal(stripe.transfers.length, 2);
  assert.equal(stripe.transfers.reduce((a, x) => a + x.amount, 0), t.payableCents);
  bal = ledgerBalances(store, company.id);
  assert.equal(bal.employee_net_pay, 0);
  assert.equal(bal.stripe_cash, t.employeeTaxCents + t.employerTaxCents + t.deductionsCents, 'what remains is exactly the tax and deduction money held');

  // every ledger entry balanced
  for (const e of store.ledger.all()) {
    assert.equal(e.lines.reduce((s, l) => s + l.debitCents, 0), e.lines.reduce((s, l) => s + l.creditCents, 0));
  }
  // calling again is a no-op, not a second payment
  await assert.rejects(money.disbursePayRun(company.id, run.id), (e: any) => e.code === 'not_funded');
  assert.equal(stripe.transfers.length, 2);
});

test('no payout before the debit succeeds, and not before the hold has passed', async () => {
  const { store, stripe, company, run } = await setup();
  let clock = new Date('2026-06-12T12:00:00Z');
  const money = new MoneyService(store, stripe, { holdHours: 48, now: () => clock });
  const funded = await money.fundPayRun(company.id, run.id);
  await assert.rejects(money.disbursePayRun(company.id, run.id), (e: any) => e.code === 'not_funded');
  const pi = stripe.settle([...stripe.intents.keys()][0]);
  await money.handleEvent(ev('payment_intent.succeeded', { id: pi.id, amount: pi.amount, metadata: { leg_id: funded.leg.id } }));
  clock = new Date('2026-06-13T12:00:00Z'); // 24h later
  await assert.rejects(money.disbursePayRun(company.id, run.id), (e: any) => e.code === 'funds_on_hold');
  assert.equal(stripe.transfers.length, 0);
  clock = new Date('2026-06-14T12:01:00Z');
  assert.equal((await money.disbursePayRun(company.id, run.id)).status, 'completed');
});

test('a debit that succeeds immediately funds the run in the same call', async () => {
  const { stripe, money, company, run, store } = await setup();
  stripe.debitOutcome = 'succeeded';
  await money.fundPayRun(company.id, run.id);
  assert.equal(store.payRuns.get(run.id)!.status, 'funded');
});

test('a declined debit returns the run to approved and a retry uses a fresh idempotency key', async () => {
  const { store, stripe, money, company, run } = await setup();
  stripe.debitOutcome = 'declined';
  const first = await money.fundPayRun(company.id, run.id);
  assert.equal(first.leg.status, 'failed');
  assert.equal(store.payRuns.get(run.id)!.status, 'approved');
  stripe.debitOutcome = 'succeeded';
  const second = await money.fundPayRun(company.id, run.id);
  assert.equal(second.leg.attempt, 2);
  assert.notEqual(second.leg.idempotencyKey, first.leg.idempotencyKey);
  assert.equal(store.payRuns.get(run.id)!.status, 'funded');
});

test('funding twice never creates two debits', async () => {
  const { stripe, money, company, run } = await setup();
  await money.fundPayRun(company.id, run.id);
  await money.fundPayRun(company.id, run.id);
  assert.equal([...stripe.intents.values()].length, 1);
});

test('a dropped connection mid-disbursement leaves the leg open; the retry reuses its key and pays exactly once', async () => {
  const { store, stripe, money, company, run } = await setup();
  stripe.debitOutcome = 'succeeded';
  await money.fundPayRun(company.id, run.id);
  // Stripe executes the first transfer but the response is lost
  stripe.dropNextTransfers = 1;
  stripe.dropAfterExecuting = true;
  const first = await money.disbursePayRun(company.id, run.id);
  assert.equal(first.pending.length, 1);
  assert.equal(first.status, 'disbursing');
  const second = await money.disbursePayRun(company.id, run.id);
  assert.equal(second.status, 'completed');
  assert.equal(stripe.transfers.length, 2, 'exactly one transfer per employee despite the retry');
  assert.equal(ledgerBalances(store, company.id).employee_net_pay, 0);
});

test('a rejected transfer fails that leg only; retrying later uses a new key and completes', async () => {
  const { store, stripe, money, company, run, b } = await setup();
  stripe.debitOutcome = 'succeeded';
  await money.fundPayRun(company.id, run.id);
  const bAcct = store.employees.get(b.id)!.payout.stripeAccountId!;
  stripe.rejectTransfersTo.add(bAcct);
  const first = await money.disbursePayRun(company.id, run.id);
  assert.equal(first.failed.length, 1);
  assert.equal(first.paid.length, 1);
  assert.equal(first.status, 'disbursing');
  stripe.rejectTransfersTo.clear();
  const second = await money.disbursePayRun(company.id, run.id);
  assert.equal(second.paid.length, 1);
  assert.equal(second.status, 'completed');
  assert.equal(stripe.transfers.length, 2);
  const legs = store.legs.where((l) => l.employeeId === b.id);
  assert.deepEqual(legs.map((l) => l.attempt).sort(), [1, 2]);
});

test('an employee without a bank account waits; the run completes once they finish onboarding', async () => {
  const { store, stripe, money, company, run, a } = await setup({ ready: false });
  // onboard only Ana
  await money.startEmployeePayoutOnboarding(company.id, a.id, { returnUrl: 'https://app.totali.test/done', refreshUrl: 'https://app.totali.test/retry' });
  const acct = store.employees.get(a.id)!.payout.stripeAccountId!;
  await money.handleEvent(ev('account.updated', { id: acct, payouts_enabled: true, details_submitted: true }));
  // the run was drafted while neither was ready; re-draft is not needed because funding uses approved numbers
  stripe.debitOutcome = 'succeeded';
  await money.fundPayRun(company.id, run.id);
  const first = await money.disbursePayRun(company.id, run.id);
  assert.equal(first.paid.length, 1);
  assert.equal(first.waitingForBankAccount.length, 1);
  assert.equal(first.status, 'disbursing');
  assert.ok(ledgerBalances(store, company.id).employee_net_pay > 0, 'the unpaid employee is still owed');
  const bId = first.waitingForBankAccount[0].employeeId;
  await money.startEmployeePayoutOnboarding(company.id, bId, { returnUrl: 'https://app.totali.test/done', refreshUrl: 'https://app.totali.test/retry' });
  await money.handleEvent(ev('account.updated', { id: store.employees.get(bId)!.payout.stripeAccountId, payouts_enabled: true, details_submitted: true }));
  const second = await money.disbursePayRun(company.id, run.id);
  assert.equal(second.status, 'completed');
  assert.equal(ledgerBalances(store, company.id).employee_net_pay, 0);
});

test('Stripe balance below the disbursement: nothing is sent', async () => {
  const { stripe, money, company, run } = await setup();
  stripe.debitOutcome = 'succeeded';
  await money.fundPayRun(company.id, run.id);
  stripe.balanceCents = 100;
  await assert.rejects(money.disbursePayRun(company.id, run.id), (e: any) => e.code === 'insufficient_stripe_balance');
  assert.equal(stripe.transfers.length, 0);
});

test('an ACH return after employees were paid raises an alert and the ledger shows the exposure', async () => {
  const { store, stripe, money, company, run } = await setup();
  stripe.debitOutcome = 'succeeded';
  await money.fundPayRun(company.id, run.id);
  await money.disbursePayRun(company.id, run.id);
  const pi = [...stripe.intents.values()][0];
  await money.handleEvent(ev('charge.dispute.created', { payment_intent: pi.id, reason: 'insufficient_funds' }));
  const r = store.payRuns.get(run.id)!;
  assert.equal(r.alerts![0].code, 'ach_return_after_payout');
  const bal = ledgerBalances(store, company.id);
  assert.equal(bal.stripe_cash, -run.totals.payableCents, 'the platform is out the net pay it already sent');
});

test('an ACH return before payout puts the run back to approved so nothing is sent', async () => {
  const { store, stripe, money, company, run } = await setup({ holdHours: 48 });
  stripe.debitOutcome = 'succeeded';
  await money.fundPayRun(company.id, run.id);
  const pi = [...stripe.intents.values()][0];
  await money.handleEvent(ev('charge.dispute.created', { payment_intent: pi.id, reason: 'insufficient_funds' }));
  assert.equal(store.payRuns.get(run.id)!.status, 'approved');
  assert.deepEqual(ledgerBalances(store, company.id), { stripe_cash: 0, employee_net_pay: 0, tax_withheld: 0, tax_employer: 0, deductions_held: 0 });
  assert.equal(stripe.transfers.length, 0);
});

test('webhooks are idempotent: a replayed event changes nothing', async () => {
  const { store, stripe, money, company, run } = await setup();
  const funded = await money.fundPayRun(company.id, run.id);
  const pi = stripe.settle([...stripe.intents.keys()][0]);
  const e = ev('payment_intent.succeeded', { id: pi.id, amount: pi.amount, metadata: { leg_id: funded.leg.id } });
  assert.equal((await money.handleEvent(e)).duplicate, false);
  const before = store.ledger.all().length;
  assert.equal((await money.handleEvent(e)).duplicate, true);
  assert.equal(store.ledger.all().length, before);
});

test('a funding amount that does not match the run is never treated as funded', async () => {
  const { store, money, company, run, stripe } = await setup();
  const funded = await money.fundPayRun(company.id, run.id);
  const pi = [...stripe.intents.values()][0];
  await money.handleEvent(ev('payment_intent.succeeded', { id: pi.id, amount: pi.amount - 1, metadata: { leg_id: funded.leg.id } }));
  assert.notEqual(store.payRuns.get(run.id)!.status, 'funded');
  assert.equal(store.payRuns.get(run.id)!.alerts![0].code, 'funding_amount_mismatch');
});

test('a run cannot be voided once funding has started', async () => {
  const { store, money, company, run } = await setup();
  await money.fundPayRun(company.id, run.id);
  assert.throws(() => voidPayRun(store, company.id, run.id), (e: any) => e.code === 'money_in_motion');
});

test('funding needs a linked bank; onboarding links must be https', async () => {
  const store = new Store();
  const money = new MoneyService(store, new FakeStripe(), { holdHours: 0 });
  const { company } = newCompany(store);
  const e = hire(store, company.id);
  shiftsFor(store, company.id, e.id, [0]);
  const run = approvePayRun(store, company.id, draftPayRun(store, company.id, RUN).id, { acknowledgeReviewIssues: true });
  await assert.rejects(money.fundPayRun(company.id, run.id), (x: any) => x.code === 'funding_not_ready');
  await assert.rejects(money.startEmployeePayoutOnboarding(company.id, e.id, { returnUrl: 'http://evil.test/x', refreshUrl: 'https://ok.test/y' }), /https/);
});

test('reconcile recovers from a lost webhook: the debit settled but we never heard', async () => {
  const { store, stripe, money, company, run } = await setup({ holdHours: 0 });
  const { reconcile } = await import('../src/money/service.ts');
  await money.fundPayRun(company.id, run.id);
  stripe.settle([...stripe.intents.keys()][0]); // the bank settled; no webhook arrived
  assert.equal(store.payRuns.get(run.id)!.status, 'funding');
  await reconcile(money, store, { autoDisburse: false });
  assert.equal(store.payRuns.get(run.id)!.status, 'funded');
  await reconcile(money, store, { autoDisburse: true });
  assert.equal(store.payRuns.get(run.id)!.status, 'completed');
  assert.equal(stripe.transfers.length, 2);
  await reconcile(money, store, { autoDisburse: true }); // running it again moves nothing
  assert.equal(stripe.transfers.length, 2);
});
