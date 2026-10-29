import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/store.ts';
import { BankService, bankAccountView, numbersFor, payoutReadiness } from '../src/banking/accounts.ts';
import { nameTokens, ownerNamesMatch } from '../src/banking/names.ts';
import { debitAuthorizationText, recordDebitAuthorization, setFundingAccount } from '../src/banking/authorization.ts';
import { FakeStripe } from './fake-stripe.ts';
import { hire, newCompany, ROUTING } from './helpers.ts';

function setup() {
  const store = new Store();
  const stripe = new FakeStripe();
  const banks = new BankService(store, stripe, { now: () => new Date('2026-06-08T15:00:00Z') });
  const { company } = newCompany(store);
  const ana = hire(store, company.id, { firstName: 'Ana', lastName: 'Ruiz' });
  return { store, stripe, banks, company, ana };
}
const ACCT = '000123456789'; // ends 6789, the fake's default last4

test('owner names: order, case, punctuation, initials and company suffixes are ignored; strangers do not match', () => {
  assert.deepEqual([...nameTokens('Corner Table, LLC')], ['corner', 'table']);
  assert.equal(ownerNamesMatch('Corner Table LLC', ['CORNER TABLE LLC DBA CORNER TABLE RESTAURANT']), 'match');
  assert.equal(ownerNamesMatch('Ana Ruiz', ['RUIZ, ANA M']), 'match');
  assert.equal(ownerNamesMatch('Ana Ruiz', ['Ana Ruiz & Jose Ruiz']), 'match', 'a joint account');
  assert.equal(ownerNamesMatch('Ana Ruiz', ['José Ruiz']), 'mismatch');
  assert.equal(ownerNamesMatch('Ana Ruiz', ['Ana Lopez']), 'mismatch');
  assert.equal(ownerNamesMatch('Ana Ruiz', ['Someone Else', 'Ana Ruiz']), 'match', 'any owner may match');
  assert.equal(ownerNamesMatch('Ana Ruiz', []), 'unavailable');
  assert.equal(ownerNamesMatch('Ana Ruiz', ['  ']), 'unavailable');
});

test('a company bank link: Stripe confirms the account, the owner types the number, and the two must agree', async () => {
  const { store, stripe, banks, company } = setup();
  const s = await banks.startLink(company.id, { kind: 'company' });
  assert.match(s.clientSecret, /_secret$/);
  assert.deepEqual(s.permissions, ['balances', 'ownership']);
  const req = stripe.calls.find((c) => c.op === 'createFcSession')!.params as any;
  assert.deepEqual(req.permissions, ['balances', 'ownership']);
  assert.ok(!req.permissions.includes('payment_method'), 'Stripe is not asked for payment access: it does not move money');

  const fc = stripe.link(s.sessionId, { owners: ['CORNER TABLE LLC'], balance: { as_of: 1_780_000_000, cash: { available: { usd: 1_234_500 } } } });
  const acct = await banks.completeLink(company.id, { sessionId: s.sessionId, routingNumber: ROUTING, accountNumber: ACCT });
  assert.equal(acct.status, 'active');
  assert.equal(acct.holderType, 'business');
  assert.equal(acct.last4, '6789');
  assert.equal(acct.link!.fcAccountId, fc.id);
  assert.equal(acct.link!.ownership, 'match');
  assert.equal(acct.link!.balanceCents, 1_234_500);
  assert.equal(acct.verification.status, 'verified');
  // the full number is held encrypted, never in the clear or in any view
  assert.ok(!JSON.stringify(store.bankAccounts.all()).includes(ACCT));
  assert.ok(!JSON.stringify(bankAccountView(acct)).includes(ACCT));
  assert.equal(numbersFor(acct).accountNumber, ACCT);
  assert.equal(store.bankLinks.get(s.sessionId)!.completedAt !== undefined, true);
});

test('the typed number must match what Stripe confirmed', async () => {
  const { stripe, banks, company } = setup();
  const s = await banks.startLink(company.id, { kind: 'company' });
  stripe.link(s.sessionId, { owners: ['Corner Table LLC'] });
  await assert.rejects(banks.completeLink(company.id, { sessionId: s.sessionId, routingNumber: ROUTING, accountNumber: '000123450000' }), /same four digits/);
  await assert.rejects(banks.completeLink(company.id, { sessionId: s.sessionId, routingNumber: '110000001', accountNumber: ACCT }), /routing number is not valid/);
  await assert.rejects(banks.completeLink(company.id, { sessionId: s.sessionId, routingNumber: ROUTING, accountNumber: '12AB' }), /digits/);
  assert.ok(await banks.completeLink(company.id, { sessionId: s.sessionId, routingNumber: ROUTING, accountNumber: ACCT }));
});

