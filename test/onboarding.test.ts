import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/store.ts';
import { OnboardingService } from '../src/onboarding/service.ts';
import { OutboxMailer } from '../src/mail/mailer.ts';
import { BankService } from '../src/banking/accounts.ts';
import { draftPayRun, recalculatePayRun } from '../src/payroll/payRuns.ts';
import { saveWeek } from '../src/domain/weekEntry.ts';
import { ApiError } from '../src/lib/errors.ts';
import { createCompanyFromSetup } from '../src/builder/finish.ts';
import type { User } from '../src/accounts/types.ts';
import { ROUTING } from './helpers.ts';

const D = '2026-10-30';
const NOW = new Date(`${D}T15:00:00Z`);
function setup() {
  const store = new Store();
  const mailer = new OutboxMailer();
  const company = createCompanyFromSetup(store, { id: 'usr_1', businessName: 'Harbor Street Kitchen' } as User, 'restaurant', { state: 'MI', locations: [{ name: 'Detroit', city: 'Detroit', state: 'MI' }], team: '1-10', tips: { on: true, pool: 'hours' }, frequency: { value: 'weekly', weekday: 'friday' }, contractors: { on: false } }, D, NOW);
  const banks = new BankService(store, {} as never, { now: () => NOW });
  let t = NOW.getTime();
  const svc = new OnboardingService(store, mailer, banks, () => new Date(t));
  return { store, mailer, company, svc, advance: (ms: number) => { t += ms; } };
}
const hireBody = { firstName: 'Noor', lastName: 'Patel', email: 'Noor.P@example.com', roleKey: 'server', rateCents: 1550, location: 'Detroit', startDate: '2026-11-02' };
const tokenOf = (link: string) => link.split('/join/')[1]!;
const refused = async (p: unknown, code: string) => assert.rejects(Promise.resolve(p), (e: unknown) => e instanceof ApiError && e.code === code, code);
const refusedSync = (fn: () => unknown, re: RegExp) => assert.throws(fn, (e: unknown) => e instanceof ApiError && re.test(`${e.code} ${e.message}`), String(re));

test('an invite adds the person, emails a private link, and lists exactly the forms asked for', async () => {
  const { svc, mailer, company, store } = setup();
  const r = await svc.invite(company.id, 'https://app.example', hireBody);
  assert.equal(r.emailed, false, 'the outbox never really sends');
  const mail = mailer.messages.at(-1)!;
  assert.equal(mail.to, 'noor.p@example.com');
  assert.ok(mail.text.includes(r.link) && r.link.startsWith('https://app.example/join/'));
  assert.ok(/W-4/.test(mail.text) && /MI-W4/.test(mail.text) && /I-9/.test(mail.text));
  const status = svc.status(tokenOf(r.link));
  assert.deepEqual(status.steps.map((s) => s.id), ['w4', 'i9', 'deposit']);
  assert.equal(status.next, 'w4');
  assert.equal(JSON.stringify(store.employees.get(r.employee.id)).includes(tokenOf(r.link)), false, 'the secret is never stored, only its hash');
  await refused(svc.invite(company.id, 'x', hireBody), 'already_invited');
  const only = await svc.invite(company.id, 'x', { ...hireBody, email: 'b@example.com', forms: ['deposit'] });
  assert.deepEqual(svc.status(tokenOf(only.link)).steps.map((s) => s.id), ['deposit']);
});

