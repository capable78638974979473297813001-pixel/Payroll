import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/store.ts';
import { ContractorService, threshold1099Cents } from '../src/contractors/service.ts';
import { OutboxMailer } from '../src/mail/mailer.ts';
import { dashboardData } from '../src/dashboard/data.ts';
import { ApiError } from '../src/lib/errors.ts';
import { newCompany } from './helpers.ts';

const NOW = new Date('2026-10-30T15:00:00Z');
const make = () => { const store = new Store(); const { company } = newCompany(store); const mailer = new OutboxMailer(); return { store, company, mailer, svc: new ContractorService(store, mailer, () => NOW) }; };
const refused = (fn: () => unknown, re: RegExp) => assert.throws(fn, (e: unknown) => e instanceof ApiError && re.test(`${e.code} ${e.message}`), String(re));
const tokenOf = (link: string) => link.split('/w9/')[1]!;
const W9 = { tinType: 'ssn', tin: '512-34-9901', classification: 'Individual or sole proprietor', address: { street: '9 Pine St', city: 'Detroit', state: 'mi', zip: '48207' }, certify: true, signature: 'Sal Pipes' };

test('the 1099 line moved from $600 to $2,000 for payments after 2025', () => {
  assert.equal(threshold1099Cents(2025), 60_000);
  assert.equal(threshold1099Cents(2026), 200_000);
});

test('contractors are kept apart from payroll: payments add up by year and flag the 1099 line', () => {
  const { svc, company, store } = make();
  const sal = svc.add(company.id, { name: 'Sal Pipes', businessName: 'Pipes Plumbing', email: 'Sal@Pipes.test' });
  assert.equal(sal.email, 'sal@pipes.test');
  svc.addPayment(company.id, sal.id, { date: '2026-03-01', amountCents: 150_000, note: 'Water heater' });
  let v = svc.addPayment(company.id, sal.id, { date: '2026-09-10', amountCents: 60_000 });
  assert.equal(v.paidCents, 210_000);
  assert.equal(v.needs1099, true);
  svc.addPayment(company.id, sal.id, { date: '2025-12-31', amountCents: 99_999 });
  assert.equal(svc.list(company.id, 2026).paidCents, 210_000, 'last year is not this year');
  assert.equal(svc.list(company.id, 2025).contractors[0]!.needs1099, true, '$999.99 is over the old $600 line');
  refused(() => svc.addPayment(company.id, sal.id, { date: '2027-01-01', amountCents: 100 }), /future/);
  refused(() => svc.addPayment(company.id, sal.id, { date: '2026-01-01', amountCents: 0 }), /amountCents|invalid/);
  const pid = svc.list(company.id, 2026).contractors[0]!.payments[0]!.id;
  v = svc.removePayment(company.id, sal.id, pid);
  assert.equal(v.payments.length, 1);
  const d = dashboardData(store, store.companies.get(company.id)!, '2026-10-30');
  assert.equal(d.contractors.count, 1);
  assert.equal(d.contractors.w9, 0);
  assert.equal(d.contractors.ytdCents, v.paidCents);
  svc.archive(company.id, sal.id);
  assert.equal(svc.list(company.id).count, 0);
  assert.equal(store.contractors.all().length, 1, 'archived, never deleted');
});

test('a W-9 comes in through a private link, the TIN is kept encrypted, and the link dies after use', async () => {
  const { svc, company, mailer, store } = make();
  const sal = svc.add(company.id, { name: 'Sal Pipes', email: 'sal@pipes.test' });
  const r = await svc.requestW9(company.id, 'https://app.example', sal.id);
  assert.ok(r.link.startsWith('https://app.example/w9/'));
  assert.ok(mailer.messages.at(-1)!.text.includes(r.link));
  const tok = tokenOf(r.link);
  assert.equal(svc.w9Status(tok).name, 'Sal Pipes');
  refused(() => svc.submitW9(tok, { ...W9, signature: 'Someone Else' }), /Type your name/);
  refused(() => svc.submitW9(tok, { ...W9, tin: '123' }), /nine digits/);
  refused(() => svc.submitW9(tok, { ...W9, certify: false }), /Confirm/);
  svc.submitW9(tok, W9);
  const stored = store.contractors.get(sal.id)!;
  assert.equal(stored.tinLast4, '9901');
  assert.equal(JSON.stringify(stored).includes('512-34-9901') || JSON.stringify(stored).includes('512349901'), false);
  assert.equal(svc.tinOf(company.id, sal.id), '512349901');
  assert.equal(stored.address!.state, 'MI');
  refused(() => svc.w9Status(tok), /link_not_valid/);
  const view = svc.list(company.id).contractors[0]!;
  assert.equal(view.w9, true);
  assert.equal(JSON.stringify(view).includes('512'), false, 'the view never carries the number');
  for (const bad of ['', 'x', 'y'.repeat(43)]) refused(() => svc.w9Status(bad), /link_not_valid/);
});

test('the accountant export has totals and last four digits, never the full number', async () => {
  const { svc, company } = make();
  const a = svc.add(company.id, { name: 'Sal "The Pipe" Pipes' });
  svc.addPayment(company.id, a.id, { date: '2026-02-02', amountCents: 250_000 });
  const csv = svc.exportCsv(company.id, 2026);
  assert.equal(csv.fileName, 'contractors-2026.csv');
  assert.ok(csv.content.includes('"Sal ""The Pipe"" Pipes"') && csv.content.includes('"2500.00"') && csv.content.includes('"Yes"'));
});