test('a session is single-use, scoped to the company that started it, and must have a finished link', async () => {
  const { store, stripe, banks, company } = setup();
  const s = await banks.startLink(company.id, { kind: 'company' });
  await assert.rejects(banks.completeLink(company.id, { sessionId: s.sessionId, routingNumber: ROUTING, accountNumber: ACCT }), (e: any) => e.code === 'link_not_finished');
  stripe.link(s.sessionId, { owners: ['Corner Table LLC'] });
  const { company: other } = newCompany(store, { ein: '98-7654321', legalName: 'Other Cafe' });
  await assert.rejects(banks.completeLink(other.id, { sessionId: s.sessionId, routingNumber: ROUTING, accountNumber: ACCT }), /Unknown bank-link session/);
  await banks.completeLink(company.id, { sessionId: s.sessionId, routingNumber: ROUTING, accountNumber: ACCT });
  await assert.rejects(banks.completeLink(company.id, { sessionId: s.sessionId, routingNumber: ROUTING, accountNumber: ACCT }), (e: any) => e.code === 'link_already_used');
  await assert.rejects(banks.completeLink(company.id, { sessionId: 'fcsess_nope', routingNumber: ROUTING, accountNumber: ACCT }), /Unknown bank-link session/);
});

test('an account that belongs to a different Stripe customer is refused', async () => {
  const { stripe, banks, company } = setup();
  const s = await banks.startLink(company.id, { kind: 'company' });
  stripe.link(s.sessionId, { owners: ['Corner Table LLC'], account_holder: { type: 'customer', customer: 'cus_someone_else' } });
  await assert.rejects(banks.completeLink(company.id, { sessionId: s.sessionId, routingNumber: ROUTING, accountNumber: ACCT }), /belongs to someone else/);
});

test('only active checking and savings accounts are accepted; several linked accounts need a choice', async () => {
  const { stripe, banks, company } = setup();
  let s = await banks.startLink(company.id, { kind: 'company' });
  stripe.link(s.sessionId, { category: 'credit', subcategory: 'credit_card' });
  await assert.rejects(banks.completeLink(company.id, { sessionId: s.sessionId, routingNumber: ROUTING, accountNumber: ACCT }), /checking and savings/);

  s = await banks.startLink(company.id, { kind: 'company' });
  stripe.link(s.sessionId, { status: 'inactive' });
  await assert.rejects(banks.completeLink(company.id, { sessionId: s.sessionId, routingNumber: ROUTING, accountNumber: ACCT }), (e: any) => e.code === 'link_inactive');

  s = await banks.startLink(company.id, { kind: 'company' });
  const a1 = stripe.link(s.sessionId, { owners: ['Corner Table LLC'], subcategory: 'savings', last4: '1111' });
  stripe.link(s.sessionId, { owners: ['Corner Table LLC'] });
  await assert.rejects(banks.completeLink(company.id, { sessionId: s.sessionId, routingNumber: ROUTING, accountNumber: ACCT }), (e: any) => e.details.accounts.length === 2);
  const acct = await banks.completeLink(company.id, { sessionId: s.sessionId, fcAccountId: a1.id, routingNumber: ROUTING, accountNumber: '000000001111' });
  assert.equal(acct.accountType, 'savings');
});

test('the same bank account cannot be set up twice', async () => {
  const { stripe, banks, company } = setup();
  const s = await banks.startLink(company.id, { kind: 'company' });
  const fc = stripe.link(s.sessionId, { owners: ['Corner Table LLC'] });
  await banks.completeLink(company.id, { sessionId: s.sessionId, routingNumber: ROUTING, accountNumber: ACCT });
  const s2 = await banks.startLink(company.id, { kind: 'company' });
  stripe.sessions.get(s2.sessionId)!.accounts.push(fc);
  await assert.rejects(banks.completeLink(company.id, { sessionId: s2.sessionId, routingNumber: ROUTING, accountNumber: ACCT }), (e: any) => e.code === 'account_exists');
});

