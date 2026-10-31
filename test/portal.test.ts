import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/store.ts';
import { PortalService } from '../src/portal/service.ts';
import { DashboardService } from '../src/dashboard/service.ts';
import { OutboxMailer } from '../src/mail/mailer.ts';
import { BankService } from '../src/banking/accounts.ts';
import { saveWeek } from '../src/domain/weekEntry.ts';
import { draftPayRun } from '../src/payroll/payRuns.ts';
import { createCompanyFromSetup } from '../src/builder/finish.ts';
import { addEmployee } from '../src/domain/employees.ts';
import { ApiError } from '../src/lib/errors.ts';
import type { User } from '../src/accounts/types.ts';
import { ROUTING } from './helpers.ts';

const D = '2026-10-30';
let t = new Date(`${D}T15:00:00Z`).getTime();
function make() {
  t = new Date(`${D}T15:00:00Z`).getTime();
  const store = new Store(); const mailer = new OutboxMailer();
  const company = createCompanyFromSetup(store, { id: 'u1', businessName: 'Harbor Street Kitchen' } as User, 'restaurant', { state: 'MI', locations: [{ name: 'Detroit', city: 'Detroit', state: 'MI' }], team: '1-10', tips: { on: true, pool: 'hours' }, frequency: { value: 'weekly', weekday: 'friday' }, contractors: { on: false } }, D, new Date(t));
  store.tx(() => store.users.put({ id: 'u1', email: 'owner@harbor.test', firstName: 'Scott', lastName: 'Holdan', businessName: 'Harbor Street Kitchen', passwordHash: '', emailVerifiedAt: '2026-01-01', termsAcceptedAt: 'x', termsVersion: 'x', companyId: company.id, createdAt: '2026-01-01' }));
  const now = () => new Date(t);
  const banks = new BankService(store, {} as never, { now });
  const dash = new DashboardService(store, now);
  const svc = new PortalService(store, mailer, banks, dash, now);
  const mk = (first: string, last: string, email?: string) => addEmployee(store, company.id, { firstName: first, lastName: last, ...(email ? { email } : {}), roleKey: 'server', hireDate: '2026-01-05', payType: { kind: 'hourly', rateCents: 1700 }, ssn: `512-34-${1000 + Math.floor(Math.random() * 8000)}`, location: 'Detroit', tipCreditNoticeDate: '2026-01-05' });
  return { store, mailer, company, svc, mk, banks, advance: (ms: number) => { t += ms; } };
}
const refused = (fn: () => unknown, re: RegExp) => assert.throws(fn, (e: unknown) => e instanceof ApiError && re.test(`${e.code} ${e.message}`), String(re));
const refusedAsync = (p: Promise<unknown>, re: RegExp) => assert.rejects(p, (e: unknown) => e instanceof ApiError && re.test(`${e.code} ${e.message}`), String(re));
const PW = 'correct horse battery';
const REQUEST = { firstName: 'Priya', lastName: 'Raman', signature: 'Priya Raman', w4: { filingStatus: 'single', multipleJobs: false, children: 1, exemptions: 2 }, i9: { legalFirstName: 'Priya', legalLastName: 'Raman', dateOfBirth: '1996-04-12', status: 'citizen', ssn: '512-34-9001' }, deposit: { routingNumber: ROUTING, accountNumber: '000111112222', accountType: 'checking', bankName: 'Harbor CU', confirm: true } };

