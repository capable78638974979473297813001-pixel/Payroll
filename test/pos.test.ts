import { test } from 'node:test';
import assert from 'node:assert/strict';
import './helpers.ts';
import { Store } from '../src/store/store.ts';
import { createCompanyFromSetup } from '../src/builder/finish.ts';
import { addEmployee } from '../src/domain/employees.ts';
import { saveWeek } from '../src/domain/weekEntry.ts';
import { PosService } from '../src/pos/service.ts';
import { ApiError } from '../src/lib/errors.ts';
import type { Answers } from '../src/builder/catalog.ts';
import type { User } from '../src/accounts/types.ts';

const D = '2026-10-30'; let t = new Date(`${D}T15:00:00Z`).getTime();
const BASE: Answers = { state: 'MI', locations: [{ name: 'Main', city: 'Detroit', state: 'MI' }], team: '1-10', tips: { on: true, pool: 'hours' }, frequency: { value: 'weekly', weekday: 'friday' }, contractors: { on: false } };
type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

/** A pretend point of sale: answers by URL, and remembers what it was asked. */
function fake(handlers: Array<[RegExp, (c: Call) => unknown]>) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    const c: Call = { url, method: init.method ?? 'GET', headers: Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])), body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(c);
    const h = handlers.find(([re]) => re.test(`${c.method} ${url}`));
    if (!h) return new Response('{}', { status: 404 });
    const out = h[1](c);
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { f, calls };
}

function make(f: typeof fetch) {
  t = new Date(`${D}T15:00:00Z`).getTime();
  const store = new Store();
  const company = createCompanyFromSetup(store, { id: 'u1', businessName: 'Harbor' } as User, 'restaurant', BASE, D, new Date(t));
  const mk = (first: string, last: string, email?: string, role = 'server') => addEmployee(store, company.id, { firstName: first, lastName: last, ...(email ? { email } : {}), roleKey: role, hireDate: '2026-01-05', payType: { kind: 'hourly', rateCents: 1500 }, ssn: `512-34-${String(Math.floor(Math.random() * 9000) + 1000)}` });
  const svc = new PosService(store, () => new Date(t), f);
  return { store, company, svc, mk, advance: (ms: number) => { t += ms; } };
}
const PERIOD = { from: '2026-10-19', to: '2026-10-25' };
const mine = (store: Store, id: string) => store.shifts.where((s) => s.employeeId === id).sort((a, b) => a.workDate.localeCompare(b.workDate));
const refused = (p: Promise<unknown>, re: RegExp) => assert.rejects(p, (e: unknown) => e instanceof ApiError && re.test(`${e.code} ${e.message}`), String(re));

const TOAST_ENTRIES = [
  { guid: 'te1', employeeReference: { guid: 'e-ana' }, inDate: '2026-10-20T21:00:00.000+0000', outDate: '2026-10-21T03:30:00.000+0000', businessDate: '20261020', regularHours: 6.5, overtimeHours: 0, nonCashTips: 84.5, declaredCashTips: 20 },
  { guid: 'te2', employeeReference: { guid: 'e-ana' }, inDate: '2026-10-22T21:00:00.000+0000', outDate: null, businessDate: '20261022', regularHours: 0, overtimeHours: 0, nonCashTips: 0, declaredCashTips: 0 },
  { guid: 'te3', employeeReference: { guid: 'e-ben' }, inDate: '2026-10-21T15:00:00.000+0000', outDate: '2026-10-21T23:00:00.000+0000', businessDate: '20261021', regularHours: 8, overtimeHours: 0, nonCashTips: 0, declaredCashTips: 0 },
  { guid: 'te4', employeeReference: { guid: 'e-zed' }, inDate: '2026-10-21T15:00:00.000+0000', outDate: '2026-10-21T19:00:00.000+0000', businessDate: '20261021', regularHours: 4, overtimeHours: 0, nonCashTips: 0, declaredCashTips: 0 },
  { guid: 'te5', employeeReference: { guid: 'e-ana' }, inDate: '2026-10-24T21:00:00.000+0000', outDate: '2026-10-25T01:00:00.000+0000', businessDate: '20261024', regularHours: 4, overtimeHours: 0, nonCashTips: 0, declaredCashTips: 0, deleted: true },
];
const toast = (entries = TOAST_ENTRIES) => fake([
  [/POST .*\/authentication\/v1\/authentication\/login/, () => ({ token: { accessToken: 'tok', tokenType: 'Bearer', expiresIn: 3600 }, status: 'SUCCESS' })],
  [/GET .*\/labor\/v1\/employees/, () => [{ guid: 'e-ana', firstName: 'Ana', lastName: 'Cruz', email: 'ANA@harbor.test' }, { guid: 'e-ben', firstName: 'Ben', lastName: 'Ode' }, { guid: 'e-zed', firstName: 'Zed', lastName: 'Nobody' }, { guid: 'e-old', firstName: 'Old', lastName: 'Hand', deleted: true }]],
  [/GET .*\/labor\/v1\/timeEntries/, () => entries],
]);
const TOAST = { provider: 'toast', clientId: 'cid', clientSecret: 'shh-secret', restaurantGuid: 'rest-guid' };