test('ownership: a mismatch is held, an unavailable result is held until re-checked, an employee falls back to a prenote', async () => {
  const { stripe, banks, company, ana } = setup();

  let s = await banks.startLink(company.id, { kind: 'company' });
  stripe.link(s.sessionId, { owners: ['Somebody Else Inc'] });
  const mismatch = await banks.completeLink(company.id, { sessionId: s.sessionId, routingNumber: ROUTING, accountNumber: ACCT });
  assert.equal(mismatch.status, 'pending');
  assert.equal(mismatch.verification.status, 'failed');
  assert.equal(mismatch.link!.ownership, 'mismatch');

  s = await banks.startLink(company.id, { kind: 'company' });
  const fc = stripe.link(s.sessionId, { last4: '4242' });
  const unavailable = await banks.completeLink(company.id, { sessionId: s.sessionId, routingNumber: ROUTING, accountNumber: '000000004242' });
  assert.equal(unavailable.status, 'pending');
  assert.equal(unavailable.link!.ownership, 'unavailable');
  assert.equal(unavailable.verification.method, 'bank_link', 'a company cannot fall back to a prenote');

  // the bank starts reporting owners: re-checking activates it
  stripe.owners.set(fc.id, ['Corner Table LLC']);
  const rechecked = await banks.refreshLink(company.id, unavailable.id);
  assert.equal(rechecked.status, 'active');
  assert.equal(rechecked.link!.ownership, 'match');

  // an employee whose bank reports no owners is verified by prenote instead
  const es = await banks.startLink(company.id, { kind: 'employee', employeeId: ana.id });
  assert.deepEqual(es.permissions, ['ownership'], 'employees are not asked for balances');
  stripe.link(es.sessionId);
  const emp = await banks.completeLink(company.id, { sessionId: es.sessionId, routingNumber: ROUTING, accountNumber: ACCT });
  assert.equal(emp.status, 'pending');
  assert.equal(emp.verification.method, 'prenote');
  assert.equal(emp.holderType, 'individual');
});

test('an employee whose bank reports a matching owner is active at once', async () => {
  const { stripe, banks, company, ana } = setup();
  const s = await banks.startLink(company.id, { kind: 'employee', employeeId: ana.id });
  stripe.link(s.sessionId, { owners: ['Ana Ruiz'] });
  const acct = await banks.completeLink(company.id, { sessionId: s.sessionId, routingNumber: ROUTING, accountNumber: ACCT });
  assert.equal(acct.status, 'active');
  assert.equal(acct.ownerId, ana.id);
});

test('a Stripe customer is created once per owner and reused', async () => {
  const { store, stripe, banks, company } = setup();
  await banks.startLink(company.id, { kind: 'company' });
  await banks.startLink(company.id, { kind: 'company' });
  assert.equal(stripe.calls.filter((c) => c.op === 'createCustomer').length, 1);
  assert.ok(store.companies.get(company.id)!.stripeCustomerId);
});

test('Stripe tokenized account numbers are recorded as informational, not used', async () => {
  const { stripe, banks, company } = setup();
  const s = await banks.startLink(company.id, { kind: 'company' });
  stripe.link(s.sessionId, { owners: ['Corner Table LLC'], account_numbers: [{ identifier_type: 'tokenized_account_number', status: 'transactable' }] });
  const acct = await banks.completeLink(company.id, { sessionId: s.sessionId, routingNumber: ROUTING, accountNumber: ACCT });
  assert.equal(acct.link!.stripeNumberType, 'tokenized');
  assert.equal(numbersFor(acct).accountNumber, ACCT, 'the number the account holder typed is the one used');
});

test('manual employee accounts are validated and held for a prenote; staff can verify one, with a reason', async () => {
  const { banks, company, ana } = setup();
  assert.throws(() => banks.addManualAccount(company.id, { employeeId: ana.id, routingNumber: '110000001', accountNumber: ACCT, accountType: 'checking' }), /routing number is not valid/);
  assert.throws(() => banks.addManualAccount(company.id, { employeeId: 'emp_nope', routingNumber: ROUTING, accountNumber: ACCT, accountType: 'checking' }), /not at this company/);
  const a = banks.addManualAccount(company.id, { employeeId: ana.id, routingNumber: ROUTING, accountNumber: ACCT, accountType: 'savings' });
  assert.equal(a.status, 'pending');
  assert.throws(() => banks.adminActivate(company.id, a.id, '  '), /reason is required/);
  const active = banks.adminActivate(company.id, a.id, 'called the employee and confirmed');
  assert.equal(active.status, 'active');
  assert.match(active.verification.reason!, /Verified by Totali staff/);
});

