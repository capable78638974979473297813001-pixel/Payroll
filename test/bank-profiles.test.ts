import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/store/store.ts';
import { BankService } from '../src/banking/accounts.ts';
import { AchService } from '../src/money/ach.ts';
import { SandboxBank } from '../src/ach/sandbox.ts';
import { SftpDelivery } from '../src/ach/sftp.ts';
import { createApp } from '../src/api/app.ts';
import type { Config } from '../src/config.ts';
import { approvePayRun, draftPayRun } from '../src/payroll/payRuns.ts';
import { paymentSetupView, setPaymentSetup } from '../src/domain/payment.ts';
import { PROFILE_IDS, profiles } from '../src/banks/index.ts';
import { checkFile, checkSetup, errorsOf } from '../src/banks/checks.ts';
import { ApiError } from '../src/lib/errors.ts';
import { FakeStripe } from './fake-stripe.ts';
import { day, hire, newCompany, ready, ROUTING, shiftsFor } from './helpers.ts';

const RUN = { periodStart: day(0), periodEnd: day(6), checkDate: day(11) };
const KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmU=\n-----END OPENSSH PRIVATE KEY-----\n';
const KNOWN = 'sftp.x.test ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJ0hQvT1x9mXx1Z9mQJ7bq6k3fT0m1b8w3a9sD0n';
const BANK = { odfiRoutingNumber: ROUTING, odfiName: 'Test Bank', immediateOrigin: '123456789', companyId: '1123456789' };
const SFTP = { host: 'sftp.x.test', username: 'u', knownHostsLine: KNOWN, privateKey: KEY };

async function setup(employerBank: Record<string, unknown>, opts: { rateCents?: number; staff?: number } = {}) {
  const clock = { now: new Date('2026-06-08T15:00:00Z') };
  const store = new Store();
  const banks = new BankService(store, new FakeStripe(), { now: () => clock.now });
  const sent: string[] = [];
  const ach = new AchService(store, banks, new SandboxBank(), { originator: { odfiRoutingNumber: '', odfiName: '', immediateOrigin: '', companyName: '', companyId: '' }, holdBankingDays: 2, fundingLeadBankingDays: 1, creditLeadBankingDays: 1, trustSettlementDate: false }, { now: () => clock.now, sftp: new SftpDelivery({ runner: async (_c, args) => (sent.push(args.join(' ')), { code: 0, stdout: '', stderr: '' }) }) });
  const { company } = newCompany(store);
  setPaymentSetup(store, company.id, { mode: 'employer_bank', employerBank: { ...BANK, ...employerBank } }, 'company');
  for (let i = 0; i < (opts.staff ?? 1); i++) {
    const e = hire(store, company.id, { firstName: `Ana${'abcdefgh'[i]}`, lastName: 'Ruiz', payType: { kind: 'hourly', rateCents: opts.rateCents ?? 1500 }, roleKey: 'line_cook', tipCreditNoticeDate: undefined });
    ready(store, e.id, `00011122${i}333`);
    shiftsFor(store, company.id, e.id, [0, 1, 2, 3, 4], { minutes: 480 });
  }
  const run = approvePayRun(store, company.id, draftPayRun(store, company.id, RUN).id, { acknowledgeReviewIssues: true });
  return { store, ach, company, run, sent, setDay: (iso: string) => (clock.now = new Date(`${iso}T15:00:00Z`)) };
}

const setupError = (store: Store, companyId: string, employerBank: Record<string, unknown>) => {
  try { setPaymentSetup(store, companyId, { mode: 'employer_bank', employerBank: { ...BANK, ...employerBank } }, 'company'); } catch (e) { return e as ApiError; }
  assert.fail('expected the setup to be refused');
};

// ---------------------------------------------------------------- the data