test('Toast: details are checked first, kept encrypted, and one source at a time', async () => {
  const { f, calls } = toast();
  const { svc, store, company } = make(f);
  await refused(svc.connect(company.id, { provider: 'toast', clientId: 'x' }), /client secret/);
  const c = await svc.connect(company.id, TOAST);
  assert.equal(JSON.stringify(c).includes('shh-secret'), false, 'the secret is never sent back');
  assert.equal(JSON.stringify(store.posConnections.all()).includes('shh-secret'), false, 'and never stored in the clear');
  const login = calls.find((x) => /authentication/.test(x.url))!;
  assert.deepEqual(login.body, { clientId: 'cid', clientSecret: 'shh-secret', userAccessType: 'TOAST_MACHINE_CLIENT' });
  const emp = calls.find((x) => /labor\/v1\/employees/.test(x.url))!;
  assert.equal(emp.headers.authorization, 'Bearer tok'); assert.equal(emp.headers['toast-restaurant-external-id'], 'rest-guid');
  await refused(svc.connect(company.id, TOAST), /one_source/);
  assert.equal(svc.catalog(company.id).connection!.provider, 'toast');
  svc.disconnect(company.id);
  assert.equal(svc.catalog(company.id).connection, null);
});

test('Toast: details the other system refuses are not kept', async () => {
  const { f } = fake([[/POST .*login/, () => new Response('{}', { status: 401 })]]);
  const { svc, store, company } = make(f);
  await refused(svc.connect(company.id, TOAST), /refused those details/);
  assert.equal(store.posConnections.all().length, 0);
});

test('Toast: hours and tips come in, matched by email, and a second pull changes nothing', async () => {
  const { f, calls } = toast();
  const { svc, store, company, mk, advance } = make(f);
  const ana = mk('Ana', 'Cruz', 'ana@harbor.test'); const ben = mk('Ben', 'Ode', undefined, 'line_cook');
  await svc.connect(company.id, TOAST);
  const people = await svc.people(company.id);
  assert.deepEqual(people.people.map((p) => [p.name, p.status, p.suggestion, p.suggestionBy]), [['Ana Cruz', 'new', ana.id, 'email'], ['Ben Ode', 'new', ben.id, 'name'], ['Zed Nobody', 'new', null, null]], 'a deleted person is not offered');
  const r = await svc.sync(company.id, PERIOD);
  const anaShifts = mine(store, ana.id);
  assert.deepEqual(anaShifts.map((s) => [s.workDate, s.minutes, s.chargedTipsCents, s.cashTipsCents, s.externalId]), [['2026-10-20', 390, 8450, 2000, 'pos:toast:te1']], 'open and deleted entries are left out');
  assert.equal(mine(store, ben.id).length, 0, 'a name match is offered, not applied');
  assert.deepEqual(r.unmapped.map((u) => [u.name, u.minutes]), [['Ben Ode', 480], ['Zed Nobody', 240]]);
  assert.deepEqual([r.shifts, r.people, r.minutes, r.tipsCents], [1, 1, 390, 10450]);
  const url = calls.find((x) => /timeEntries/.test(x.url))!.url;
  assert.match(decodeURIComponent(url), /startDate=2026-10-18T00:00:00\.000\+0000/);
  // the owner matches Ben, ignores Zed, and the next pull picks Ben up
  svc.link(company.id, { externalId: 'e-ben', employeeId: ben.id });
  svc.link(company.id, { externalId: 'e-zed', employeeId: null });
  advance(10_000);
  const r2 = await svc.sync(company.id, PERIOD);
  assert.deepEqual(r2.unmapped, []);
  assert.equal(mine(store, ben.id).length, 1);
  assert.equal(mine(store, ana.id).length, 1, 'pulling again does not pay a shift twice');
  assert.throws(() => svc.link(company.id, { externalId: 'e-zed', employeeId: ben.id }), /already linked/);
});

