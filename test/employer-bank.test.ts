import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { Store } from '../src/store/store.ts';
import { BankService } from '../src/banking/accounts.ts';
import { AchService, reconcile } from '../src/money/ach.ts';
import { SandboxBank } from '../src/ach/sandbox.ts';
import { SftpDelivery, validateFileName, validateSftp, validateTemplate, type Runner } from '../src/ach/sftp.ts';
import { parseAchFile } from '../src/ach/nacha.ts';
import { approvePayRun, draftPayRun, voidPayRun } from '../src/payroll/payRuns.ts';
import { paymentSetupView, setPaymentSetup } from '../src/domain/payment.ts';
import { companyView } from '../src/domain/companies.ts';
import { decryptField } from '../src/lib/crypto.ts';
import { ledgerBalances } from '../src/money/ledger.ts';
import { FakeStripe } from './fake-stripe.ts';
import { day, hire, newCompany, ready, ROUTING, shiftsFor } from './helpers.ts';

const RUN = { periodStart: day(0), periodEnd: day(6), checkDate: day(11) };
const KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\n-----END OPENSSH PRIVATE KEY-----\n';
const KNOWN = 'sftp.mainstreetbank.test ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJ0hQvT1x9mXx1Z9mQJ7bq6k3fT0m1b8w3a9sD0nExample';
const BANK = { odfiRoutingNumber: ROUTING, odfiName: 'Main Street Bank', immediateOrigin: '123456789', companyId: '1123456789' };

interface Call { cmd: string; args: string[]; input: string; keyMode?: number; keyExistedDuring?: boolean; hostsText?: string; fileText?: string }

function fakeRunner(result: { code: number; stderr?: string } = { code: 0 }) {
  const calls: Call[] = [];
  const state = { result };
  const runner: Runner = async (cmd, args, opts) => {
    const keyPath = args[args.indexOf('-i') + 1];
    const hostsOpt = args.find((a) => a.startsWith('UserKnownHostsFile='))!.split('=')[1];
    const putLine = opts.input.split('\n').find((l) => l.startsWith('put '))!.split(' ');
    calls.push({ cmd, args, input: opts.input, keyMode: statSync(keyPath).mode & 0o777, keyExistedDuring: existsSync(keyPath), hostsText: readFileSync(hostsOpt, 'utf8'), fileText: readFileSync(putLine[1], 'utf8') });
    return { code: state.result.code, stdout: '', stderr: state.result.stderr ?? '' };
  };
  return { runner, calls, state };
}

async function setup(opts: { sftp?: boolean; start?: string; template?: string; runner?: ReturnType<typeof fakeRunner> } = {}) {
  const clock = { now: new Date(`${opts.start ?? '2026-06-08'}T15:00:00Z`) };
  const store = new Store();
  const banks = new BankService(store, new FakeStripe(), { now: () => clock.now });
  const bank = new SandboxBank();
  const r = opts.runner ?? fakeRunner();
  const ach = new AchService(store, banks, bank, { originator: { odfiRoutingNumber: '', odfiName: '', immediateOrigin: '', companyName: '', companyId: '' }, holdBankingDays: 2, fundingLeadBankingDays: 1, creditLeadBankingDays: 1, trustSettlementDate: false }, { now: () => clock.now, sftp: new SftpDelivery({ runner: r.runner }) });
  const { company } = newCompany(store);
  setPaymentSetup(store, company.id, { mode: 'employer_bank', employerBank: { ...BANK, ...(opts.template ? { fileNameTemplate: opts.template } : {}), ...(opts.sftp ? { sftp: { host: 'sftp.mainstreetbank.test', username: 'corner-table', remoteDir: '/inbound/ach', knownHostsLine: KNOWN, privateKey: KEY } } : {}) } }, 'company');
  const a = hire(store, company.id, { firstName: 'Ana', lastName: 'Ruiz', payType: { kind: 'hourly', rateCents: 1500 }, roleKey: 'line_cook', tipCreditNoticeDate: undefined });
  const b = hire(store, company.id, { firstName: 'Ben', lastName: 'Okafor', payType: { kind: 'hourly', rateCents: 1800 }, roleKey: 'line_cook', tipCreditNoticeDate: undefined });
  for (const [i, e] of [a, b].entries()) {
    ready(store, e.id, `00011122${i}33`);
    shiftsFor(store, company.id, e.id, [0, 1, 2, 3, 4], { minutes: 480 });
  }
  const run = approvePayRun(store, company.id, draftPayRun(store, company.id, RUN).id, { acknowledgeReviewIssues: true });
  const setDay = (iso: string) => (clock.now = new Date(`${iso}T15:00:00Z`));
  const advanceMinutes = (m: number) => (clock.now = new Date(clock.now.getTime() + m * 60_000));
  return { store, banks, bank, ach, company, run, a, b, r, setDay, advanceMinutes, clock };
}
const legs = (s: Awaited<ReturnType<typeof setup>>) => s.store.legs.where((l) => l.runId === s.run.id);