test('every profile says where it came from, when, and what to ask the bank', () => {
  assert.equal(PROFILE_IDS.length, 14);
  for (const id of PROFILE_IDS) {
    const p = profiles[id];
    assert.equal(p.id, id);
    assert.match(p.verifiedOn, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(p.askBank.length > 0, `${id} has questions for the bank`);
    if (id !== 'other') assert.ok(p.sources.length > 0, `${id} cites a source`);
    for (const s of p.sources) assert.match(s.url, /^https:\/\//);
    for (const r of p.knownRoutingNumbers) assert.match(r, /^\d{9}$/);
  }
});

test('Totali never claims SFTP works where the bank needs a password or the protocol was not confirmed', () => {
  assert.equal(profiles.truist.sftp.support, 'unsupported_auth');
  for (const id of ['jpmorgan_commercial', 'bank_of_america', 'fifth_third'] as const) assert.notEqual(profiles[id].sftp.support, 'supported', id);
  // Only a key login can be called supported-with-known-auth.
  for (const p of Object.values(profiles)) if (p.sftp.support === 'supported') assert.notEqual(p.sftp.auth, 'password', p.id);
});

test('banks known only from a search summary are marked as such', () => {
  for (const id of ['us_bank', 'fifth_third', 'keybank', 'banner_bank'] as const) {
    assert.ok(profiles[id].sources.some((s) => s.how === 'search_summary'), id);
  }
  assert.ok(profiles.chase_for_business.sources.every((s) => s.how === 'read'));
});

// ---------------------------------------------------------------- setup

test('choosing Chase applies its lead time; the employer can still ask for more', async () => {
  const s = await setup({ bankProfile: 'chase_for_business' });
  const view = paymentSetupView(s.store.companies.require(s.company.id, 'Company'));
  assert.equal(view.employerBank!.leadBankingDays, 3);
  assert.equal(view.bank!.name, 'Chase for Business');
  assert.ok(view.bank!.guidance.some((g) => g.includes('ACH file upload')));
  assert.ok(view.bank!.askYourBank.length > 0);

  setPaymentSetup(s.store, s.company.id, { mode: 'employer_bank', employerBank: { ...BANK, bankProfile: 'chase_for_business', leadBankingDays: 5 } }, 'company');
  assert.equal(s.store.companies.require(s.company.id, 'Company').payment.employerBank!.leadBankingDays, 5);
});

test('a lead time of zero is refused for a bank that needs the effective date after creation; a shorter one only warns when it is our reading', async () => {
  const s = await setup({});
  const err = setupError(s.store, s.company.id, { bankProfile: 'chase_for_business', leadBankingDays: 0 });
  assert.equal(err.code, 'invalid_request');
  assert.match(err.message, /cannot be 0/);
  // 2 is under our reading of Chase's guide (3): allowed, but the view says so.
  setPaymentSetup(s.store, s.company.id, { mode: 'employer_bank', employerBank: { ...BANK, bankProfile: 'chase_for_business', leadBankingDays: 2 } }, 'company');
  const view = paymentSetupView(s.store.companies.require(s.company.id, 'Company'));
  assert.ok(view.bank!.findings.some((f) => f.code === 'lead_days_short' && f.severity === 'warning'));
});

test('Wells Fargo wants a ten-character file id; its SFTP details are checked against its guide', async () => {
  const s = await setup({});
  assert.match(setupError(s.store, s.company.id, { bankProfile: 'wells_fargo' }).message, /ten-character file ID/);
  setPaymentSetup(s.store, s.company.id, { mode: 'employer_bank', employerBank: { ...BANK, immediateOrigin: '1123456789', bankProfile: 'wells_fargo', sftp: { ...SFTP, host: 'sftp.x.test' } } }, 'company');
  const f = paymentSetupView(s.store.companies.require(s.company.id, 'Company')).bank!.findings;
  assert.ok(f.some((x) => x.code === 'sftp_host_differs'), 'a host other than safetrans.wellsfargo.com is queried');
  assert.ok(f.some((x) => x.code === 'ip_allow_list'), 'fixed IP is called out');
  assert.ok(f.some((x) => x.code === 'pgp_off'));
  assert.ok(f.some((x) => x.code === 'routing_not_in_spec'));
  assert.equal(f.filter((x) => x.severity === 'error').length, 0);
});

test('Truist cannot be set up for SFTP, because it logs in with a password; upload still works', async () => {
  const s = await setup({});
  const err = setupError(s.store, s.company.id, { bankProfile: 'truist', sftp: SFTP });
  assert.match(err.message, /password login/);
  setPaymentSetup(s.store, s.company.id, { mode: 'employer_bank', employerBank: { ...BANK, bankProfile: 'truist' } }, 'company');
  assert.equal(s.store.companies.require(s.company.id, 'Company').payment.employerBank!.bankProfile, 'truist');
});

test('unconfirmed or undocumented SFTP only warns; the employer may know better than a public page', async () => {
  const s = await setup({});
  for (const [bankProfile, code] of [['chase_for_business', 'sftp_not_documented'], ['bank_of_america', 'sftp_unconfirmed']] as const) {
    setPaymentSetup(s.store, s.company.id, { mode: 'employer_bank', employerBank: { ...BANK, bankProfile, sftp: SFTP } }, 'company');
    const f = paymentSetupView(s.store.companies.require(s.company.id, 'Company')).bank!.findings;
    assert.ok(f.some((x) => x.code === code), bankProfile);
    assert.ok(f.every((x) => x.severity !== 'error'));
  }
});

test('an unknown bank, or a limits tier with no bank, is refused', async () => {
  const s = await setup({});
  assert.match(setupError(s.store, s.company.id, { bankProfile: 'first_bank_of_nowhere' }).message, /bankProfile must be one of/);
  assert.match(setupError(s.store, s.company.id, { limitsTier: 'x' }).message, /needs employerBank.bankProfile/);
  assert.match(setupError(s.store, s.company.id, { bankProfile: 'truist', limitsTier: 'gold' }).message, /no limits tier/);
});

test('with no bank chosen, setup behaves as before', async () => {
  const s = await setup({});
  const view = paymentSetupView(s.store.companies.require(s.company.id, 'Company'));
  assert.equal(view.bank, undefined);
  assert.equal(view.employerBank!.leadBankingDays, undefined);
});

// ---------------------------------------------------------------- files

test('a Chase file is dated at least three banking days out and still waits for the employer', async () => {
  const s = await setup({ bankProfile: 'chase_for_business' });
  const out = await s.ach.preparePayment(s.company.id, s.run.id);
  assert.equal(out.effectiveDate, '2026-06-12'); // Mon 8th + 3 banking days is Thu 11th, so the Fri 12th check date is reachable and wins
  assert.ok(out.effectiveDate! > '2026-06-08');
  assert.equal(s.store.achFiles.get(out.file!.id)!.status, 'created', 'nothing is released by preparing');
  assert.ok(out.bankChecks.every((f) => f.severity !== 'error'));
});

test('when the lead time makes the check date unreachable, the employer is told rather than paid late silently', async () => {
  const s = await setup({ bankProfile: 'chase_for_business' });
  s.setDay('2026-06-10'); // Wed + 3 banking days = Mon 15th, after the 12th check date
  await assert.rejects(() => s.ach.preparePayment(s.company.id, s.run.id), (e: ApiError) => e.code === 'check_date_unreachable');
});

test('Truist and KeyBank files carry the control totals and a reminder', async () => {
  const s = await setup({ bankProfile: 'truist' });
  const out = await s.ach.preparePayment(s.company.id, s.run.id);
  const note = out.bankChecks.find((f) => f.code === 'control_totals')!;
  assert.ok(note.message.includes(`${out.controlTotals!.entryCount} entries`));
  assert.ok(note.message.includes('credits $'));
});

test('a file over the bank\'s per-batch limit is refused and leaves nothing behind', async () => {
  const s = await setup({ bankProfile: 'regions', limitsTier: 'online_banking_business_services' }, { rateCents: 100_000, staff: 5 });
  await assert.rejects(() => s.ach.preparePayment(s.company.id, s.run.id), (e: ApiError) => {
    assert.equal(e.code, 'bank_rule_violation');
    assert.match(e.message, /per batch/);
    return true;
  });
  assert.equal(s.store.achFiles.where((f) => f.companyId === s.company.id).length, 0, 'the file was rolled back');
  assert.equal(s.store.legs.where((l) => l.runId === s.run.id).length, 0, 'and so were its payment legs');
  // The same payroll on a bank with no published limit goes through.
  const t = await setup({ bankProfile: 'other' }, { rateCents: 100_000, staff: 5 });
  assert.ok((await t.ach.preparePayment(t.company.id, t.run.id)).file);
});

// ---------------------------------------------------------------- rule checks on their own

const FILE = { kind: 'credit' as const, today: '2026-06-08', effectiveDate: '2026-06-09', entryCount: 3, creditsCents: 1_000_00, debitsCents: 0, largestEntryCents: 500_00, monthSoFarCents: 0 };

test('same-day, how far ahead, and per-entry limits', () => {
  const chase = profiles.chase_for_business;
  assert.deepEqual(checkFile(chase, { ...FILE, effectiveDate: '2026-06-08' }).filter((f) => f.severity === 'error').map((f) => f.code).sort(), ['effective_not_after_creation', 'same_day_unsupported']);
  const pnc = profiles.pnc;
  const big = checkFile(pnc, { ...FILE, effectiveDate: '2026-06-08', largestEntryCents: 100_000_01 });
  assert.ok(big.some((f) => f.code === 'same_day_entry_limit'));
  assert.equal(errorsOf(checkFile(pnc, { ...FILE, effectiveDate: '2026-06-08', largestEntryCents: 100_000_00 })).length, 0, 'exactly the limit is allowed');
  assert.equal(errorsOf(checkFile(pnc, { ...FILE, effectiveDate: '2026-06-09', largestEntryCents: 900_000_00 })).length, 0, 'the same-day limit does not apply to next-day files');
  const wells = profiles.wells_fargo; // 45 banking days
  assert.equal(errorsOf(checkFile(wells, { ...FILE, effectiveDate: '2026-08-11' })).length, 0, '45 banking days out is the last allowed day');
  assert.ok(errorsOf(checkFile(wells, { ...FILE, effectiveDate: '2026-08-12' })).some((f) => f.code === 'too_far_ahead'));
  const jpm = profiles.jpmorgan_commercial; // 90 calendar days
  assert.equal(errorsOf(checkFile(jpm, { ...FILE, effectiveDate: '2026-09-06' })).length, 0);
  assert.ok(errorsOf(checkFile(jpm, { ...FILE, effectiveDate: '2026-09-07' })).some((f) => f.code === 'too_far_ahead'));
});

test('monthly limit counts the other files already prepared that month', () => {
  const regions = profiles.regions;
  const base = { ...FILE, limitsTier: 'online_banking_business_services', creditsCents: 90_000_00 };
  assert.equal(errorsOf(checkFile(regions, { ...base, monthSoFarCents: 410_000_00 })).length, 0, 'exactly $500,000 is allowed');
  assert.ok(errorsOf(checkFile(regions, { ...base, monthSoFarCents: 410_000_01 })).some((f) => f.code === 'month_limit'));
  assert.equal(errorsOf(checkFile(regions, { ...base, creditsCents: 100_000_00 })).length, 0, 'exactly $100,000 per batch is allowed');
  assert.ok(errorsOf(checkFile(regions, { ...base, creditsCents: 100_000_01 })).some((f) => f.code === 'batch_limit'));
  assert.equal(errorsOf(checkFile(regions, { ...base, creditsCents: 900_000_00, limitsTier: undefined })).length, 0, 'no tier chosen, no limit applied');
});

test('setup checks stand on their own', () => {
  assert.equal(errorsOf(checkSetup(profiles.other, { odfiRoutingNumber: ROUTING, immediateOrigin: '1' })).length, 0);
  assert.ok(checkSetup(profiles.regions, { odfiRoutingNumber: ROUTING, immediateOrigin: '1' }).some((f) => f.code === 'limits_tier_available'));
});

// ---------------------------------------------------------------- API

const ADMIN = 'admin-token-bank-profile-tests';
const config: Config = { port: 0, dataFile: undefined, adminToken: ADMIN, openSignup: true, ach: { mode: 'outbox', outboxDir: '', config: { originator: { odfiRoutingNumber: '', odfiName: '', immediateOrigin: '', companyName: '', companyId: '' }, holdBankingDays: 2, fundingLeadBankingDays: 1, creditLeadBankingDays: 1, trustSettlementDate: false } }, autoDisburse: false, rateLimitPerMinute: 0, trustProxy: false };
let base = '';
let close: () => void;
before(async () => {
  const store = new Store();
  const banks = new BankService(store, new FakeStripe());
  const ach = new AchService(store, banks, new SandboxBank(), config.ach.config);
  const app = createApp({ store, banks, ach, config });
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  close = () => app.server.close();
});
after(() => close());

test('the bank list and each profile are public, so the setup screen can show them before signup', async () => {
  const list = await (await fetch(`${base}/v1/bank-profiles`)).json() as { banks: Array<{ id: string; sftp: string }> };
  assert.equal(list.banks.length, 14);
  assert.equal(list.banks.find((b) => b.id === 'truist')!.sftp, 'unsupported_auth');
  const wells = await (await fetch(`${base}/v1/bank-profiles/wells_fargo`)).json() as { sftp: { host: string }; askBank: string[] };
  assert.equal(wells.sftp.host, 'safetrans.wellsfargo.com');
  assert.ok(wells.askBank.length > 0);
  assert.equal((await fetch(`${base}/v1/bank-profiles/nope`)).status, 400);
});
