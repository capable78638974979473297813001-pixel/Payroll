import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build, checkAnswer, normalizeAnswers, QUESTIONS, INDUSTRY_IDS, type Answers, type IndustryId } from '../src/builder/catalog.ts';
import { localTax, stateFacts } from '../src/builder/facts.ts';

const D = '2026-10-30';
const counts = (r: ReturnType<typeof build>) => [r.counts.modules, r.counts.items, r.counts.forms];
const ids = (r: ReturnType<typeof build>) => r.modules.map((m) => m.id);
const items = (r: ReturnType<typeof build>, mod: string) => r.modules.find((m) => m.id === mod)?.items.map((i) => i.id) ?? [];

const DETROIT_FERNDALE = [{ name: 'Detroit', city: 'Detroit', state: 'MI' }, { name: 'Ferndale', city: 'Ferndale', state: 'MI' }];

// ---------------------------------------------------------------- the example in the design, number for number

test('a restaurant starts with 5 modules, 12 items and 3 forms', () => {
  const r = build('restaurant', {}, D);
  assert.deepEqual(counts(r), [5, 12, 3]);
  assert.deepEqual(ids(r), ['pay_run', 'team', 'hours_tips', 'federal_taxes', 'new_hire_forms']);
  assert.deepEqual(items(r, 'pay_run'), ['pay_schedule', 'overtime_flags', 'pay_stubs']);
  assert.deepEqual(items(r, 'federal_taxes'), ['fed_income_tax', 'fica', 'futa']);
  assert.deepEqual(items(r, 'new_hire_forms'), ['form_w4', 'form_i9', 'form_direct_deposit']);
  assert.deepEqual(items(r, 'hours_tips'), ['hours_entry', 'tip_entry']);
});

test('Michigan adds its card with withholding, the MI-W4, unemployment, minimum wage and sick time', () => {
  const r = build('restaurant', { state: 'MI' }, D);
  assert.deepEqual(counts(r), [6, 17, 4]);
  const mi = r.modules.find((m) => m.id === 'state_mi')!;
  assert.equal(mi.label, 'Michigan');
  assert.deepEqual(mi.items.map((i) => i.label), ['State income tax withholding', 'MI-W4', 'State unemployment account', 'Minimum wage reference', 'Earned sick time reference']);
  assert.equal(mi.items.find((i) => i.label === 'MI-W4')!.form, true);
});

test('Detroit adds city income tax inside the Michigan card and a Locations card; Ferndale adds nothing', () => {
  const only = build('restaurant', { state: 'MI', locations: [DETROIT_FERNDALE[1]!] }, D);
  assert.deepEqual(counts(only), [6, 17, 4], 'one location with no city tax adds nothing');
  const r = build('restaurant', { state: 'MI', locations: DETROIT_FERNDALE }, D);
  assert.deepEqual(counts(r), [7, 20, 4]);
  assert.ok(items(r, 'state_mi').includes('city_tax_detroit'));
  assert.ok(!items(r, 'state_mi').some((i) => i.includes('ferndale')));
  assert.deepEqual(items(r, 'locations'), ['loc_detroit', 'loc_ferndale']);
  assert.deepEqual(localTax('MI', 'Ferndale', D), null);
  assert.equal(localTax('MI', 'detroit', D)!.residentRate, 0.024);
});

test('11 to 25 people adds bulk invite by spreadsheet', () => {
  const base = { state: 'MI', locations: DETROIT_FERNDALE };
  assert.ok(!items(build('restaurant', { ...base, team: '1-10' }, D), 'team').includes('bulk_invite'));
  const r = build('restaurant', { ...base, team: '11-25' }, D);
  assert.ok(items(r, 'team').includes('bulk_invite'));
  assert.equal(r.counts.items, 21);
});

test('tips: yes adds tip reporting, a tip pool, a tip credit reference and tips in taxable wages; no removes tip entry', () => {
  const a: Answers = { state: 'MI', locations: DETROIT_FERNDALE, team: '11-25' };
  const yes = build('restaurant', { ...a, tips: { on: true, pool: 'hours' } }, D);
  assert.equal(yes.counts.items, 25);
  assert.deepEqual(items(yes, 'hours_tips'), ['hours_entry', 'tip_entry', 'tip_reporting', 'tip_pool']);
  assert.ok(items(yes, 'state_mi').includes('tip_credit_ref'));
  assert.ok(items(yes, 'federal_taxes').includes('tips_taxable'));
  assert.equal(yes.modules.find((m) => m.id === 'hours_tips')!.items.find((i) => i.id === 'tip_pool')!.label, 'Tip pool split by hours');
  const byRole = build('restaurant', { ...a, tips: { on: true, pool: 'points' } }, D);
  assert.equal(byRole.modules.find((m) => m.id === 'hours_tips')!.items.find((i) => i.id === 'tip_pool')!.label, 'Tip pool split by role');
  const no = build('restaurant', { ...a, tips: { on: false, pool: 'none' } }, D);
  assert.equal(no.counts.items, 20, 'tip entry is removed and none of the four are added');
  assert.deepEqual(items(no, 'hours_tips'), ['hours_entry']);
  const noPool = build('restaurant', { ...a, tips: { on: true, pool: 'none' } }, D);
  assert.equal(noPool.counts.items, 24, 'tips without a pool: three of the four');
});

