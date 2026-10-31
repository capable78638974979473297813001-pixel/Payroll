import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/store.ts';
import { DashboardService } from '../src/dashboard/service.ts';
import { availabilityFor, defaultConfig } from '../src/dashboard/defaults.ts';
import { validateConfig, widgetAvailable, type DashboardConfig, type DashboardTab } from '../src/dashboard/schema.ts';
import { dashboardData } from '../src/dashboard/data.ts';
import { createCompanyFromSetup } from '../src/builder/finish.ts';
import type { Answers, IndustryId } from '../src/builder/catalog.ts';
import type { User } from '../src/accounts/types.ts';
import { ApiError } from '../src/lib/errors.ts';
import { day, hire, newCompany, shiftsFor } from './helpers.ts';

const D = '2026-10-30';
const NOW = new Date(`${D}T15:00:00Z`);
const LOCS = [{ name: 'Detroit', city: 'Detroit', state: 'MI' }, { name: 'Ferndale', city: 'Ferndale', state: 'MI' }];
const FULL: Answers = { state: 'MI', locations: LOCS, team: '11-25', tips: { on: true, pool: 'hours' }, frequency: { value: 'weekly', weekday: 'friday' }, contractors: { on: true, count: 2 } };

function business(industry: IndustryId, answers: Answers, name = 'Harbor Street Kitchen') {
  const store = new Store();
  const user = { id: 'usr_1', businessName: name } as User;
  const company = createCompanyFromSetup(store, user, industry, answers, D, NOW);
  const svc = new DashboardService(store, () => NOW);
  return { store, company, svc, a: availabilityFor(company, D) };
}

const types = (c: DashboardConfig, tab = 'overview') => c.tabs.find((t) => t.id === tab)!.widgets.map((w) => w.type);
const clone = <T,>(o: T): T => JSON.parse(JSON.stringify(o));
const refused = (fn: () => unknown, re: RegExp) => assert.throws(fn, (e: unknown) => e instanceof ApiError && re.test(e.message), String(re));

// ---------------------------------------------------------------- the starting dashboard follows the business

test('the design\'s restaurant gets cards for what it said: tips, a tip pool, Michigan, locations, contractors', () => {
  const { svc } = business('restaurant', FULL);
  const c = svc.get(svc['store'].companies.all()[0]!.id).config;
  assert.deepEqual(c.tabs.map((t) => t.label), ['Overview', 'Payroll', 'People', 'Time and tips', 'Onboarding', 'Taxes', 'Reports', 'Help', 'Settings']);
  const o = types(c);
  assert.deepEqual(o.slice(0, 4), ['next_payroll_hero', 'todo_list', 'cost_trend', 'tax_due']);
  // The overview is the sections the setup built, eight of them for the design's restaurant, the pay run wide.
  const mods = c.tabs.find((t) => t.id === 'overview')!.widgets.filter((w) => w.type === 'module');
  assert.deepEqual(mods.map((w) => w.settings.module), ['pay_run', 'team', 'hours_tips', 'federal_taxes', 'new_hire_forms', 'state_mi', 'locations', 'contractors']);
  assert.deepEqual(mods.map((w) => w.span), [8, 4, 4, 4, 4, 4, 4, 4]);
  for (const t of ['pos_status', 'tips_panel']) assert.ok(types(c, 'time').includes(t), t);
  for (const t of ['locations_card', 'contractors_card']) assert.ok(types(c, 'people').includes(t), t);
});

test('a business with no tips and one location gets none of those cards', () => {
  const { svc, company } = business('restaurant', { ...FULL, locations: [LOCS[1]!], tips: { on: false, pool: 'none' }, contractors: { on: false } });
  const c = svc.get(company.id).config;
  const all = c.tabs.flatMap((t) => t.widgets.map((w) => w.type));
  for (const t of ['tips_panel', 'locations_card', 'contractors_card']) assert.ok(!all.includes(t), t);
  const mods = c.tabs.find((t) => t.id === 'overview')!.widgets.filter((w) => w.type === 'module').map((w) => w.settings.module);
  for (const m of ['locations', 'contractors']) assert.ok(!mods.includes(m as string), m);
  assert.equal(c.tabs.find((t) => t.id === 'time')!.label, 'Time and tips');
});