test('the owner gets a code that is easy to read aloud, good for three days; a new one is only made when asked for', () => {
  const { svc, company, advance } = make();
  const a = svc.access(company.id);
  assert.match(a.code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  assert.equal(a.daysLeft, 3); assert.equal(a.expired, false);
  assert.equal(svc.access(company.id).code, a.code, 'stable until asked');
  advance(2 * 86_400_000);
  assert.equal(svc.access(company.id).daysLeft, 1);
  advance(86_400_000 + 60_000);
  const gone = svc.access(company.id);
  assert.equal(gone.expired, true);
  assert.equal(gone.code, a.code, 'an expired code is not swapped behind the owner\'s back');
  const b = svc.rotate(company.id);
  assert.notEqual(b.code, a.code); assert.equal(b.expired, false); assert.equal(b.daysLeft, 3);
});

test('an employee makes an account with the code, an email and a password, and nothing is emailed to them', async () => {
  const { svc, company, mailer, store, advance } = make();
  const { code } = svc.access(company.id);
  await refusedAsync(svc.signUp('ZZZZ-ZZZZ', 'priya@harbor.test', PW), /code_invalid/);
  await refusedAsync(svc.signUp('', 'priya@harbor.test', PW), /code_invalid/);
  await refusedAsync(svc.signUp(code, 'not an email', PW), /email/);
  await refusedAsync(svc.signUp(code, 'priya@harbor.test', 'short'), /at least 10/);
  const { token } = await svc.signUp(code.toLowerCase().replace('-', ' '), ' Priya@Harbor.test ', PW);
  const who = svc.resolve(token)!;
  assert.equal(who.account.email, 'priya@harbor.test');
  assert.equal(who.account.status, 'draft'); assert.equal(who.employee, null);
  assert.equal(mailer.messages.length, 0, 'nothing is sent to the employee');
  assert.equal(JSON.stringify(store.portalSessions.all()).includes(token), false, 'only the hash is stored');
  assert.equal(JSON.stringify(store.portalAccounts.all()).includes(PW), false);
  await refusedAsync(svc.signUp(code, 'PRIYA@harbor.test', PW), /email_taken/);
  // signing in again, and the wrong password, which does not say which half was wrong
  await refusedAsync(svc.signIn('priya@harbor.test', 'wrong password!!'), /sign_in_failed/);
  await refusedAsync(svc.signIn('nobody@harbor.test', PW), /sign_in_failed/);
  const again = await svc.signIn('priya@harbor.test', PW);
  assert.ok(svc.resolve(again.token));
  svc.logout(again.token);
  assert.equal(svc.resolve(again.token), null);
  // after three days the code stops letting new people in, but people already in stay in
  advance(3 * 86_400_000 + 1000);
  await refusedAsync(svc.signUp(code, 'late@harbor.test', PW), /code_expired/);
  assert.ok(svc.resolve(token), 'an account made in time keeps working');
});

test('a request is checked when it is sent, and nothing is on the payroll until the owner approves', async () => {
  const { svc, company, store, banks } = make();
  const { code } = svc.access(company.id);
  const { token } = await svc.signUp(code, 'priya@harbor.test', PW);
  const account = () => svc.resolve(token)!.account;
  refused(() => svc.submitRequest(account(), { ...REQUEST, signature: 'Someone Else' }), /full name/);
  refused(() => svc.submitRequest(account(), { ...REQUEST, i9: { ...REQUEST.i9, ssn: '000-12-3456' } }), /SSN/);
  refused(() => svc.submitRequest(account(), { ...REQUEST, i9: { ...REQUEST.i9, dateOfBirth: '2999-01-01' } }), /date of birth/);
  refused(() => svc.submitRequest(account(), { ...REQUEST, deposit: { ...REQUEST.deposit, routingNumber: '123456789' } }), /routing/);
  refused(() => svc.submitRequest(account(), { ...REQUEST, deposit: { ...REQUEST.deposit, confirm: false } }), /Confirm/);
  assert.equal(account().status, 'draft', 'a bad request changes nothing');
  svc.submitRequest(account(), REQUEST);
  assert.equal(account().status, 'pending');
  assert.equal(store.employees.where((e) => e.companyId === company.id).length, 0, 'nobody is on the payroll yet');
  const raw = JSON.stringify(store.portalAccounts.all());
  assert.equal(raw.includes('512-34-9001') || raw.includes('000111112222'), false, 'the request is stored encrypted');
  refused(() => svc.submitRequest(account(), REQUEST), /already_sent/);
  const list = svc.requests(company.id);
  assert.equal(list.requests.length, 1);
  assert.deepEqual([list.requests[0]!.name, list.requests[0]!.email, list.requests[0]!.forms.deposit], ['Priya Raman', 'priya@harbor.test', true]);
  assert.equal(svc.access(company.id).requests, 1);
  refused(() => svc.approve(company.id, account().id, { roleKey: 'nobody', rateCents: 1500 }), /role/);
  const done = svc.approve(company.id, account().id, { roleKey: 'server', rateCents: 1550, location: 'Detroit', startDate: '2026-11-02', tipCreditNotice: true });
  const e = store.employees.get(done.employeeId)!;
  assert.deepEqual([e.firstName, e.lastName, e.email, e.hireDate, e.location], ['Priya', 'Raman', 'priya@harbor.test', '2026-11-02', 'Detroit']);
  assert.equal(e.payType.kind, 'hourly');
  assert.equal(e.federalW4.dependentCredit, 200_000);
  assert.equal(e.ssnLast4, '9001');
  assert.equal(e.tipCreditNoticeDate, '2026-11-02');
  assert.equal((e.workState.certificate as { allowances: number }).allowances, 2);
  assert.equal(e.onboarding!.i9!.section2At, undefined, 'section 2 of the I-9 is still the owner\'s to do');
  assert.ok(e.onboarding!.w4 && e.onboarding!.i9!.section1At && e.onboarding!.deposit);
  assert.equal(store.bankAccounts.get(e.payoutAccounts[0]!.bankAccountId)!.last4, '2222');
  assert.equal(account().status, 'approved'); assert.equal(account().requestEncrypted, undefined, 'the private copy is dropped once used');
  assert.equal(svc.resolve(token)!.employee!.id, e.id, 'the same login now opens their dashboard');
  assert.equal(svc.me(svc.resolve(token)!.employee!).employee.firstName, 'Priya');
  refused(() => svc.approve(company.id, account().id, { roleKey: 'server', rateCents: 1500 }), /not_pending/);
  void banks;
});

test('the owner can say no, with a reason, and the person fixes it and sends it again', async () => {
  const { svc, company } = make();
  const { code } = svc.access(company.id);
  const { token } = await svc.signUp(code, 'priya@harbor.test', PW);
  const account = () => svc.resolve(token)!.account;
  svc.submitRequest(account(), REQUEST);
  svc.decline(company.id, account().id, 'We aren\'t hiring in Ferndale.');
  assert.equal(account().status, 'declined');
  assert.equal(svc.accountView(account()).declineReason, 'We aren\'t hiring in Ferndale.');
  assert.equal(svc.requests(company.id).requests.length, 0);
  svc.reopen(account());
  assert.equal(account().status, 'draft');
  svc.submitRequest(account(), { ...REQUEST, deposit: undefined });
  assert.equal(account().summary!.forms.deposit, false, 'direct deposit can be left for later');
  refused(() => svc.reopen(account()), /not_declined/);
});

test('an account can be matched to someone the owner already added, so they are not on the team twice', async () => {
  const { svc, company, mk, store } = make();
  const existing = mk('Priya', 'Raman', 'priya@harbor.test'); const other = mk('Tom', 'Whitaker', 'tom@harbor.test');
  const { code } = svc.access(company.id);
  const { token } = await svc.signUp(code, 'priya@harbor.test', PW);
  const account = () => svc.resolve(token)!.account;
  svc.submitRequest(account(), REQUEST);
  const req = svc.requests(company.id);
  assert.equal(req.requests[0]!.sameEmail, existing.id, 'the matching email is offered');
  assert.equal(req.unlinked.length, 2);
  refused(() => svc.approve(company.id, account().id, { linkEmployeeId: 'emp_nope' }), /team/);
  const n = store.employees.where((e) => e.companyId === company.id).length;
  svc.approve(company.id, account().id, { linkEmployeeId: existing.id });
  assert.equal(store.employees.where((e) => e.companyId === company.id).length, n, 'no second Priya');
  assert.equal(svc.resolve(token)!.employee!.id, existing.id);
  // someone else cannot be linked to a person who already has a login
  const t2 = await svc.signUp(code, 'p2@harbor.test', PW);
  svc.submitRequest(svc.resolve(t2.token)!.account, REQUEST);
  refused(() => svc.approve(company.id, svc.resolve(t2.token)!.account.id, { linkEmployeeId: existing.id }), /already_linked/);
  void other;
});

test('someone who has left loses their dashboard, and one company cannot decide another company\'s requests', async () => {
  const { svc, company, store } = make();
  const { code } = svc.access(company.id);
  const { token } = await svc.signUp(code, 'priya@harbor.test', PW);
  svc.submitRequest(svc.resolve(token)!.account, REQUEST);
  refused(() => svc.approve('cmp_other', svc.resolve(token)!.account.id, { roleKey: 'server', rateCents: 1500 }), /not found|Company|Request/i);
  const { employeeId } = svc.approve(company.id, svc.resolve(token)!.account.id, { roleKey: 'server', rateCents: 1500 });
  store.tx(() => store.employees.put({ ...store.employees.get(employeeId)!, terminationDate: '2026-10-29' }));
  const who = svc.resolve(token)!;
  assert.equal(who.employee, null); assert.equal(who.ended, true);
  assert.equal(svc.accountView(who.account, who.ended).status, 'ended');
});

test('an employee sees their own stubs, hours and year to date, and nobody else\'s', async () => {
  const { svc, company, mk, store } = make();
  const elena = mk('Elena', 'Ruiz', 'elena@harbor.test'); const tom = mk('Tom', 'Whitaker', 'tom@harbor.test');
  saveWeek(store, company, { periodStart: '2026-10-19', periodEnd: '2026-10-25', entries: [{ employeeId: elena.id, regularMinutes: 1950, tipsCents: 41230 }, { employeeId: tom.id, regularMinutes: 1680 }] });
  const run = draftPayRun(store, company.id, { periodStart: '2026-10-19', periodEnd: '2026-10-25', checkDate: '2026-10-30' });
  assert.equal(svc.stubs(store.employees.get(elena.id)!).stubs.length, 0, 'a draft is not a stub yet');
  store.tx(() => store.payRuns.put({ ...run, status: 'approved' }));
  const e = store.employees.get(elena.id)!;
  const list = svc.stubs(e).stubs;
  assert.equal(list.length, 1);
  assert.equal(list[0]!.hours, 32.5);
  const detail = svc.stub(e, run.id);
  assert.equal(detail.line.netCents, run.paychecks.find((p) => p.employeeId === elena.id)!.netPayCents);
  assert.ok(detail.taxLines.length > 0 && detail.text.includes('Elena Ruiz') && !detail.text.includes('Tom Whitaker'));
  assert.throws(() => svc.stub(e, 'run_nope'), ApiError);
  const me = svc.me(e);
  assert.equal(me.employee.firstName, 'Elena');
  assert.equal(me.ytd.grossCents, list[0]!.grossCents);
  assert.equal(me.latest!.runId, run.id);
  assert.ok(me.theme && me.brand.name);
  const hrs = svc.hours(e, '2026-10-19', '2026-10-25');
  assert.equal(hrs.totalMinutes, 1950);
  assert.equal(hrs.tipsCents, 41230);
  assert.equal(JSON.stringify(svc.me(store.employees.get(tom.id)!)).includes('Elena'), false);
  assert.throws(() => svc.hours(e, '2026-10-25', '2026-10-19'), ApiError);
});

test('a new W-4 needs the employee\'s own signed name and applies from the next run', () => {
  const { svc, mk, store } = make();
  const e = mk('Elena', 'Ruiz', 'elena@harbor.test');
  refused(() => svc.updateW4(e, { filingStatus: 'single', signature: 'Someone Else' }), /full name/);
  const w = svc.updateW4(e, { filingStatus: 'married_joint', multipleJobs: true, children: 2, extraWithholdingCents: 2500, exemptions: 3, signature: 'elena ruiz' });
  assert.equal(w.filingStatus, 'married_joint');
  const s = store.employees.get(e.id)!;
  assert.equal(s.federalW4.dependentCredit, 400_000);
  assert.equal(s.federalW4.extraWithholding, 2500);
  assert.equal((s.workState.certificate as { allowances: number }).allowances, 3);
});

test('a change of bank account is only a request until the owner approves it', async () => {
  const { svc, mk, store, company, mailer, banks } = make();
  const e = mk('Elena', 'Ruiz', 'elena@harbor.test');
  const old = banks.addManualAccount(company.id, { employeeId: e.id, routingNumber: ROUTING, accountNumber: '000111112222', accountType: 'checking' });
  store.tx(() => store.employees.put({ ...store.employees.get(e.id)!, payoutAccounts: [{ bankAccountId: old.id, allocation: { kind: 'remainder' } }] }));
  const fresh = () => store.employees.get(e.id)!;
  await assert.rejects(svc.requestDeposit(fresh(), 'https://app.example', { routingNumber: ROUTING, accountNumber: '000999998888', accountType: 'savings' }), /Confirm/);
  await svc.requestDeposit(fresh(), 'https://app.example', { routingNumber: ROUTING, accountNumber: '000999998888', accountType: 'savings', confirm: true, bankName: 'New CU' });
  assert.equal(fresh().payoutAccounts[0]!.bankAccountId, old.id, 'nothing changed yet');
  assert.ok(fresh().pendingDeposit);
  assert.ok(mailer.messages.at(-1)!.to === 'owner@harbor.test' && /asked to change/.test(mailer.messages.at(-1)!.subject));
  assert.equal(svc.me(fresh()).deposit.pending!.last4, '8888');
  await assert.rejects(svc.requestDeposit(fresh(), 'x', { routingNumber: ROUTING, accountNumber: '000777776666', accountType: 'checking', confirm: true }), /already have a change/);
  svc.decideDeposit(company.id, e.id, true);
  assert.equal(store.bankAccounts.get(fresh().payoutAccounts[0]!.bankAccountId)!.last4, '8888');
  assert.equal(store.bankAccounts.get(old.id)!.status, 'disabled');
  assert.equal(fresh().pendingDeposit, undefined);
  // declining leaves the account alone and disables the request
  await svc.requestDeposit(fresh(), 'x', { routingNumber: ROUTING, accountNumber: '000555554444', accountType: 'checking', confirm: true });
  const keep = fresh().payoutAccounts[0]!.bankAccountId;
  svc.decideDeposit(company.id, e.id, false);
  assert.equal(fresh().payoutAccounts[0]!.bankAccountId, keep);
  // and the employee can take a request back
  await svc.requestDeposit(fresh(), 'x', { routingNumber: ROUTING, accountNumber: '000333332222', accountType: 'checking', confirm: true });
  svc.cancelDeposit(fresh());
  assert.equal(fresh().pendingDeposit, undefined);
});

test('a forgotten password: free before the owner approves the login, and the owner has to allow it afterwards', async () => {
  const { svc, company, advance, store } = make();
  const { code } = svc.access(company.id);
  const first = await svc.signUp(code, 'priya@harbor.test', PW);
  const account = () => store.portalAccounts.where((a) => a.email === 'priya@harbor.test')[0]!;
  assert.deepEqual(svc.resetStart('nobody@harbor.test'), { state: 'none' });
  // not approved yet: nothing worth protecting, so they can choose a new password straight away
  assert.deepEqual(svc.resetStart('Priya@Harbor.test'), { state: 'ready' });
  await refusedAsync(svc.resetFinish('priya@harbor.test', 'short'), /at least 10/);
  const again = await svc.resetFinish('priya@harbor.test', 'a brand new passphrase');
  assert.equal(svc.resolve(first.token), null, 'the old sessions are signed out');
  assert.ok(svc.resolve(again.token));
  await refusedAsync(svc.signIn('priya@harbor.test', PW), /sign_in_failed/);
  assert.ok(await svc.signIn('priya@harbor.test', 'a brand new passphrase'));
  // after approval the login holds pay stubs: the owner must allow a reset
  svc.submitRequest(account(), REQUEST);
  svc.approve(company.id, account().id, { roleKey: 'server', rateCents: 1500 });
  assert.deepEqual(svc.resetStart('priya@harbor.test'), { state: 'waiting' });
  await refusedAsync(svc.resetFinish('priya@harbor.test', 'yet another passphrase'), /reset_not_allowed/);
  const asked = svc.requests(company.id).resets;
  assert.deepEqual(asked.map((r) => [r.name, r.email]), [['Priya Raman', 'priya@harbor.test']]);
  assert.equal(svc.access(company.id).resets, 1);
  refused(() => svc.allowReset('cmp_other', account().id), /not found|Login/i);
  svc.allowReset(company.id, account().id);
  assert.equal(svc.requests(company.id).resets.length, 0, 'once allowed it is no longer waiting on the owner');
  assert.deepEqual(svc.resetStart('priya@harbor.test'), { state: 'ready' });
  const done = await svc.resetFinish('priya@harbor.test', 'yet another passphrase');
  assert.equal(svc.resolve(done.token)!.employee!.firstName, 'Priya');
  assert.deepEqual(svc.resetStart('priya@harbor.test'), { state: 'waiting' }, 'the permission was used up');
  // an allowance lapses after a day, and the owner can say no
  svc.allowReset(company.id, account().id);
  advance(25 * 3_600_000);
  await refusedAsync(svc.resetFinish('priya@harbor.test', 'one more passphrase!'), /reset_not_allowed/);
  svc.dismissReset(company.id, account().id);
  assert.equal(svc.requests(company.id).resets.length, 0);
});