test('the three forms fill in the employee, and the pay run leaves them out until the W-4 is in', async () => {
  const { svc, store, company } = setup();
  const r = await svc.invite(company.id, 'https://app.example', hireBody);
  const tok = tokenOf(r.link);
  saveWeek(store, company, { periodStart: '2026-11-02', periodEnd: '2026-11-08', entries: [{ employeeId: r.employee.id, regularMinutes: 1200 }] });
  let run = draftPayRun(store, company.id, { periodStart: '2026-11-02', periodEnd: '2026-11-08', checkDate: '2026-11-13' });
  assert.equal(run.paychecks.length, 0);
  assert.ok(run.issues.some((i) => i.code === 'w4_missing'));

  refusedSync(() => svc.submitW4(tok, { filingStatus: 'single', signature: 'Someone Else' }), /sign/i);
  svc.submitW4(tok, { filingStatus: 'married_joint', multipleJobs: false, children: 1, otherDependents: 2, exemptions: 3, signature: 'noor patel' });
  const e = store.employees.get(r.employee.id)!;
  assert.equal(e.federalW4.filingStatus, 'married_joint');
  assert.equal(e.federalW4.dependentCredit, 200_000 + 2 * 50_000);
  assert.equal((e.workState.certificate as { allowances?: number }).allowances, 3);
  assert.ok(e.onboarding!.w4 && e.onboarding!.stateForm?.id === 'MI-W4');
  run = recalculatePayRun(store, company.id, run.id);
  assert.equal(run.paychecks.length, 1, 'with a W-4 on file they are paid');

  assert.equal(svc.status(tok).next, 'i9');
  svc.submitI9(tok, { legalFirstName: 'Noor', legalLastName: 'Patel', dateOfBirth: '2001-03-14', ssn: '512-34-4410', status: 'citizen', signature: 'Noor Patel' });
  const afterI9 = store.employees.get(r.employee.id)!;
  assert.equal(afterI9.ssnLast4, '4410');
  assert.equal(JSON.stringify(afterI9).includes('512-34-4410'), false);
  assert.ok(!JSON.stringify(afterI9).includes('2001-03-14'), 'the date of birth is kept encrypted');

  const dep = svc.submitDeposit(tok, { bankName: 'Huron Valley CU', routingNumber: ROUTING, accountNumber: '000123454821', accountType: 'checking', confirm: true });
  assert.equal(dep.next, null);
  const done = store.employees.get(r.employee.id)!;
  assert.equal(done.payoutAccounts.length, 1);
  assert.equal(store.bankAccounts.get(done.payoutAccounts[0]!.bankAccountId)!.last4, '4821');
  assert.equal(svc.status(tok).complete, true);
  const ov = svc.overview(company.id);
  assert.equal(ov.people.find((p) => p.employeeId === r.employee.id)!.done, true);
  assert.equal(ov.remaining, 0);
});

test('an I-9 needs section 1 before the employer can do section 2, and the deposit needs a valid routing number', async () => {
  const { svc, company, store } = setup();
  const r = await svc.invite(company.id, 'https://app.example', hireBody);
  const tok = tokenOf(r.link);
  refusedSync(() => svc.i9Section2(company.id, r.employee.id, 'Scott', { documentTitle: 'Passport', issuingAuthority: 'US', documentNumber: '1', firstDayOfEmployment: '2026-11-02', attest: true }), /section1_first/);
  svc.submitI9(tok, { legalFirstName: 'Noor', legalLastName: 'Patel', dateOfBirth: '2001-03-14', ssn: '512-34-4410', status: 'citizen', signature: 'Noor Patel' });
  refusedSync(() => svc.i9Section2(company.id, r.employee.id, 'Scott', { documentTitle: 'Passport', issuingAuthority: 'US', documentNumber: '1', firstDayOfEmployment: '2026-11-02' }), /attest|examined/);
  svc.i9Section2(company.id, r.employee.id, 'Scott Holdan', { documentTitle: 'US Passport', issuingAuthority: 'US Dept of State', documentNumber: '123456789', firstDayOfEmployment: '2026-11-02', attest: true });
  assert.equal(store.employees.get(r.employee.id)!.onboarding!.i9!.section2By, 'Scott Holdan');
  refusedSync(() => svc.i9Section2(company.id, r.employee.id, 'Scott', { documentTitle: 'x', issuingAuthority: 'x', documentNumber: '1', firstDayOfEmployment: '2026-11-02', attest: true }), /already_done/);
  refusedSync(() => svc.submitDeposit(tok, { routingNumber: '123456789', accountNumber: '000123454821', accountType: 'checking', confirm: true }), /routing number/);
  refusedSync(() => svc.submitDeposit(tok, { routingNumber: ROUTING, accountNumber: '000123454821', accountType: 'checking' }), /Confirm/);
});

test('links expire, unknown links say so without detail, and a reminder gives a fresh link at most once an hour', async () => {
  const { svc, company, mailer, advance } = setup();
  const r = await svc.invite(company.id, 'https://app.example', hireBody);
  const tok = tokenOf(r.link);
  for (const bad of ['nope', 'x'.repeat(43), undefined]) refusedSync(() => svc.status(bad), /link_not_valid/);
  await refused(svc.remind(company.id, 'https://app.example', r.employee.id), 'remind_too_soon').catch(() => {});
  advance(2 * 3_600_000);
  const again = await svc.remind(company.id, 'https://app.example', r.employee.id);
  assert.notEqual(tokenOf(again.link), tok);
  refusedSync(() => svc.status(tok), /link_not_valid/);
  assert.ok(/still missing/i.test(mailer.messages.at(-1)!.subject));
  await refused(svc.remind(company.id, 'https://app.example', r.employee.id), 'remind_too_soon');
  advance(15 * 86_400_000);
  refusedSync(() => svc.status(tokenOf(again.link)), /link_not_valid/);
  assert.equal(svc.overview(company.id).people[0]!.linkExpired, true);
});