// ---------------------------------------------------------------- setup

test('setup: the employer\'s bank details are validated, the key is encrypted and never shown', async () => {
  const s = await setup({ sftp: true });
  const c = s.store.companies.get(s.company.id)!;
  assert.equal(c.payment.mode, 'employer_bank');
  assert.equal(c.payment.employerBank!.odfiRoutingNumber, ROUTING);
  assert.ok(!JSON.stringify(s.store.companies.all()).includes('PRIVATE KEY'), 'the key is not stored in the clear');
  assert.equal(decryptField(c.payment.employerBank!.sftp!.privateKeyEncrypted), KEY.trim());
  const view = JSON.stringify(paymentSetupView(c));
  assert.ok(!view.includes('PRIVATE KEY') && !view.includes('privateKeyEncrypted'));
  assert.equal(paymentSetupView(c).employerBank!.sftp!.hasPrivateKey, true);
  assert.ok(!JSON.stringify(companyView(c)).includes('privateKeyEncrypted'), 'nor in the company view');

  const bad = (over: Record<string, unknown>, sftp?: Record<string, unknown>) => () => setPaymentSetup(s.store, s.company.id, { mode: 'employer_bank', employerBank: { ...BANK, ...over, ...(sftp ? { sftp: { host: 'sftp.x.test', username: 'u', knownHostsLine: KNOWN, privateKey: KEY, ...sftp } } : {}) } }, 'company');
  assert.throws(bad({ odfiRoutingNumber: '110000001' }), /check digit/);
  assert.throws(bad({ companyId: '123456789012' }), /at most 10/);
  assert.throws(bad({ immediateOrigin: 'has space!' }), /immediateOrigin/);
  assert.throws(bad({ fileNameTemplate: 'X_{nope}.ach' }), /unknown token/);
  assert.throws(bad({ fileNameTemplate: '../{date}.ach' }), /not a safe file name/);
  assert.throws(bad({}, { host: 'bad host;rm -rf' }), /hostname/);
  assert.throws(bad({}, { remoteDir: '../../etc' }), /remoteDir/);
  assert.throws(bad({}, { knownHostsLine: 'not a host key' }), /known_hosts/);
  assert.throws(bad({}, { privateKey: 'password123' }), /private key/);
  assert.throws(bad({}, { username: '-oProxyCommand=evil' }), /username/);
});