test('weekly, paid Fridays fills in the pay schedule', () => {
  const r = build('restaurant', { frequency: { value: 'weekly', weekday: 'friday' } }, D);
  assert.equal(r.modules[0]!.items[0]!.detail, 'Weekly, paid Fridays');
  assert.equal(build('restaurant', { frequency: { value: 'semimonthly' } }, D).modules[0]!.items[0]!.detail, 'Twice a month');
  assert.equal(build('restaurant', { frequency: { value: 'biweekly', weekday: 'thursday' } }, D).modules[0]!.items[0]!.detail, 'Every other week, paid Thursdays');
});

test('contractors, about 2, add a separate card: the full example ends at 8 modules, 28 items, 4 forms', () => {
  const full: Answers = { state: 'MI', locations: DETROIT_FERNDALE, team: '11-25', tips: { on: true, pool: 'hours' }, frequency: { value: 'weekly', weekday: 'friday' }, contractors: { on: true, count: 2 } };
  const r = build('restaurant', full, D);
  assert.deepEqual(counts(r), [8, 28, 4]);
  assert.deepEqual(items(r, 'contractors'), ['contractor_1099', 'contractor_w9', 'contractor_pay']);
  assert.equal(r.modules.find((m) => m.id === 'contractors')!.items[0]!.detail, 'About 2');
  assert.equal(r.progress.ready, true);
  assert.deepEqual(build('restaurant', { ...full, contractors: { on: false } }, D).counts, { modules: 7, items: 25, forms: 4 });
});

test('the numbers hold whatever order the questions are answered in', () => {
  const steps: Array<[keyof Answers, unknown]> = [['contractors', { on: true, count: 2 }], ['tips', { on: true, pool: 'hours' }], ['team', '11-25'], ['locations', DETROIT_FERNDALE], ['state', 'MI'], ['frequency', { value: 'weekly', weekday: 'friday' }]];
  const a: Record<string, unknown> = {};
  for (const [k, v] of steps) a[k] = v;
  assert.deepEqual(counts(build('restaurant', a as Answers, D)), [8, 28, 4]);
});

// ---------------------------------------------------------------- left out, progress

test('the left-out strip says what is not added yet and why', () => {
  const none = build('restaurant', {}, D);
  const labels = none.leftOut.map((l) => l.id);
  for (const id of ['state', 'locations', 'team', 'tips', 'contractors']) assert.ok(labels.includes(id), id);
  assert.match(none.leftOut.find((l) => l.id === 'tips')!.why, /Answer Tipped staff to add/);
  const said = build('restaurant', { tips: { on: false, pool: 'none' } }, D);
  assert.match(said.leftOut.find((l) => l.id === 'tips')!.why, /You said no/);
  const done = build('restaurant', { state: 'MI', locations: DETROIT_FERNDALE, team: '11-25', tips: { on: true, pool: 'hours' }, frequency: { value: 'weekly', weekday: 'friday' }, contractors: { on: true } }, D);
  assert.deepEqual(done.leftOut, [], 'nothing left out');
});

test('progress follows the rail and is ready once the required answers are in', () => {
  const r0 = build('restaurant', {}, D);
  assert.deepEqual([r0.progress.next, r0.progress.total, r0.progress.ready], ['state', 6, false]);
  const r1 = build('restaurant', { state: 'MI', locations: DETROIT_FERNDALE, team: '1-10', tips: { on: false, pool: 'none' }, frequency: { value: 'monthly' } }, D);
  assert.equal(r1.progress.next, 'contractors');
  assert.equal(r1.progress.ready, true, 'contractors are optional');
  assert.equal(build('restaurant', { state: 'MI' }, D).progress.ready, false);
});

// ---------------------------------------------------------------- other states and industries

test('a state with no income tax and no sick leave law has a smaller card', () => {
  const r = build('restaurant', { state: 'TX' }, D);
  assert.deepEqual(items(r, 'state_tx'), ['state_tx_unemployment', 'state_tx_min_wage']);
  assert.equal(stateFacts('TX', D).incomeTax, false);
  assert.equal(stateFacts('CA', D).incomeTax, true);
  assert.equal(stateFacts('CA', D).sickLeaveLaw, true);
});

test('a location in another state adds that state\'s card, and a taxing Ohio city is found', () => {
  const r = build('restaurant', { state: 'MI', locations: [{ name: 'Home', city: 'Ferndale', state: 'MI' }, { name: 'Columbus shop', city: 'Columbus', state: 'OH' }] }, D);
  assert.ok(ids(r).includes('state_oh') && ids(r).includes('state_mi'));
  assert.ok(items(r, 'state_oh').includes('city_tax_columbus'));
});