test('other industries get their own parts: trades with job costing get cost by job, offices a plain Time tab', () => {
  const trades = business('construction_trades', { state: 'TX', locations: [{ name: 'Yard', city: 'Austin', state: 'TX' }], team: '1-10', frequency: { value: 'weekly', weekday: 'friday' }, jobs: { on: true } });
  const tw = trades.svc.get(trades.company.id).config.tabs.find((t) => t.id === 'time')!.widgets.find((w) => w.type === 'group_cost')!;
  assert.equal(tw.settings.groupBy, 'job');
  const office = business('office_studios', { state: 'NY', locations: [{ name: 'Studio', city: 'Albany', state: 'NY' }], team: '1-10', frequency: { value: 'semimonthly' } });
  assert.equal(office.svc.get(office.company.id).config.tabs.find((t) => t.id === 'time')!.label, 'Time');
});

test('two different businesses do not start with the same dashboard', () => {
  const a = business('restaurant', FULL).svc;
  const b = business('hotel_lodging', { state: 'OH', locations: [{ name: 'Inn', city: 'Columbus', state: 'OH' }], team: '26-50', frequency: { value: 'biweekly', weekday: 'thursday' }, departments: { on: true, names: [] }, seasonal: { on: true }, service: { on: true } });
  const ca = a.get(a['store'].companies.all()[0]!.id).config;
  const cb = b.svc.get(b.company.id).config;
  const sig = (c: DashboardConfig) => c.tabs.find((t) => t.id === 'overview')!.widgets.map((w) => `${w.type}:${w.settings.module ?? ''}`);
  assert.notDeepEqual(sig(ca), sig(cb));
});

test('every starting dashboard is valid and every card in it is available to the business', () => {
  for (const [ind, ans] of [['restaurant', FULL], ['hotel_lodging', { state: 'OH', locations: [{ name: 'Inn', city: 'Columbus', state: 'OH' }], team: '1-10', frequency: { value: 'monthly' } }], ['delivery_couriers', { state: 'TX', team: '1-10', frequency: { value: 'weekly', weekday: 'friday' }, contractors: { on: true } }]] as Array<[IndustryId, Answers]>) {
    const { company, a } = business(ind, ans);
    const cfg = defaultConfig(company, a);
    validateConfig(cfg, a);
    for (const t of cfg.tabs) for (const w of t.widgets) assert.ok(widgetAvailable(w.type, a), `${ind}: ${w.type}`);
  }
});

// ---------------------------------------------------------------- validation: nothing odd gets saved