test('setup: an existing SFTP key is kept when settings are updated without sending it again', async () => {
  const s = await setup({ sftp: true });
  setPaymentSetup(s.store, s.company.id, { mode: 'employer_bank', employerBank: { ...BANK, sftp: { host: 'sftp.mainstreetbank.test', username: 'corner-table', remoteDir: '/inbound/ach', knownHostsLine: KNOWN } } }, 'company');
  assert.equal(decryptField(s.store.companies.get(s.company.id)!.payment.employerBank!.sftp!.privateKeyEncrypted), KEY.trim());
  const fresh = new Store();
  const { company } = newCompany(fresh);
  assert.throws(() => setPaymentSetup(fresh, company.id, { mode: 'employer_bank', employerBank: { ...BANK, sftp: { host: 'sftp.x.test', username: 'u', knownHostsLine: KNOWN } } }, 'company'), /privateKey is required/);
});

test('setup: only Totali staff can switch a company to Totali-sent payments, and not while a run is in motion', async () => {
  const s = await setup();
  assert.throws(() => setPaymentSetup(s.store, s.company.id, { mode: 'totali_ach' }, 'company'), (e: any) => e.status === 403);
  assert.equal(setPaymentSetup(s.store, s.company.id, { mode: 'totali_ach' }, 'admin').payment.mode, 'totali_ach');
  setPaymentSetup(s.store, s.company.id, { mode: 'employer_bank', employerBank: BANK }, 'admin');
  await s.ach.preparePayment(s.company.id, s.run.id);
  assert.throws(() => setPaymentSetup(s.store, s.company.id, { mode: 'totali_ach' }, 'admin'), /in motion/);
});

test('template and name validation: only safe file names ever reach the bank or the command line', () => {
  validateTemplate('BANK_{routing}_{companyId}_{date}{time}_{seq}.ach');
  for (const bad of ['../x.ach', 'a b.ach', 'a;b.ach', '-rf', '', 'x'.repeat(101)]) assert.throws(() => validateFileName(bad), /safe file name/, bad);
  assert.throws(() => validateSftp({ host: 'a.test', port: 70000, username: 'u', remoteDir: '', knownHostsLine: KNOWN }), /port/);
});

// ---------------------------------------------------------------- the file

test('prepare: a credit-only file in the employer\'s own bank\'s header, no debit, no money held, nothing in the ledger', async () => {
  const s = await setup({ template: 'BANK_{routing}_{companyId}_{date}_{seq}.ach' });
  const out = await s.ach.preparePayment(s.company.id, s.run.id);
  assert.equal(out.status, 'disbursing');
  assert.equal(out.paying.length, 2);
  assert.equal(out.effectiveDate, '2026-06-12');
  assert.equal(out.late, false);
  assert.equal(out.file!.status, 'created', 'not sent anywhere: the employer releases it at their bank');
  assert.equal(out.file!.rail, 'employer');
  assert.equal(out.file!.delivery!.channel, 'download');
  assert.match(out.file!.fileName, /^BANK_110000000_1123456789_20260608_00001\.ach$/);

  const f = parseAchFile(s.ach.fileContent(s.company.id, out.file!.id).content);
  assert.deepEqual(f.errors, []);
  assert.equal(f.immediateDestination, ROUTING, "the file is addressed to the employer's bank");
  assert.equal(f.immediateOrigin, '123456789');
  assert.equal(f.batches.length, 1);
  assert.equal(f.batches[0].serviceClass, '220');
  assert.equal(f.batches[0].standardEntryClass, 'PPD');
  assert.equal(f.batches[0].companyId, '1123456789');
  assert.equal(f.batches[0].companyName, 'CORNER TABLE LLC');
  assert.ok(f.batches[0].entries.every((e) => e.transactionCode === '22'), 'credits only');
  assert.equal(f.control.debitCents, 0);
  assert.equal(f.control.creditCents, s.run.totals.payableCents);

  assert.equal(out.needsInYourAccountCents, s.run.totals.payableCents);
  assert.equal(out.youPayYourselfCents.employeeTaxesWithheld, s.run.totals.employeeTaxCents);
  assert.equal(legs(s).filter((l) => l.kind === 'funding').length, 0, 'there is no debit leg');
  assert.ok(legs(s).every((l) => l.rail === 'employer'));
  assert.equal(s.store.ledger.all().length, 0, 'Totali holds none of this money, so there is nothing to book');
  assert.deepEqual(ledgerBalances(s.store, s.company.id), { bank_cash: 0, employee_net_pay: 0, tax_withheld: 0, tax_employer: 0, deductions_held: 0 });
});