test('Toast: a shift deleted over there disappears here, and a shift already paid is never touched', async () => {
  let entries = TOAST_ENTRIES;
  const { f } = fake([
    [/POST .*login/, () => ({ token: { accessToken: 'tok' } })],
    [/GET .*employees/, () => [{ guid: 'e-ana', firstName: 'Ana', lastName: 'Cruz', email: 'ana@harbor.test' }]],
    [/GET .*timeEntries/, () => entries],
  ]);
  const { svc, store, company, mk, advance } = make(f);
  const ana = mk('Ana', 'Cruz', 'ana@harbor.test');
  await svc.connect(company.id, TOAST);
  await svc.sync(company.id, PERIOD);
  assert.equal(mine(store, ana.id).length, 1);
  entries = [];
  advance(10_000);
  const r = await svc.sync(company.id, PERIOD);
  assert.equal(mine(store, ana.id).length, 0); assert.equal(r.removed, 1);
  // put it back, then lock it into a pay run: it neither changes nor is removed
  entries = TOAST_ENTRIES; advance(10_000);
  await svc.sync(company.id, PERIOD);
  const shift = mine(store, ana.id)[0]!;
  store.tx(() => store.shifts.put({ ...shift, lockedByRunId: 'run_x' }));
  entries = [{ ...TOAST_ENTRIES[0]!, regularHours: 9 }]; advance(10_000);
  const r2 = await svc.sync(company.id, PERIOD);
  assert.equal(mine(store, ana.id)[0]!.minutes, 390, 'a paid shift is final');
  assert.ok(r2.problems.some((p) => /Ana Cruz/.test(p)), 'and the owner is told');
});

test('a weekly box of hours is replaced once the real shifts arrive', async () => {
  const { f } = toast();
  const { svc, store, company, mk } = make(f);
  const ana = mk('Ana', 'Cruz', 'ana@harbor.test');
  saveWeek(store, store.companies.get(company.id)!, { periodStart: PERIOD.from, periodEnd: PERIOD.to, entries: [{ employeeId: ana.id, regularMinutes: 2400 }] });
  assert.ok(mine(store, ana.id).length > 1);
  await svc.connect(company.id, TOAST);
  await svc.sync(company.id, PERIOD);
  assert.deepEqual(mine(store, ana.id).map((s) => s.externalId), ['pos:toast:te1'], 'the box is gone, the shifts are what the time clock says');
});