test('a dashboard with anything outside the rules is refused with a message', () => {
  const { svc, company, a } = business('restaurant', { ...FULL, tips: { on: false, pool: 'none' } });
  const base = svc.get(company.id).config;
  const bad = (mut: (c: DashboardConfig) => void, re: RegExp) => { const c = clone(base); mut(c); refused(() => validateConfig(c, a), re); };
  const first = (c: DashboardConfig) => c.tabs[0]!.widgets[0]!;
  bad((c) => { first(c).type = 'bitcoin_miner'; }, /not a card Totali has/);
  bad((c) => { first(c).span = 5; }, /columns wide/);
  bad((c) => { c.tabs[0]!.widgets.push({ id: 'w_tips1', type: 'tips_week', span: 6, settings: {} }); }, /needs tips/);
  bad((c) => { (first(c).settings as Record<string, unknown>).evil = 1; }, /no setting called evil/);
  bad((c) => { c.theme.accent = 'red'; }, /color like/);
  bad((c) => { c.theme.accent = '#12345'; }, /color like/);
  bad((c) => { c.theme.radius = 7; }, /radius must be one of/);
  bad((c) => { c.theme.font = 'comic'; }, /theme.font must be one of/);
  bad((c) => { c.tabs[0]!.label = '<b>Hi</b>'; }, /characters we can't accept/);
  bad((c) => { c.tabs[0]!.label = 'x'.repeat(25); }, /longer than 24/);
  bad((c) => { c.brand.name = ''; }, /cannot be empty/);
  bad((c) => { (c.terms as Record<string, string>).password = 'x'; }, /not a word you can rename/);
  bad((c) => { c.terms.team = 'a<script>'; }, /characters we can't accept/);
  bad((c) => { c.tabs = c.tabs.filter((t) => t.kind !== 'settings'); }, /exactly one Settings tab/);
  bad((c) => { c.tabs.push({ id: 'again', label: 'More', kind: 'settings', widgets: [] }); }, /keep their own names/);
  bad((c) => { c.tabs.push({ id: 'settings', label: 'More', kind: 'settings', widgets: [] }); }, /share the id/);
  bad((c) => { c.tabs[1]!.id = c.tabs[0]!.id; }, /share the id/);
  bad((c) => { c.tabs[1]!.id = 'contractors'; }, /name Totali uses/);
  bad((c) => { c.tabs[1]!.id = 'settings'; }, /keep their own names|share the id|name Totali/);
  bad((c) => { c.tabs.find((t) => t.kind === 'settings')!.id = 'prefs'; }, /keep their own names/);
  bad((c) => { c.tabs[1]!.widgets[0]!.id = c.tabs[0]!.widgets[0]!.id; }, /share the id/);
  bad((c) => { c.tabs.find((t) => t.kind === 'settings')!.widgets = [{ id: 'w_abcd', type: 'welcome', span: 12, settings: {} }]; }, /does not hold cards/);
  bad((c) => { c.tabs = c.tabs.filter((t) => t.kind !== 'page'); }, /at least one page/);
  bad((c) => { c.tabs = (Array.from({ length: 13 }, (_, i) => ({ id: `t${i}`, label: `T${i}`, kind: 'page' as const, widgets: [] })) as DashboardTab[]).concat(c.tabs.filter((t) => t.kind === 'settings')); }, /1 to 12 tabs/);
  bad((c) => { c.tabs[0]!.widgets = Array.from({ length: 41 }, (_, i) => ({ id: `w_n${i}aaaa`, type: 'note', span: 4, settings: {} })); }, /up to 40 cards/);
  bad((c) => { (c as unknown as Record<string, unknown>).extra = 1; }, /Unknown dashboard field/);
  bad((c) => { c.tabs[0]!.widgets.push({ id: 'w_state1', type: 'state_card', span: 6, settings: { state: 'CA' } }); }, /not one of your states/);
  bad((c) => { first(c).settings = 'x' as never; }, /must be an object/);
  refused(() => validateConfig('nope', a), /must be an object/);
  refused(() => validateConfig({ ...base, version: 2 }, a), /Unsupported/);
});

test('settings are checked by type and range, and defaults fill the gaps', () => {
  const { svc, company, a } = business('restaurant', FULL);
  const c = clone(svc.get(company.id).config);
  c.tabs[0]!.widgets.push({ id: 'w_hist1', type: 'payroll_history', span: 6, settings: { count: 0 } });
  refused(() => validateConfig(c, a), /whole number from 1 to 10/);
  c.tabs[0]!.widgets.pop();
  c.tabs[0]!.widgets.push({ id: 'w_hist2', type: 'payroll_history', span: 6, settings: {} });
  assert.equal(validateConfig(c, a).tabs[0]!.widgets.at(-1)!.settings.count, 4);
  c.tabs[0]!.widgets.pop();
  c.tabs[0]!.widgets.push({ id: 'w_qact1', type: 'quick_actions', span: 4, settings: { actions: ['run_payroll', 'run_payroll', 'invite_hire'] } });
  assert.deepEqual(validateConfig(c, a).tabs[0]!.widgets.at(-1)!.settings.actions, ['run_payroll', 'invite_hire'], 'duplicates are dropped');
  c.tabs[0]!.widgets.pop();
  c.tabs[0]!.widgets.push({ id: 'w_qact2', type: 'quick_actions', span: 4, settings: { actions: ['launch_missiles'] } });
  refused(() => validateConfig(c, a), /must be one of/);
});

test('a note may say anything, since it is only ever shown as text; names may not carry markup', () => {
  const { svc, company, a } = business('restaurant', FULL);
  const c = clone(svc.get(company.id).config);
  c.tabs[0]!.widgets.push({ id: 'w_note01', type: 'note', span: 4, settings: { title: 'Specials', text: 'Under 5 < 6 tables: <b>ask</b>\nsecond line' } });
  const out = validateConfig(c, a);
  assert.equal(out.tabs[0]!.widgets.at(-1)!.settings.text, 'Under 5 < 6 tables: <b>ask</b>\nsecond line');
  c.tabs[0]!.widgets.at(-1)!.settings = { title: 'Spe<b>cials', text: 'x' };
  refused(() => validateConfig(c, a), /characters we can't accept/);
  c.tabs[0]!.widgets.at(-1)!.settings = { title: 'ok', text: 'bell \u0007' };
  refused(() => validateConfig(c, a), /characters we can't accept/);
});

test('terms are kept only when they differ from the default, and colors are lower-cased', () => {
  const { svc, company, a } = business('restaurant', FULL);
  const c = clone(svc.get(company.id).config);
  c.terms = { team: 'Crew', tips: 'Tips', payroll: '' };
  c.theme.accent = '#C2410C';
  const out = validateConfig(c, a);
  assert.deepEqual(out.terms, { team: 'Crew' });
  assert.equal(out.theme.accent, '#c2410c');
});

// ---------------------------------------------------------------- saving, history, undo

test('saving needs the revision you started from, so two editors cannot overwrite each other', () => {
  const { svc, company } = business('restaurant', FULL);
  const d = svc.describe(company.id);
  const next = clone(d.config);
  next.theme.accent = '#c2410c';
  const saved = svc.save(company.id, next, d.rev);
  assert.equal(saved.rev, d.rev + 1);
  assert.equal(saved.config.theme.accent, '#c2410c');
  assert.throws(() => svc.save(company.id, next, d.rev), (e: unknown) => (e as ApiError).code === 'dashboard_changed');
  assert.throws(() => svc.save(company.id, next, 'x'), (e: unknown) => (e as ApiError).code === 'dashboard_changed');
});

test('each save is kept, so a change can be undone, and only the last twenty are kept', () => {
  const { svc, company } = business('restaurant', FULL);
  let d = svc.describe(company.id);
  const original = d.config.theme.accent;
  for (let i = 0; i < 25; i++) {
    const c = clone(d.config);
    c.theme.accent = `#${(0x100000 + i * 0x111).toString(16)}`;
    d = svc.save(company.id, c, d.rev);
  }
  assert.equal(d.revisions.length, 20);
  const target = d.revisions[3]!;
  const back = svc.revert(company.id, target.rev);
  assert.equal(back.rev, d.rev + 1);
  assert.notEqual(back.config.theme.accent, d.config.theme.accent);
  assert.throws(() => svc.revert(company.id, 99999), (e: unknown) => (e as ApiError).status === 404);
  assert.ok(original);
});

test('reset returns to the starting dashboard and keeps what was there', () => {
  const { svc, company } = business('restaurant', FULL);
  const d = svc.describe(company.id);
  const c = clone(d.config);
  c.tabs = c.tabs.filter((t) => t.id !== 'people');
  c.brand.name = 'The Wrong Name';
  const edited = svc.save(company.id, c, d.rev);
  const reset = svc.reset(company.id);
  assert.equal(reset.config.brand.name, 'Harbor Street Kitchen');
  assert.ok(reset.config.tabs.some((t) => t.id === 'people'));
  assert.ok(reset.revisions.some((r) => r.rev === edited.rev));
});

test('reverting drops cards the business can no longer have instead of failing', () => {
  const { svc, company, store } = business('restaurant', FULL);
  const d = svc.describe(company.id);
  const c = clone(d.config);
  c.tabs[0]!.widgets.push({ id: 'w_extra1', type: 'tips_week', span: 6, settings: {} });
  const saved = svc.save(company.id, c, d.rev);
  // The business stops tracking tips.
  store.tx(() => store.companies.put({ ...store.companies.get(company.id)!, setup: { ...store.companies.get(company.id)!.setup!, answers: { ...FULL, tips: { on: false, pool: 'none' } } } }));
  const next = svc.save(company.id, { ...saved.config, tabs: saved.config.tabs.map((t) => ({ ...t, widgets: t.widgets.filter((w) => w.type !== 'tips_week' && w.type !== 'tip_pool_card' && w.type !== 'tips_panel') })) }, saved.rev);
  const back = svc.revert(company.id, saved.revisions[0]!.rev);
  assert.ok(!back.config.tabs.flatMap((t) => t.widgets).some((w) => w.type === 'tips_week'));
  assert.ok(next.rev < back.rev);
});

test('the editor is told what could be added and why a card is not offered', () => {
  const { svc, company } = business('restaurant', { ...FULL, tips: { on: false, pool: 'none' }, contractors: { on: false } });
  const d = svc.describe(company.id);
  const tips = d.catalog.find((w) => w.type === 'tips_week')!;
  assert.equal(tips.available, false);
  assert.match(tips.reason!, /Needs tips/);
  assert.equal(d.catalog.find((w) => w.type === 'next_payroll')!.available, true);
  assert.deepEqual(d.states, ['MI']);
  assert.ok(d.options.fonts.length >= 8 && d.options.radii.includes(0));
});

// ---------------------------------------------------------------- the data behind the cards

test('a brand new business shows empty states, not errors or invented numbers', () => {
  const { company, store } = business('restaurant', FULL);
  const d = dashboardData(store, company, D);
  assert.deepEqual([d.team.active, d.hours.totalMinutes, d.tips.chargedCents, d.onboarding.total, d.runs.length, d.latest], [0, 0, 0, 0, 0, null]);
  assert.equal(d.hours.byDay.length, 7);
  assert.deepEqual(d.setup.map((s) => [s.id, s.done]), [['ein', false], ['bank', false], ['team', false], ['run', false]]);
  assert.equal(d.company.hasEin, false);
  assert.ok(d.stateCards.some((s) => s.code === 'MI' && s.items.length >= 5));
  assert.ok(d.checklist.length > 0);
});

test('the numbers on the cards come from the records: people, this week\'s hours, overtime, tips, and the latest run', () => {
  const store = new Store();
  const { company } = newCompany(store);
  const ana = hire(store, company.id, { firstName: 'Ana', lastName: 'Ruiz', payType: { kind: 'hourly', rateCents: 1500 }, roleKey: 'line_cook', tipCreditNoticeDate: undefined });
  const ben = hire(store, company.id, { firstName: 'Ben', lastName: 'Okafor', payType: { kind: 'hourly', rateCents: 1800 }, roleKey: 'line_cook', tipCreditNoticeDate: undefined });
  // This week is Mon 2026-10-26 to Sun 11-01. Ana works 45 hours, Ben 20.
  const mon = '2026-10-26';
  const dates = [0, 1, 2, 3, 4].map((i) => new Date(Date.parse(mon) + i * 86_400_000).toISOString().slice(0, 10));
  store.tx(() => {
    for (const [i, date] of dates.entries()) store.shifts.put({ id: `s_a${i}`, companyId: company.id, employeeId: ana.id, workDate: date, roleKey: 'line_cook', minutes: 540, chargedTipsCents: 1000, cashTipsCents: 500, salesCents: 0, mealBreakViolation: false, restBreakViolation: false, createdAt: NOW.toISOString() });
    for (const [i, date] of dates.slice(0, 2).entries()) store.shifts.put({ id: `s_b${i}`, companyId: company.id, employeeId: ben.id, workDate: date, roleKey: 'line_cook', minutes: 600, chargedTipsCents: 0, cashTipsCents: 0, salesCents: 0, mealBreakViolation: false, restBreakViolation: false, createdAt: NOW.toISOString() });
  });
  const d = dashboardData(store, store.companies.get(company.id)!, D);
  assert.equal(d.team.active, 2);
  assert.deepEqual(d.team.byRole, [{ label: 'Line cook', count: 2 }]);
  assert.equal(d.hours.weekStart, mon);
  assert.deepEqual([d.hours.totalMinutes, d.hours.regularMinutes, d.hours.overtimeMinutes], [2700 + 1200, 2400 + 1200, 300], 'Ana is 5 hours over 40; Ben is under');
  assert.deepEqual(d.hours.people.map((p) => [p.name, p.minutes]), [['Ana Ruiz', 2700], ['Ben Okafor', 1200]]);
  assert.deepEqual([d.tips.chargedCents, d.tips.cashCents], [5000, 2500]);
  assert.equal(d.hours.byDay[0]!.minutes, 540 + 600);
});