test('prepare: the same run does not produce a second file for people already covered', async () => {
  const s = await setup();
  await s.ach.preparePayment(s.company.id, s.run.id);
  const again = await s.ach.preparePayment(s.company.id, s.run.id);
  assert.equal(again.file, null);
  assert.equal(again.paying.length, 0);
  assert.equal(s.store.achFiles.all().length, 1);
});

test('prepare: effective dates must be banking days, not in the past; a date the schedule cannot meet needs acceptLate', async () => {
  const s = await setup();
  await assert.rejects(s.ach.preparePayment(s.company.id, s.run.id, { effectiveDate: '2026-06-13' }), /banking day/);
  await assert.rejects(s.ach.preparePayment(s.company.id, s.run.id, { effectiveDate: '2026-06-05' }), /cannot be earlier than 2026-06-09/);
  await assert.rejects(s.ach.preparePayment(s.company.id, s.run.id, { effectiveDate: '2026-06-08' }), /cannot be earlier than/, 'the same day as the file is created is not allowed by default (Chase rejects it)');
  assert.equal((await s.ach.preparePayment(s.company.id, s.run.id, { effectiveDate: '2026-06-10' })).effectiveDate, '2026-06-10');

  const late = await setup({ start: '2026-06-12' });
  await assert.rejects(late.ach.preparePayment(late.company.id, late.run.id), (e: any) => e.code === 'check_date_unreachable');
  const ok = await late.ach.preparePayment(late.company.id, late.run.id, { acceptLate: true });
  assert.equal(ok.effectiveDate, '2026-06-15');
  assert.equal(ok.late, true);
  assert.ok(late.store.payRuns.get(late.run.id)!.alerts!.some((a) => a.code === 'paid_late'));
});

test('prepare: the employer-mode timeline has no debit and no hold', async () => {
  const s = await setup();
  const t = s.ach.timeline(s.company.id, s.run.id) as any;
  assert.equal(t.mode, 'employer_bank');
  assert.equal(t.earliestCreditEffectiveDate, '2026-06-09');
  assert.equal(t.targetCreditDate, '2026-06-12');
  assert.equal(t.onTime, true);
  assert.equal(t.debitEffectiveDate, undefined);
});

test('a company in one mode cannot use the other mode\'s calls', async () => {
  const s = await setup();
  await assert.rejects(s.ach.fundPayRun(s.company.id, s.run.id), (e: any) => e.code === 'wrong_payment_mode');
  await assert.rejects(s.ach.disbursePayRun(s.company.id, s.run.id), (e: any) => e.code === 'wrong_payment_mode');
  setPaymentSetup(s.store, s.company.id, { mode: 'totali_ach' }, 'admin');
  await assert.rejects(s.ach.preparePayment(s.company.id, s.run.id), (e: any) => e.code === 'wrong_payment_mode');
});

test('preparing needs the employer\'s bank to be set up first', async () => {
  const store = new Store();
  const ach = new AchService(store, new BankService(store, new FakeStripe()), new SandboxBank(), { originator: { odfiRoutingNumber: '', odfiName: '', immediateOrigin: '', companyName: '', companyId: '' }, holdBankingDays: 2, fundingLeadBankingDays: 1, creditLeadBankingDays: 1, trustSettlementDate: false });
  const { company } = newCompany(store);
  const e = hire(store, company.id, { roleKey: 'line_cook', payType: { kind: 'hourly', rateCents: 1500 }, tipCreditNoticeDate: undefined });
  ready(store, e.id);
  shiftsFor(store, company.id, e.id, [0]);
  const run = approvePayRun(store, company.id, draftPayRun(store, company.id, RUN).id, { acknowledgeReviewIssues: true });
  await assert.rejects(ach.preparePayment(company.id, run.id), (x: any) => x.code === 'payment_setup_incomplete');
});