test('each industry has its own base, and its own questions end in the same required three', () => {
  for (const id of INDUSTRY_IDS) {
    const r = build(id, {}, D);
    assert.ok(r.counts.modules === 5 && r.counts.forms === 3, id);
    assert.ok(QUESTIONS[id].some((q) => q.id === 'state') && QUESTIONS[id].some((q) => q.id === 'frequency'), id);
  }
  assert.equal(build('restaurant', {}, D).counts.items, 12);
  assert.equal(build('office_studios', {}, D).counts.items, 11, 'no tip entry outside restaurants');
});

test('hotels: departments, seasonal staff and service charges each add their parts', () => {
  const r = build('hotel_lodging', { state: 'OH', departments: { on: true, names: ['Front desk', 'Housekeeping'] }, seasonal: { on: true }, service: { on: true } }, D);
  assert.deepEqual(items(r, 'departments'), ['dept_tags', 'dept_costs']);
  assert.equal(r.modules.find((m) => m.id === 'departments')!.items[0]!.detail, 'Front desk, Housekeeping');
  assert.deepEqual(items(r, 'seasonal'), ['seasonal_dates', 'seasonal_ending']);
  assert.ok(items(r, 'hours').includes('service_charge') && items(r, 'hours').includes('tip_entry'));
});

test('trades: job costing, crews and workers\' comp classes', () => {
  const r = build('construction_trades', { jobs: { on: true }, crews: { on: true }, wc: { on: true } }, D);
  assert.deepEqual(ids(r).slice(-3), ['job_costing', 'crews', 'workers_comp']);
});

test('things Totali does not do yet are never counted, and are listed as coming soon', () => {
  const r = build('delivery_couriers', { trips: { on: true }, mileage: { on: true } }, D);
  assert.ok(!ids(r).includes('trips') && !ids(r).includes('mileage'), 'a card with nothing ready in it is not shown');
  const soon = r.leftOut.filter((l) => l.soon).map((l) => l.id);
  for (const id of ['trip_log', 'trip_pay', 'mileage_log', 'mileage_report']) assert.ok(soon.includes(id), id);
  assert.ok(r.modules.every((m) => m.items.every((i) => !['trip_log', 'trip_pay', 'mileage_log', 'mileage_report'].includes(i.id))));
  const office = build('office_studios', { timeoff: { on: true } }, D);
  assert.ok(office.leftOut.some((l) => l.id === 'pto_policy' && l.soon));
});

// ---------------------------------------------------------------- answers are checked

test('each answer is validated with a message the form can show', () => {
  const bad = (q: string, v: unknown, re: RegExp, ind: IndustryId = 'restaurant') => { const r = checkAnswer(ind, q, v, D); assert.equal(r.ok, false, q); assert.match((r as { error: string }).error, re); };
  bad('state', 'Michigan', /Choose a state/);
  bad('state', 'ZZ', /can't run payroll/);
  bad('locations', [], /at least one/);
  bad('locations', [{ name: 'A', city: 'A', state: 'MI' }, { name: 'a', city: 'B', state: 'MI' }], /twice/);
  bad('locations', [{ name: 'A<b>', city: 'A', state: 'MI' }], /name and a state/);
  bad('locations', Array.from({ length: 26 }, (_, i) => ({ name: `L${i}`, city: 'x', state: 'MI' })), /up to 25/);
  bad('team', '12', /team size/);
  bad('tips', 'yes', /yes or no/);
  bad('frequency', { value: 'daily' }, /how often/);
  bad('frequency', { value: 'weekly' }, /day you pay/);
  bad('frequency', { value: 'weekly', weekday: 'saturday' }, /weekend/);
  bad('contractors', { on: true, count: -1 }, /whole number/);
  bad('nope', true, /not a question/);
  bad('jobs', { on: 'yes' }, /yes or no/, 'construction_trades');
  assert.deepEqual((checkAnswer('restaurant', 'state', 'mi', D) as { value: unknown }).value, 'MI');
  assert.deepEqual((checkAnswer('restaurant', 'tips', { on: false, pool: 'hours' }, D) as { value: unknown }).value, { on: false, pool: 'none' }, 'no tips means no pool');
});

test('a saved set of answers is cleaned: bad parts are dropped and reported, not trusted', () => {
  const { answers, errors } = normalizeAnswers('restaurant', { state: 'MI', team: 'huge', tips: { on: true, pool: 'hours' }, bogus: 1, __proto__: { x: 1 } }, D);
  assert.deepEqual(answers, { state: 'MI', tips: { on: true, pool: 'hours' } });
  assert.deepEqual(Object.keys(errors), ['team']);
  assert.deepEqual(normalizeAnswers('restaurant', 'junk', D), { answers: {}, errors: {} });
});