test('Square: staff and timecards are read the way Square documents them, and card tips follow the team member', async () => {
  const f = fake([
    [/GET .*\/v2\/locations$/, () => ({ locations: [{ id: 'L1', name: 'Harbor Street', status: 'ACTIVE' }] })],
    [/POST .*\/v2\/team-members\/search/, (c) => ((c.body as { cursor?: string }).cursor ? { team_members: [{ id: 'tm2', given_name: 'Ben', family_name: 'Ode' }] } : { team_members: [{ id: 'tm1', given_name: 'Ana', family_name: 'Cruz', email_address: 'Ana@Harbor.test' }], cursor: 'next' })],
    [/POST .*\/v2\/labor\/timecards\/search/, () => ({ timecards: [
      { id: 'tc1', team_member_id: 'tm1', location_id: 'L1', timezone: 'America/Detroit', start_at: '2026-10-21T00:00:00Z', end_at: '2026-10-21T07:00:00Z', breaks: [{ start_at: '2026-10-21T03:00:00Z', end_at: '2026-10-21T03:30:00Z', is_paid: false }, { start_at: '2026-10-21T04:00:00Z', end_at: '2026-10-21T04:10:00Z', is_paid: true }], declared_cash_tip_money: { amount: 1500, currency: 'USD' }, status: 'CLOSED' },
      { id: 'tc2', team_member_id: 'tm2', start_at: '2026-10-22T15:00:00Z', end_at: '2026-10-22T19:00:00Z', status: 'CLOSED' },
    ] })],
    [/GET .*\/v2\/payments/, () => ({ payments: [
      { id: 'p1', status: 'COMPLETED', source_type: 'CARD', team_member_id: 'tm1', created_at: '2026-10-21T02:00:00Z', tip_money: { amount: 700 } },
      { id: 'p2', status: 'COMPLETED', source_type: 'CARD', team_member_id: 'tm1', created_at: '2026-10-21T05:00:00Z', tip_money: { amount: 300 } },
      { id: 'p3', status: 'COMPLETED', source_type: 'CASH', team_member_id: 'tm1', created_at: '2026-10-21T02:00:00Z', tip_money: { amount: 999 } },
      { id: 'p4', status: 'COMPLETED', source_type: 'CARD', created_at: '2026-10-21T02:00:00Z', tip_money: { amount: 250 } },
      { id: 'p5', status: 'COMPLETED', source_type: 'CARD', team_member_id: 'tm1', created_at: '2026-10-24T02:00:00Z', tip_money: { amount: 111 } },
    ] })],
  ]);
  const { svc, store, company, mk } = make(f.f);
  const ana = mk('Ana', 'Cruz', 'ana@harbor.test');
  const c = await svc.connect(company.id, { provider: 'square', accessToken: 'sq-token' });
  assert.equal(c.label, 'Square: Harbor Street');
  const people = await svc.people(company.id);
  assert.deepEqual(people.people.map((p) => p.name), ['Ana Cruz', 'Ben Ode'], 'both pages of staff');
  const r = await svc.sync(company.id, PERIOD);
  const s = mine(store, ana.id);
  assert.deepEqual(s.map((x) => [x.workDate, x.minutes, x.chargedTipsCents, x.cashTipsCents]), [['2026-10-20', 390, 1000, 1500]], '7 hours less a 30 minute unpaid break; paid break stays; the late-evening shift belongs to the day it started in Detroit');
  assert.ok(r.notes.some((n) => /2\.50/.test(n)), 'tips with no team member are reported, not guessed');
  assert.ok(r.notes.some((n) => /1\.11/.test(n)), 'tips taken when nobody was clocked in are reported');
  const search = f.calls.find((x) => /timecards\/search/.test(x.url))!;
  assert.equal(search.headers['square-version'], '2026-09-16'); assert.equal(search.headers.authorization, 'Bearer sq-token');
  assert.deepEqual((search.body as { query: { filter: { location_ids: string[]; status: string; workday: unknown } } }).query.filter, { location_ids: ['L1'], status: 'CLOSED', workday: { date_range: { start_date: '2026-10-19', end_date: '2026-10-25' }, match_timecards_by: 'START_AT', default_timezone: 'America/Detroit' } });
});

test('Square: with several locations it asks which one, rather than guessing', async () => {
  const { f } = fake([[/GET .*\/v2\/locations/, () => ({ locations: [{ id: 'A' }, { id: 'B' }] })]]);
  const { svc, company } = make(f);
  await refused(svc.connect(company.id, { provider: 'square', accessToken: 't' }), /more than one Square location/);
});

test('7shifts: staff and time punches are read by business date, page by page', async () => {
  const f = fake([
    [/GET .*\/v2\/companies$/, () => ({ data: [{ id: 555 }] })],
    [/GET .*\/v2\/company\/555\/users/, () => ({ data: [{ id: 11, first_name: 'Ana', last_name: 'Cruz', email: 'ana@harbor.test', active: true }], meta: { cursor: { next: null } } })],
    [/GET .*\/v2\/company\/555\/time_punches/, (c) => (/cursor=c2/.test(c.url)
      ? { data: [{ id: 902, user_id: 11, clocked_in: '2026-10-22T14:00:00Z', clocked_out: null, tips: 0 }], meta: { cursor: { next: null } } }
      : { data: [{ id: 901, user_id: 11, clocked_in: '2026-10-21T22:00:00Z', clocked_out: '2026-10-22T04:30:00Z', tips: 4200, breaks: [{ paid: false, in: '2026-10-22T01:00:00Z', out: '2026-10-22T01:30:00Z' }] }], meta: { cursor: { next: 'c2' } } })],
  ]);
  const { svc, store, company, mk } = make(f.f);
  const ana = mk('Ana', 'Cruz', 'ana@harbor.test');
  await svc.connect(company.id, { provider: 'sevenshifts', accessToken: 'ss-token' });
  const r = await svc.sync(company.id, PERIOD);
  assert.deepEqual(mine(store, ana.id).map((x) => [x.workDate, x.minutes, x.chargedTipsCents]), [['2026-10-21', 360, 4200]], 'six and a half hours less thirty minutes; the open punch waits');
  assert.ok(r.notes.some((n) => /card tips/.test(n)));
  const punches = f.calls.filter((x) => /time_punches/.test(x.url));
  assert.equal(punches.length, 2);
  assert.match(punches[0]!.url, /business_date_start=2026-10-19&business_date_end=2026-10-25/);
  assert.equal(punches[0]!.headers.authorization, 'Bearer ss-token');
});