// ---------------------------------------------------------------- release, cancel, settle

test('release: the employer says they approved it at their bank; payments take effect on the file\'s date and the run completes', async () => {
  const s = await setup();
  const out = await s.ach.preparePayment(s.company.id, s.run.id);
  const fid = out.file!.id;
  assert.throws(() => s.ach.markReleased(s.company.id, fid, ' '), /releasedBy/);
  assert.throws(() => s.ach.markReleased('co_someone_else', fid, 'Owner'), /own payment files/);
  assert.ok(legs(s).every((l) => l.status === 'queued'));
  const rel = s.ach.markReleased(s.company.id, fid, 'Owner Person');
  assert.equal(rel.status, 'accepted');
  assert.equal(rel.releasedBy, 'Owner Person');
  assert.ok(rel.releasedAt);
  assert.ok(legs(s).every((l) => l.status === 'submitted'));
  assert.equal(s.ach.markReleased(s.company.id, fid, 'Owner Person').status, 'accepted', 'idempotent');

  s.setDay('2026-06-11');
  s.ach.advance();
  assert.equal(s.store.payRuns.get(s.run.id)!.status, 'disbursing', 'not before the effective date');
  s.setDay('2026-06-12');
  s.ach.advance();
  assert.ok(legs(s).every((l) => l.status === 'settled'));
  assert.equal(s.store.payRuns.get(s.run.id)!.status, 'completed');
  assert.equal(s.store.ledger.all().length, 0, 'still nothing in Totali\'s ledger');
});

test('cancel: before release the file is withdrawn, the run goes back to approved, and a new file can be made', async () => {
  const s = await setup();
  const first = await s.ach.preparePayment(s.company.id, s.run.id);
  assert.throws(() => voidPayRun(s.store, s.company.id, s.run.id), (e: any) => e.code === 'money_in_motion');
  const c = s.ach.cancelFile(s.company.id, first.file!.id);
  assert.equal(c.status, 'rejected');
  assert.ok(legs(s).every((l) => l.status === 'failed'));
  assert.equal(s.store.payRuns.get(s.run.id)!.status, 'approved');

  const second = await s.ach.preparePayment(s.company.id, s.run.id);
  assert.notEqual(second.file!.id, first.file!.id);
  assert.notEqual(second.file!.entries[0].traceNumber, first.file!.entries[0].traceNumber);
  assert.equal(second.paying.length, 2);
  assert.throws(() => s.ach.markReleased(s.company.id, first.file!.id, 'Owner'), (e: any) => e.code === 'file_cancelled');

  s.ach.markReleased(s.company.id, second.file!.id, 'Owner');
  assert.throws(() => s.ach.cancelFile(s.company.id, second.file!.id), (e: any) => e.code === 'already_released');
});

test('cancel: after the only file is cancelled the run can be voided, and shifts unlock', async () => {
  const s = await setup();
  const out = await s.ach.preparePayment(s.company.id, s.run.id);
  s.ach.cancelFile(s.company.id, out.file!.id);
  assert.equal(voidPayRun(s.store, s.company.id, s.run.id).status, 'voided');
  assert.ok(s.store.shifts.all().every((x) => !x.lockedByRunId));
});

// ---------------------------------------------------------------- returns