test('payout readiness needs every account in the split to be active', async () => {
  const { store, banks, company, ana } = setup();
  assert.equal(payoutReadiness(store, store.employees.get(ana.id)!).ready, false);
  const a = banks.addManualAccount(company.id, { employeeId: ana.id, routingNumber: ROUTING, accountNumber: ACCT, accountType: 'checking' });
  store.tx(() => store.employees.put({ ...store.employees.get(ana.id)!, payoutAccounts: [{ bankAccountId: a.id, allocation: { kind: 'remainder' } }] }));
  assert.match(payoutReadiness(store, store.employees.get(ana.id)!).reason!, /pending/);
  banks.adminActivate(company.id, a.id, 'verified');
  assert.equal(payoutReadiness(store, store.employees.get(ana.id)!).ready, true);
  banks.disable(company.id, a.id, 'closed by employee');
  assert.match(payoutReadiness(store, store.employees.get(ana.id)!).reason!, /disabled \(closed by employee\)/);
});

test('the debit authorization is recorded against one business account, and changing the account clears it', async () => {
  const { store, stripe, banks, company } = setup();
  const s = await banks.startLink(company.id, { kind: 'company' });
  stripe.link(s.sessionId, { owners: ['Corner Table LLC'] });
  const acct = await banks.completeLink(company.id, { sessionId: s.sessionId, routingNumber: ROUTING, accountNumber: ACCT });
  const text = debitAuthorizationText(company, acct);
  assert.match(text, /Corner Table LLC/);
  assert.match(text, /ending 6789/);
  assert.throws(() => recordDebitAuthorization(store, company.id, { bankAccountId: acct.id, acceptedBy: 'Owner', accept: false }), /accept must be true/);
  assert.throws(() => recordDebitAuthorization(store, company.id, { bankAccountId: acct.id, acceptedBy: ' ', accept: true }), /acceptedBy/);
  const auth = recordDebitAuthorization(store, company.id, { bankAccountId: acct.id, acceptedBy: 'Owner Person', accept: true, ip: '203.0.113.9', now: new Date('2026-06-08T15:00:00Z') });
  assert.deepEqual({ acct: auth.bankAccountId, by: auth.acceptedBy, at: auth.acceptedAt, ip: auth.ip }, { acct: acct.id, by: 'Owner Person', at: '2026-06-08T15:00:00.000Z', ip: '203.0.113.9' });
  assert.equal(store.companies.get(company.id)!.funding.debitAuthorization!.textVersion, 'draft-1');

  // an employee's account is not a funding account
  const emp = banks.addManualAccount(company.id, { employeeId: hire(store, company.id).id, routingNumber: ROUTING, accountNumber: ACCT, accountType: 'checking' });
  assert.throws(() => setFundingAccount(store, company.id, emp.id), /own bank accounts/);

  // a second business account: choosing it clears the authorization
  const s2 = await banks.startLink(company.id, { kind: 'company' });
  stripe.link(s2.sessionId, { owners: ['Corner Table LLC'], last4: '5555' });
  const second = await banks.completeLink(company.id, { sessionId: s2.sessionId, routingNumber: ROUTING, accountNumber: '000000005555' });
  const c = setFundingAccount(store, company.id, second.id);
  assert.equal(c.funding.bankAccountId, second.id);
  assert.equal(c.funding.debitAuthorization, undefined);
  assert.equal(setFundingAccount(store, company.id, second.id).funding.debitAuthorization, undefined);
});

test('an account that is not active cannot be authorized for debits', async () => {
  const { store, stripe, banks, company } = setup();
  const s = await banks.startLink(company.id, { kind: 'company' });
  stripe.link(s.sessionId, { owners: ['Somebody Else'] });
  const acct = await banks.completeLink(company.id, { sessionId: s.sessionId, routingNumber: ROUTING, accountNumber: ACCT });
  assert.throws(() => recordDebitAuthorization(store, company.id, { bankAccountId: acct.id, acceptedBy: 'Owner', accept: true }), (e: any) => e.code === 'bank_account_not_active');
});
