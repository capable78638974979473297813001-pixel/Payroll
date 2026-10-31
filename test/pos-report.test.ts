import { test } from 'node:test';
import assert from 'node:assert/strict';
import './helpers.ts';
import { Store } from '../src/store/store.ts';
import { createCompanyFromSetup } from '../src/builder/finish.ts';
import { addEmployee } from '../src/domain/employees.ts';
import { saveWeek } from '../src/domain/weekEntry.ts';
import { PosService } from '../src/pos/service.ts';
import { detectColumns, readClock, readDate, readDuration, readMoney, readName } from '../src/pos/report.ts';
import type { Answers } from '../src/builder/catalog.ts';
import type { User } from '../src/accounts/types.ts';
import { ApiError } from '../src/lib/errors.ts';

const D = '2026-10-30';
const BASE: Answers = { state: 'MI', locations: [{ name: 'Main', city: 'Detroit', state: 'MI' }], team: '1-10', tips: { on: true, pool: 'hours' }, frequency: { value: 'weekly', weekday: 'friday' }, contractors: { on: false } };
function make() {
  const store = new Store();
  const company = createCompanyFromSetup(store, { id: 'u1', businessName: 'Harbor' } as User, 'restaurant', BASE, D, new Date(`${D}T15:00:00Z`));
  const mk = (first: string, last: string, email?: string, role = 'server') => addEmployee(store, company.id, { firstName: first, lastName: last, ...(email ? { email } : {}), roleKey: role, hireDate: '2026-01-05', payType: { kind: 'hourly', rateCents: 1500 }, ssn: `512-34-${String(Math.floor(Math.random() * 9000) + 1000)}` });
  return { store, company, svc: new PosService(store, () => new Date(`${D}T15:00:00Z`), (async () => new Response('{}')) as unknown as typeof fetch), mk };
}
const mine = (store: Store, id: string) => store.shifts.where((s) => s.employeeId === id).sort((a, b) => a.workDate.localeCompare(b.workDate));

test('values are read the way different systems write them', () => {
  assert.equal(readDate('2026-10-20'), '2026-10-20'); assert.equal(readDate('10/20/2026'), '2026-10-20'); assert.equal(readDate('10/20/26 5:00 PM'), '2026-10-20');
  assert.equal(readDate('Oct 20, 2026'), '2026-10-20'); assert.equal(readDate('20 October 2026'), '2026-10-20'); assert.equal(readDate('2026-10-20T17:00:00Z'), '2026-10-20');
  assert.equal(readDate('13/45/2026'), null); assert.equal(readDate('soon'), null);
  assert.equal(readClock('5:30 PM'), 17 * 60 + 30); assert.equal(readClock('17:30'), 17 * 60 + 30); assert.equal(readClock('12:15 AM'), 15); assert.equal(readClock('5pm'), 17 * 60);
  assert.equal(readClock('10/20/2026 9:05 AM'), 9 * 60 + 5); assert.equal(readClock('nope'), null);
  assert.equal(readDuration('6.5'), 390); assert.equal(readDuration('6:30'), 390); assert.equal(readDuration('6h 30m'), 390); assert.equal(readDuration('6 hrs 30 min'), 390); assert.equal(readDuration(''), null);
  assert.equal(readMoney('$84.50'), 8450); assert.equal(readMoney('1,204.10'), 120410); assert.equal(readMoney('(12.00)'), 0); assert.equal(readMoney('-3'), 0); assert.equal(readMoney(''), 0);
  assert.equal(readName('Cruz, Ana').full, 'Ana Cruz'); assert.equal(readName('Ana Cruz').full, 'Ana Cruz'); assert.equal(readName('Mary Ann Cruz').first, 'Mary Ann');
});

test('columns are found by what systems call them', () => {
  assert.deepEqual(detectColumns(['Employee', 'Date', 'Clock In', 'Clock Out', 'Paid Hours', 'Credit Tips', 'Cash Tips']), { name: 0, date: 1, clockIn: 2, clockOut: 3, hours: 4, cardTips: 5, cashTips: 6 });
  assert.deepEqual(detectColumns(['First Name', 'Last Name', 'Business Date', 'Time In', 'Time Out', 'Total Hours', 'Tips']), { first: 0, last: 1, date: 2, clockIn: 3, clockOut: 4, hours: 5, tips: 6 });
  const odd = detectColumns(['Staff Member', 'In Date', 'Clock In Time', 'Clock Out Time', 'Hours Worked']);
  assert.equal(odd.name, 0); assert.equal(odd.clockIn, 2); assert.equal(odd.clockOut, 3); assert.equal(odd.hours, 4);
});