test('returns: the employer uploads the bank\'s return file; it can only touch that company\'s own payments', async () => {
  const s = await setup();
  const out = await s.ach.preparePayment(s.company.id, s.run.id);
  s.ach.markReleased(s.company.id, out.file!.id, 'Owner');
  s.setDay('2026-06-12');
  s.ach.advance();
  const entry = out.file!.entries.find((e) => legs(s).find((l) => l.id === e.legId)!.employeeId === s.a.id)!;
  const ret = SandboxBank.returnFile([{ trace: entry.traceNumber, code: 'R03', amountCents: entry.amountCents }]);

  // another company's upload cannot reach these payments
  const stranger = s.ach.ingestReturnFile(ret, { companyId: 'co_not_this_one' });
  assert.deepEqual(stranger.unmatched, [entry.traceNumber]);
  assert.equal(stranger.applied.length, 0);
  assert.ok(legs(s).every((l) => l.status === 'settled'));

  const mine = s.ach.ingestReturnFile(ret, { companyId: s.company.id });
  assert.equal(mine.applied.length, 1);
  const leg = legs(s).find((l) => l.id === entry.legId)!;
  assert.equal(leg.status, 'returned');
  assert.equal(s.store.bankAccounts.get(leg.bankAccountId)!.status, 'disabled');
  assert.equal(s.store.payRuns.get(s.run.id)!.status, 'disbursing');
  assert.equal(s.store.ledger.all().length, 0, 'a return in employer-bank mode moves nothing in Totali\'s ledger either');
  assert.ok(s.store.payRuns.get(s.run.id)!.alerts!.some((a) => a.code === 'payout_returned'));

  // the employee fixes their account; only they are re-sent
  const again = ready(s.store, s.a.id, '000777888999');
  const re = await s.ach.preparePayment(s.company.id, s.run.id, { acceptLate: true });
  assert.deepEqual(re.paying.map((p) => [p.employeeId, p.bankAccountId]), [[s.a.id, again.id]]);
});

test('an employee who is not set up waits; once they are, only their pay goes in a new file', async () => {
  const s = await setup();
  s.store.tx(() => s.store.employees.put({ ...s.store.employees.get(s.a.id)!, payoutAccounts: [] }));
  const first = await s.ach.preparePayment(s.company.id, s.run.id);
  assert.equal(first.paying.length, 1);
  assert.equal(first.waitingForBankAccount[0].employeeId, s.a.id);
  ready(s.store, s.a.id, '000999111222');
  const second = await s.ach.preparePayment(s.company.id, s.run.id);
  assert.deepEqual(second.paying.map((p) => p.employeeId), [s.a.id]);
  assert.equal(s.store.achFiles.all().length, 2);
});

// ---------------------------------------------------------------- prenotes

test('prenotes go in the employer\'s bank\'s file, and verify the account after the NACHA waiting period', async () => {
  const s = await setup();
  const acct = s.banks.addManualAccount(s.company.id, { employeeId: s.a.id, routingNumber: ROUTING, accountNumber: '000246813579', accountType: 'checking' });
  const sent = await s.ach.submitPrenotes(s.company.id);
  assert.equal(sent.file!.rail, 'employer');
  const f = parseAchFile(s.ach.fileContent(s.company.id, sent.file!.id).content);
  assert.equal(f.immediateDestination, ROUTING);
  assert.equal(f.batches[0].entries[0].transactionCode, '23');
  assert.equal(f.batches[0].entries[0].amountCents, 0);
  assert.equal(s.store.bankAccounts.get(acct.id)!.verification.prenoteSettlementDate, undefined, 'not until released');
  s.ach.markReleased(s.company.id, sent.file!.id, 'Owner');
  assert.equal(s.store.bankAccounts.get(acct.id)!.verification.prenoteSettlementDate, sent.file!.effectiveDate);
  s.setDay('2026-06-12');
  s.ach.advance();
  assert.equal(s.store.bankAccounts.get(acct.id)!.status, 'active');
});

// ---------------------------------------------------------------- SFTP