test('a period over two months, or pulling twice in a breath, is refused; so is pulling with nothing connected', async () => {
  const { f } = toast();
  const { svc, company, advance } = make(f);
  await refused(svc.sync(company.id, PERIOD), /not_connected/);
  await svc.connect(company.id, TOAST);
  await assert.rejects(svc.sync(company.id, { from: '2026-01-01', to: '2026-10-25' }), /up to two months/);
  await svc.sync(company.id, PERIOD);
  await refused(svc.sync(company.id, PERIOD), /too_soon/);
  advance(9_000);
  await svc.sync(company.id, PERIOD);
});

test('Clover: staff, shifts in epoch milliseconds and card tips by employee, read as Clover documents them', async () => {
  const at = (iso: string) => Date.parse(iso);
  const f = fake([
    [/GET .*\/v3\/merchants\/M1\/employees/, () => ({ elements: [{ id: 'c1', name: 'Ana Cruz', email: 'Ana@Harbor.test', role: 'EMPLOYEE' }, { id: 'c2', name: 'Ben Ode' }, { id: 'c3', name: 'Gone Person', deletedTime: 1700000000000 }] })],
    [/GET .*\/v3\/merchants\/M1\/shifts/, () => ({ elements: [
      { id: 's1', employee: { id: 'c1', name: 'Ana Cruz' }, inTime: at('2026-10-21T00:00:00Z'), outTime: at('2026-10-21T06:30:00Z'), cashTipsCollected: 1800 },
      { id: 's2', employee: { id: 'c1' }, inTime: at('2026-10-22T21:00:00Z'), outTime: at('2026-10-22T22:00:00Z'), overrideInTime: at('2026-10-22T20:00:00Z'), overrideOutTime: at('2026-10-22T23:00:00Z') },
      { id: 's3', employee: { id: 'c2' }, inTime: at('2026-10-22T21:00:00Z') },
    ] })],
    [/GET .*\/v3\/merchants\/M1\/payments/, () => ({ elements: [
      { id: 'p1', result: 'SUCCESS', tipAmount: 900, employee: { id: 'c1' }, createdTime: at('2026-10-21T02:00:00Z') },
      { id: 'p2', result: 'VOIDED', tipAmount: 777, employee: { id: 'c1' }, createdTime: at('2026-10-21T02:00:00Z') },
      { id: 'p3', result: 'SUCCESS', tipAmount: 300, createdTime: at('2026-10-21T02:00:00Z') },
      { id: 'p4', result: 'SUCCESS', tipAmount: 150, employee: { id: 'c1' }, createdTime: at('2026-10-24T02:00:00Z') },
    ] })],
  ]);
  const { svc, store, company, mk } = make(f.f);
  const ana = mk('Ana', 'Cruz', 'ana@harbor.test');
  await svc.connect(company.id, { provider: 'clover', merchantId: 'M1', accessToken: 'cl-token' });
  const first = f.calls[0]!;
  assert.match(first.url, /^https:\/\/api\.clover\.com\/v3\/merchants\/M1\/employees/); assert.equal(first.headers.authorization, 'Bearer cl-token'); assert.ok(first.headers['user-agent']);
  const people = await svc.people(company.id);
  assert.deepEqual(people.people.map((p) => p.name), ['Ana Cruz', 'Ben Ode'], 'a deleted employee is not offered');
  const r = await svc.sync(company.id, PERIOD);
  assert.deepEqual(mine(store, ana.id).map((x) => [x.workDate, x.minutes, x.chargedTipsCents, x.cashTipsCents]), [['2026-10-20', 390, 900, 1800], ['2026-10-22', 180, 0, 0]], 'an override replaces the punched time; a void is not a tip; the open shift waits');
  assert.ok(r.notes.some((n) => /3\.00/.test(n)) && r.notes.some((n) => /1\.50/.test(n)));
  const shifts = f.calls.find((x) => /\/shifts/.test(x.url))!;
  assert.match(decodeURIComponent(shifts.url), /filter=in_time>=\d+&filter=in_time<=\d+&limit=1000&offset=0/);
});
