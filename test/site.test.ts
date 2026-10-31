import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/store/store.ts';
import { BankService } from '../src/banking/accounts.ts';
import { AchService } from '../src/money/ach.ts';
import { SandboxBank } from '../src/ach/sandbox.ts';
import { createApp } from '../src/api/app.ts';
import { AccountService } from '../src/accounts/accounts.ts';
import { setPasswordCost } from '../src/accounts/password.ts';
import { OutboxMailer } from '../src/mail/mailer.ts';
import type { Config } from '../src/config.ts';
import { FakeStripe } from './fake-stripe.ts';
import './helpers.ts';

setPasswordCost(1024);
const store = new Store();
const mailer = new OutboxMailer();
let base = '';
let close: () => void;
const config: Config = { publicBaseUrl: 'https://totali.example', port: 0, dataFile: undefined, adminToken: 'admin-token-site-tests-0123456789abcdef', openSignup: false, ach: { mode: 'outbox', outboxDir: '', config: { originator: { odfiRoutingNumber: '', odfiName: '', immediateOrigin: '', companyName: '', companyId: '' }, holdBankingDays: 2, fundingLeadBankingDays: 1, creditLeadBankingDays: 1, trustSettlementDate: false } }, autoDisburse: false, rateLimitPerMinute: 0, trustProxy: false };

before(async () => {
  const banks = new BankService(store, new FakeStripe());
  const app = createApp({ store, banks, ach: new AchService(store, banks, new SandboxBank(), config.ach.config), config, mailer, accounts: new AccountService(store, mailer) });
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  close = () => app.server.close();
});
after(() => close());


test('the site answers a load balancer, tells search engines what to leave alone, and sends HSTS', async () => {
  const ready = await fetch(base + '/ready');
  assert.equal(ready.status, 200); assert.deepEqual(await ready.json(), { ok: true });
  assert.equal(ready.headers.get('strict-transport-security'), 'max-age=31536000; includeSubDomains');
  assert.equal(ready.headers.get('x-content-type-options'), 'nosniff');
  const robots = await fetch(base + '/robots.txt');
  const text = await robots.text();
  assert.match(robots.headers.get('content-type')!, /text\/plain/);
  assert.match(text, /Disallow: \/app/); assert.match(text, /Disallow: \/v1\//); assert.match(text, /Sitemap: https:\/\/totali\.example\/sitemap\.xml/);
  const map = await fetch(base + '/sitemap.xml');
  const xml = await map.text();
  assert.match(map.headers.get('content-type')!, /application\/xml/);
  for (const u of ['https://totali.example<', 'https://totali.example/terms<', 'https://totali.example/privacy<']) assert.ok(xml.includes(u), u);
  assert.equal(xml.includes('/app'), false, 'private pages are not listed');
});

test('the front page and the legal pages are served, and a missing file is a 404, not the app', async () => {
  for (const p of ['/', '/terms', '/privacy']) { const r = await fetch(base + p); assert.equal(r.status, 200, p); assert.match(await r.text(), /Totali: payroll for restaurants/); }
  assert.equal((await fetch(base + '/assets/nope.css')).status, 404);
});