test('sftp: the file is delivered with strict host-key checking and key-only login; the key exists only while the transfer runs', async () => {
  const r = fakeRunner();
  const s = await setup({ sftp: true, runner: r });
  const out = await s.ach.preparePayment(s.company.id, s.run.id);
  assert.equal(r.calls.length, 1);
  const c = r.calls[0];
  assert.equal(c.cmd, 'sftp');
  for (const opt of ['BatchMode=yes', 'IdentitiesOnly=yes', 'PasswordAuthentication=no', 'KbdInteractiveAuthentication=no', 'StrictHostKeyChecking=yes', 'GlobalKnownHostsFile=/dev/null']) assert.ok(c.args.includes(opt), opt);
  assert.ok(c.args.includes('corner-table@sftp.mainstreetbank.test'));
  assert.equal(c.args[c.args.indexOf('-P') + 1], '22');
  assert.equal(c.hostsText, `${KNOWN}\n`, 'the bank\'s pinned host key is the only one trusted');
  assert.equal(c.keyMode, 0o600);
  assert.ok(c.keyExistedDuring);
  assert.ok(!c.args.join(' ').includes('PRIVATE KEY') && !c.input.includes('PRIVATE KEY'), 'the key never appears on the command line or in the script');
  const keyPath = c.args[c.args.indexOf('-i') + 1];
  assert.equal(existsSync(keyPath), false, 'the key file is gone afterwards');
  assert.match(c.input, /^cd \/inbound\/ach\nput \S+ TOTALI_20260608_00001\.ach\nbye\n$/);
  assert.equal(c.fileText, s.ach.fileContent(s.company.id, out.file!.id).content, 'exactly the stored file is what was sent');

  const file = s.store.achFiles.get(out.file!.id)!;
  assert.equal(file.status, 'queued', 'delivered, but NOT accepted: the employer still has to release it');
  assert.equal(file.delivery!.status, 'sent');
  assert.equal(file.delivery!.remotePath, '/inbound/ach/TOTALI_20260608_00001.ach');
  assert.equal(file.submitter, 'sftp');
  assert.ok(legs(s).every((l) => l.status === 'queued'));
  s.ach.markReleased(s.company.id, file.id, 'Owner');
  assert.ok(legs(s).every((l) => l.status === 'submitted'));
});

test('sftp: a failed delivery leaves the file ready to download, and retries wait 15 minutes', async () => {
  const r = fakeRunner({ code: 255, stderr: 'Host key verification failed.' });
  const s = await setup({ sftp: true, runner: r });
  const out = await s.ach.preparePayment(s.company.id, s.run.id);
  const f1 = s.store.achFiles.get(out.file!.id)!;
  assert.equal(f1.status, 'created');
  assert.equal(f1.delivery!.status, 'failed');
  assert.match(f1.delivery!.message!, /Host key verification failed/);
  assert.ok(f1.message!.includes('can be downloaded instead'));
  assert.equal(r.calls.length, 1);

  await reconcile(s.ach, s.store, { autoDisburse: false });
  assert.equal(r.calls.length, 1, 'no retry inside 15 minutes');
  s.advanceMinutes(16);
  r.state.result = { code: 0 };
  await reconcile(s.ach, s.store, { autoDisburse: false });
  assert.equal(r.calls.length, 2);
  assert.equal(s.store.achFiles.get(out.file!.id)!.status, 'queued');
  await reconcile(s.ach, s.store, { autoDisburse: false });
  assert.equal(r.calls.length, 2, 'delivered once, never again');
});

test('sftp: a person can retry delivery at once; and without sftp the file simply stays ready to download', async () => {
  const r = fakeRunner({ code: 255 });
  const s = await setup({ sftp: true, runner: r });
  const out = await s.ach.preparePayment(s.company.id, s.run.id);
  r.state.result = { code: 0 };
  assert.equal((await s.ach.deliverFile(out.file!.id)).delivery!.status, 'failed', 'backoff applies to automatic retries');
  assert.equal((await s.ach.deliverFile(out.file!.id, { force: true })).delivery!.status, 'sent');

  const plain = await setup();
  const p = await plain.ach.preparePayment(plain.company.id, plain.run.id);
  const before = plain.store.achFiles.get(p.file!.id)!.updatedAt;
  plain.advanceMinutes(5);
  await reconcile(plain.ach, plain.store, { autoDisburse: false });
  assert.equal(plain.store.achFiles.get(p.file!.id)!.updatedAt, before, 'the reconcile loop does not keep rewriting a file that is just waiting for download');
});