test('a report with names, clock times, paid hours and tips is read, matched and saved', () => {
  const { svc, store, company, mk } = make();
  const ana = mk('Ana', 'Cruz', 'ana@harbor.test'); const ben = mk('Ben', 'Ode', undefined, 'line_cook');
  const report = { headers: ['Employee', 'Date', 'Clock In', 'Clock Out', 'Paid Hours', 'Credit Tips', 'Cash Tips'], rows: [
    ['Cruz, Ana', '10/20/2026', '5:00 PM', '11:30 PM', '6.5', '$84.50', '$20.00'],
    ['Ode, Ben', '10/21/2026', '9:00 AM', '5:00 PM', '7:30', '', ''],
    ['Ode, Ben', '10/22/2026', '10:00 PM', '2:00 AM', '', '', ''],
    ['Total', '', '', '', '14', '', ''],
    ['Pat Nobody', '10/21/2026', '9:00 AM', '1:00 PM', '4', '', ''],
    ['', '', '', '', '', '', ''],
    ['Cruz, Ana', 'not a date', '5:00 PM', '11:30 PM', '6.5', '', ''],
  ] };
  const look = svc.importReport(company.id, report);
  assert.deepEqual(look.mapping, { name: 0, date: 1, clockIn: 2, clockOut: 3, hours: 4, cardTips: 5, cashTips: 6 });
  assert.equal(look.applied, null); assert.equal(store.shifts.all().length, 0, 'looking changes nothing');
  assert.deepEqual(look.people.map((p) => [p.name, p.status, p.employeeId, p.suggestionBy]), [['Ana Cruz', 'matched', ana.id, 'name'], ['Ben Ode', 'matched', ben.id, 'name'], ['Pat Nobody', 'unmatched', null, null]], 'a person with the same name is matched; a stranger is not');
  assert.equal(look.problems.length, 1); assert.match(look.problems[0]!, /Row 8.*date/);
  assert.equal(look.skipped, 1, 'the Total row is not a person');
  const done = svc.importReport(company.id, { ...report, apply: true, links: { 'name:pat nobody': null } });
  assert.deepEqual(mine(store, ana.id).map((s) => [s.workDate, s.minutes, s.chargedTipsCents, s.cashTipsCents]), [['2026-10-20', 390, 8450, 2000]]);
  assert.deepEqual(mine(store, ben.id).map((s) => [s.workDate, s.minutes]), [['2026-10-21', 450], ['2026-10-22', 240]], 'paid hours as 7:30, and an overnight shift worked out from its clock times');
  assert.deepEqual([done.applied!.shifts, done.applied!.people, done.applied!.unmapped.length], [3, 2, 0], 'Pat is left out because the owner said so');
  // the same report again changes nothing, and a corrected one replaces the old rows
  svc.importReport(company.id, { ...report, apply: true });
  assert.equal(mine(store, ana.id).length, 1);
  const fixed = { ...report, rows: [['Cruz, Ana', '10/20/2026', '5:00 PM', '11:30 PM', '7', '$84.50', '$20.00'], ...report.rows.slice(1)] };
  svc.importReport(company.id, { ...fixed, apply: true });
  assert.deepEqual(mine(store, ana.id).map((s) => s.minutes), [420]);
  assert.equal(svc.catalog(company.id).connection!.provider, 'file');
});

