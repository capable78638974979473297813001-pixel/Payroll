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
const codeIn = (m: OutboxMailer) => /\b(\d{6})\b/.exec(m.messages.at(-1)!.text)![1]!;
const refused = (fn: () => unknown, re: RegExp) => assert.throws(fn, (e: unknown) => e instanceof ApiError && re.test(`${e.code} ${e.message}`), String(re));

test('the owner gets a code that is easy to read aloud; it is stable until rotated, and rotating signs everyone out', async () => {
  const { svc, company, mk, mailer } = make();
  const a = svc.access(company.id);
  assert.match(a.code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  assert.equal(svc.access(company.id).code, a.code);
  const e = mk('Elena', 'Ruiz', 'elena@harbor.test'); mk('Tom', 'Whitaker');
  assert.deepEqual([svc.access(company.id).withEmail, svc.access(company.id).withoutEmail], [1, 1]);
  await svc.start(a.code, 'elena@harbor.test');
  const { token } = svc.verify(a.code, 'elena@harbor.test', codeIn(mailer));
  assert.equal(svc.resolve(token)!.id, e.id);
  const b = svc.rotate(company.id);
  assert.notEqual(b.code, a.code);
  assert.equal(svc.resolve(token), null, 'the old session is gone');
  const before = mailer.messages.length;
  await svc.start(a.code, 'elena@harbor.test');
  assert.equal(mailer.messages.length, before, 'the old code finds nothing');
  svc.setEnabled(company.id, false);
  await svc.start(b.code, 'elena@harbor.test');
  assert.equal(mailer.messages.length, before, 'switched off, nothing is sent');
});

test('signing in needs the company code, the email on file and the emailed code, and says nothing about which was wrong', async () => {
  const { svc, company, mk, mailer, store, advance } = make();
  const { code } = svc.access(company.id);
  const e = mk('Elena', 'Ruiz', 'Elena@Harbor.test');
  for (const [c, em] of [['ZZZZ-ZZZZ', 'elena@harbor.test'], [code, 'nobody@harbor.test'], [code, 'not an email'], ['', '']] as const) { await svc.start(c, em); }
  assert.equal(mailer.messages.length, 0);
  await svc.start(code.toLowerCase().replace('-', ' '), ' elena@harbor.test ');
  assert.equal(mailer.messages.length, 1);
  assert.equal(mailer.messages[0]!.to, 'elena@harbor.test');
  const otp = codeIn(mailer);
  refused(() => svc.verify(code, 'elena@harbor.test', otp === '000000' ? '111111' : '000000'), /code_wrong/);
  await svc.start(code, 'elena@harbor.test');
  assert.equal(mailer.messages.length, 1, 'a second request inside a minute sends nothing');
  advance(61_000);
  await svc.start(code, 'elena@harbor.test');
  assert.equal(mailer.messages.length, 2);
  refused(() => svc.verify(code, 'elena@harbor.test', otp), /code_wrong|code_invalid/);
  const real = codeIn(mailer);
  refused(() => svc.verify(code, 'someone-else@harbor.test', real), /code_invalid/);
  advance(16 * 60_000);
  refused(() => svc.verify(code, 'elena@harbor.test', real), /code_expired/);
  advance(61_000);
  await svc.start(code, 'elena@harbor.test');
  const { token } = svc.verify(code, 'elena@harbor.test', codeIn(mailer));
  assert.ok(svc.resolve(token));
  assert.equal(JSON.stringify(store.portalSessions.all()).includes(token), false, 'only the hash is stored');
  store.tx(() => store.employees.put({ ...store.employees.get(e.id)!, terminationDate: '2026-10-29' }));
  assert.equal(svc.resolve(token), null, 'someone who has left is signed out');
  svc.logout(token);
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