test('sftp: nothing unsafe reaches the command line or the script', async () => {
  const r = fakeRunner();
  const d = new SftpDelivery({ runner: r.runner });
  const target = { host: 'sftp.x.test', port: 22, username: 'u', remoteDir: '/in', knownHostsLine: KNOWN, privateKey: KEY };
  await assert.rejects(d.deliver(target, '../escape.ach', 'x'), /safe file name/);
  await assert.rejects(d.deliver(target, 'a b.ach', 'x'), /safe file name/);
  await assert.rejects(d.deliver({ ...target, host: '-oProxyCommand=evil' }, 'a.ach', 'x'), /hostname/);
  await assert.rejects(d.deliver({ ...target, remoteDir: '/in;rm' }, 'a.ach', 'x'), /remoteDir/);
  assert.equal(r.calls.length, 0);
});

test('sftp: a missing sftp client is reported plainly, never as a silent success', async () => {
  const d = new SftpDelivery({ binary: '/nonexistent/sftp-binary', timeoutMs: 2_000 });
  await assert.rejects(d.deliver({ host: 'sftp.x.test', port: 22, username: 'u', remoteDir: '', knownHostsLine: KNOWN, privateKey: KEY }, 'a.ach', 'x'), /must be installed|exited 127/);
});

test('a bank with a longer lead time (Chase for Business wants payroll created at least two business days before it debits) moves the earliest date', async () => {
  const s = await setup();
  setPaymentSetup(s.store, s.company.id, { mode: 'employer_bank', employerBank: { ...BANK, leadBankingDays: 3 } }, 'company');
  const t = s.ach.timeline(s.company.id, s.run.id) as any;
  assert.equal(t.earliestCreditEffectiveDate, '2026-06-11', 'Monday plus three banking days');
  assert.equal(t.onTime, true);
  await assert.rejects(s.ach.preparePayment(s.company.id, s.run.id, { effectiveDate: '2026-06-10' }), /needs 3 banking day/);
  assert.equal((await s.ach.preparePayment(s.company.id, s.run.id)).effectiveDate, '2026-06-12');

  const late = await setup({ start: '2026-06-10' });
  setPaymentSetup(late.store, late.company.id, { mode: 'employer_bank', employerBank: { ...BANK, leadBankingDays: 3 } }, 'company');
  await assert.rejects(late.ach.preparePayment(late.company.id, late.run.id), (e: any) => e.code === 'check_date_unreachable' && e.details.earliest === '2026-06-15');
  assert.throws(() => setPaymentSetup(late.store, late.company.id, { mode: 'employer_bank', employerBank: { ...BANK, leadBankingDays: 11 } }, 'company'), /0 to 10/);
});

test('a bank that takes same-day files can be set to a lead of zero', async () => {
  const s = await setup();
  setPaymentSetup(s.store, s.company.id, { mode: 'employer_bank', employerBank: { ...BANK, leadBankingDays: 0 } }, 'company');
  assert.equal((await s.ach.preparePayment(s.company.id, s.run.id, { effectiveDate: '2026-06-08' })).effectiveDate, '2026-06-08');
});

test('the prepared file shows its control totals, which some banks make the employer type in before they release it', async () => {
  const s = await setup();
  const out = await s.ach.preparePayment(s.company.id, s.run.id);
  assert.equal(out.controlTotals!.creditsCents, s.run.totals.payableCents);
  assert.equal(out.controlTotals!.debitsCents, 0);
  assert.equal(out.controlTotals!.entryCount, 2);
  assert.match(out.controlTotals!.note, /Truist/);
});