test('hours from clock times alone, a break column, and a first/last/total-tips layout', () => {
  const { svc, store, company, mk } = make();
  const ana = mk('Ana', 'Cruz', 'ana@harbor.test');
  svc.importReport(company.id, { headers: ['First Name', 'Last Name', 'Email', 'Business Date', 'Time In', 'Time Out', 'Unpaid Break', 'Tips'], apply: true, rows: [
    ['Ana', 'Cruz', 'ANA@harbor.test', '2026-10-20', '17:00', '23:30', '30', '41.00'],
    ['Ana', 'Cruz', 'ana@harbor.test', '2026-10-21', '17:00', '23:00', '0.5', ''],
  ] });
  assert.deepEqual(mine(store, ana.id).map((s) => [s.minutes, s.chargedTipsCents]), [[360, 4100], [330, 0]], '6.5h less a 30 minute break; 0.5 is hours, 30 is minutes');
});

test('a report with no hours column, or no names, says what is missing and saves nothing', () => {
  const { svc, store, company, mk } = make();
  mk('Ana', 'Cruz');
  const r = svc.importReport(company.id, { headers: ['Employee', 'Location', 'Sales'], rows: [['Ana Cruz', 'Main', '300']] });
  assert.deepEqual(r.missing, ['the date', 'the hours (paid hours, or clock in and clock out)']);
  assert.throws(() => svc.importReport(company.id, { headers: ['Employee', 'Location', 'Sales'], rows: [['Ana Cruz', 'Main', '300']], apply: true }), (e: unknown) => e instanceof ApiError && /can’t find/.test(e.message));
  // the owner can point at the right column
  const fixed = svc.importReport(company.id, { headers: ['Who', 'Day', 'Hrs'], rows: [['Ana Cruz', '10/20/2026', '8']], mapping: { name: 0, date: 1, hours: 2 }, apply: true });
  assert.equal(fixed.applied!.shifts, 1); assert.equal(store.shifts.all().length, 1);
});

test('a report that covers a whole weekly box replaces it; one that covers part holds the person back instead of paying twice', () => {
  const { svc, store, company, mk } = make();
  const ana = mk('Ana', 'Cruz', 'ana@harbor.test');
  saveWeek(store, store.companies.get(company.id)!, { periodStart: '2026-10-19', periodEnd: '2026-10-25', entries: [{ employeeId: ana.id, regularMinutes: 2400 }] });
  const before = mine(store, ana.id).length;
  const one = svc.importReport(company.id, { headers: ['Employee', 'Date', 'Hours'], rows: [['Ana Cruz', '10/20/2026', '8']], apply: true });
  assert.equal(mine(store, ana.id).length, before, 'nothing was added on top of the weekly hours');
  assert.match(one.applied!.problems.join(' '), /Ana Cruz has weekly hours typed in for 2026-10-19 to 2026-10-25/);
  const week = ['19', '20', '21', '22', '23', '24', '25'].map((d) => ['Ana Cruz', `10/${d}/2026`, '6']);
  svc.importReport(company.id, { headers: ['Employee', 'Date', 'Hours'], rows: week, apply: true });
  assert.deepEqual(mine(store, ana.id).map((s) => s.externalId!.slice(0, 5)), Array(7).fill('file:'), 'the real shifts replaced the box');
});

test('a spreadsheet and a connected system do not mix, because they would count the same shift twice', async () => {
  const f = (async (url: string) => new Response(JSON.stringify(/companies$/.test(url) ? { data: [{ id: 5 }] } : { data: [], meta: { cursor: { next: null } } }))) as unknown as typeof fetch;
  const store = new Store();
  const company = createCompanyFromSetup(store, { id: 'u1', businessName: 'Harbor' } as User, 'restaurant', BASE, D, new Date(`${D}T15:00:00Z`));
  const svc = new PosService(store, () => new Date(`${D}T15:00:00Z`), f);
  await svc.connect(company.id, { provider: 'sevenshifts', accessToken: 't' });
  assert.throws(() => svc.importReport(company.id, { headers: ['Employee', 'Date', 'Hours'], rows: [['Ana Cruz', '10/20/2026', '8']] }), (e: unknown) => e instanceof ApiError && e.code === 'one_source');
  svc.disconnect(company.id);
  svc.importReport(company.id, { headers: ['Employee', 'Date', 'Hours'], rows: [['Ana Cruz', '10/20/2026', '8']], apply: true }).applied;
  await assert.rejects(svc.connect(company.id, { provider: 'sevenshifts', accessToken: 't' }), (e: unknown) => e instanceof ApiError && e.code === 'one_source');
});
