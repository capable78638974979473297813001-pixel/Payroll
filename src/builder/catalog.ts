import { badRequest } from '../lib/errors.ts';
import { localTax, slug, stateFacts } from './facts.ts';

/**
 * The builder's engine: answers in, the parts of a business's Totali out.
 *
 * A *module* is a card on the dashboard (Pay run, Michigan, Contractors). An *item* is a thing inside it. A *form* is
 * an item a new hire fills in. Every answer adds or removes modules and items, and the same function that builds the
 * live preview builds the company, so what the preview shows is what the business gets.
 *
 * Items that Totali does not do yet (`live: false`) are never counted: they are listed under "left out" as coming soon.
 */

export type IndustryId = 'restaurant' | 'hotel_lodging' | 'construction_trades' | 'office_studios' | 'delivery_couriers';
export const INDUSTRY_IDS: readonly IndustryId[] = ['restaurant', 'hotel_lodging', 'construction_trades', 'office_studios', 'delivery_couriers'];

export interface IndustryCard {
  id: IndustryId;
  label: string;
  tags: string[];
  pickLabel: string;
}

export const INDUSTRY_CARDS: IndustryCard[] = [
  { id: 'restaurant', label: 'Restaurants and bars', pickLabel: 'Restaurants', tags: ['Tips', 'Shift hours', 'Tip pool'] },
  { id: 'hotel_lodging', label: 'Hotels and venues', pickLabel: 'Hotels and venues', tags: ['Departments', 'Seasonal staff', 'Service charge'] },
  { id: 'construction_trades', label: 'Trades and construction', pickLabel: 'Trades', tags: ['Job costing', 'Crews', 'Workers’ comp classes'] },
  { id: 'office_studios', label: 'Office and studios', pickLabel: 'Office and studios', tags: ['Salaried and hourly', 'Time off', 'Multi-state'] },
  { id: 'delivery_couriers', label: 'Delivery and couriers', pickLabel: 'Delivery', tags: ['Trips', 'Mileage', 'Contractor drivers'] },
];

export type QuestionKind = 'state' | 'locations' | 'team' | 'tips' | 'frequency' | 'contractors' | 'yesno' | 'departments' | 'paytypes';

export interface Question {
  id: string;
  rail: string;
  title: string;
  help: string;
  kind: QuestionKind;
  /** yesno questions: what the two buttons say. */
  yes?: string;
  no?: string;
  /** The module this question is mostly about, shown in the help line of the preview. */
  adds?: string;
  /** Not needed to build the dashboard: if it is skipped the answer is no. */
  optional?: boolean;
  /** Only asked when this earlier yes-or-no answer was yes. */
  when?: { question: string };
}

const Q = {
  state: { id: 'state', rail: 'State', title: 'Which state is your business in?', help: 'This decides your state taxes, new-hire forms and rules.', kind: 'state' as const },
  locations: { id: 'locations', rail: 'Locations', title: 'Where do you operate?', help: 'Add each location. A city with its own income tax adds that tax to your setup.', kind: 'locations' as const },
  team: { id: 'team', rail: 'Team size', title: 'How many people do you pay?', help: 'Employees only. Contractors come later.', kind: 'team' as const },
  frequency: { id: 'frequency', rail: 'Pay frequency', title: 'How often do you pay your team?', help: 'This fills in your pay schedule and your next pay date.', kind: 'frequency' as const },
  contractors: { id: 'contractors', rail: 'Contractors', title: 'Do you pay independent contractors?', help: 'They get their own card, kept apart from payroll: 1099 tracking and W-9 collection.', kind: 'contractors' as const },
  bonuses: { id: 'bonuses', rail: 'Bonuses', title: 'Do you pay bonuses, commissions or reimbursements?', help: 'Yes lets you add them to anyone while you run payroll. Reimbursements aren’t taxed.', kind: 'yesno' as const, yes: 'Yes', no: 'No', optional: true },
  deductions: { id: 'deductions', rail: 'Deductions', title: 'Do you take anything out of pay besides taxes?', help: 'Health insurance, a 401(k), a garnishment. Yes adds deductions you set up for each person.', kind: 'yesno' as const, yes: 'Yes, for some people', no: 'No', optional: true },
  prior: { id: 'prior', rail: 'Earlier this year', title: 'Did you pay your team earlier this year with another payroll service?', help: 'Yes lets you bring in what each person has been paid so far, so Social Security and unemployment limits come out right.', kind: 'yesno' as const, yes: 'Yes, bring it in', no: 'No, this is our first', optional: true },
} satisfies Record<string, Question>;

export const QUESTIONS: Record<IndustryId, Question[]> = {
  restaurant: [
    Q.state, Q.locations, Q.team,
    { id: 'tips', rail: 'Tipped staff', title: 'Do any of your staff earn tips?', help: 'Yes adds tip reporting, a tip pool and the tip rules for your state. No keeps all of that out of your way.', kind: 'tips' },
    { id: 'tipcredit', rail: 'Tip credit', title: 'Do you pay tipped staff a lower cash wage?', help: 'Yes means tips count toward the minimum wage, which needs a written notice to each person first. No pays everyone the full minimum wage.', kind: 'yesno', yes: 'Yes, a tip credit', no: 'No, the full minimum wage', optional: true, when: { question: 'tips' } },
    Q.frequency, Q.contractors, Q.bonuses, Q.deductions, Q.prior,
  ],
  hotel_lodging: [
    Q.state, Q.locations, Q.team,
    { id: 'departments', rail: 'Departments', title: 'Do you organize your team into departments?', help: 'Front desk, housekeeping, banquets. Yes lets you tag each person and see labor cost by department.', kind: 'departments' },
    { id: 'seasonal', rail: 'Seasonal staff', title: 'Do you hire seasonal staff?', help: 'Yes tracks season start and end dates and tells you who is about to finish.', kind: 'yesno', yes: 'Yes, seasonal hiring', no: 'No' },
    { id: 'service', rail: 'Service charge', title: 'Do guests tip, or do you add service charges?', help: 'Yes adds tip entry and service charge distribution. A mandatory service charge paid to staff is wages.', kind: 'yesno', yes: 'Yes', no: 'No' },
    Q.frequency, Q.contractors, Q.bonuses, Q.deductions, Q.prior,
  ],
  construction_trades: [
    Q.state, Q.locations, Q.team,
    { id: 'jobs', rail: 'Job costing', title: 'Do you track labor cost by job?', help: 'Yes adds a job code to every hour and a cost-by-job report.', kind: 'yesno', yes: 'Yes, by job', no: 'No' },
    { id: 'crews', rail: 'Crews', title: 'Do you run crews?', help: 'Yes lets you tag people to crews and see hours by crew.', kind: 'yesno', yes: 'Yes, crews', no: 'No' },
    { id: 'wc', rail: 'Workers’ comp classes', title: 'Do you need payroll by workers’ comp class?', help: 'Yes adds a class code to each person and a payroll-by-class report for your insurer. Your insurer assigns the classes.', kind: 'yesno', yes: 'Yes', no: 'No' },
    Q.frequency, Q.contractors, Q.bonuses, Q.deductions, Q.prior,
  ],
  office_studios: [
    Q.state, Q.locations, Q.team,
    { id: 'paytypes', rail: 'Salaried and hourly', title: 'How do you pay people?', help: 'Salaried people are checked against the overtime exemption salary level. Hourly people get overtime.', kind: 'paytypes' },
    { id: 'timeoff', rail: 'Time off', title: 'Do you track time off?', help: 'Yes adds a time-off policy and balances per person.', kind: 'yesno', yes: 'Yes', no: 'No' },
    { id: 'multistate', rail: 'Multi-state', title: 'Does anyone work in a different state?', help: 'Yes lets you set a work state per person, and each is taxed by their own state.', kind: 'yesno', yes: 'Yes, more than one state', no: 'No, one state' },
    Q.frequency, Q.contractors, Q.bonuses, Q.deductions, Q.prior,
  ],
  delivery_couriers: [
    Q.state, Q.team,
    { id: 'trips', rail: 'Trips', title: 'Do you pay by the trip?', help: 'Yes adds a trip log and pay per trip.', kind: 'yesno', yes: 'Yes, by trip', no: 'No' },
    { id: 'mileage', rail: 'Mileage', title: 'Do you track mileage?', help: 'Yes adds a mileage log and report.', kind: 'yesno', yes: 'Yes', no: 'No' },
    { id: 'contractors', rail: 'Contractor drivers', title: 'Do you use contractor drivers?', help: 'They get their own card, kept apart from payroll: 1099 tracking and W-9 collection.', kind: 'contractors' },
    Q.frequency, Q.bonuses, Q.deductions, Q.prior,
  ],
};

export const TEAM_SIZES = [
  { value: '1-10', label: '1 to 10 people', typical: 8 },
  { value: '11-25', label: '11 to 25 people', typical: 18 },
  { value: '26-50', label: '26 to 50 people', typical: 38 },
  { value: '51+', label: '51 or more', typical: 70 },
] as const;

export const FREQUENCIES = ['weekly', 'biweekly', 'semimonthly', 'monthly'] as const;
export const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
export type Frequency = (typeof FREQUENCIES)[number];

export interface Location {
  name: string;
  city: string;
  state: string;
}

export interface Answers {
  state?: string;
  locations?: Location[];
  team?: string;
  tips?: { on: boolean; pool: 'none' | 'hours' | 'points' };
  frequency?: { value: Frequency; weekday?: (typeof WEEKDAYS)[number] };
  contractors?: { on: boolean; count?: number };
  departments?: { on: boolean; names: string[] };
  paytypes?: 'both' | 'hourly' | 'salaried';
  seasonal?: { on: boolean };
  service?: { on: boolean };
  jobs?: { on: boolean };
  crews?: { on: boolean };
  wc?: { on: boolean };
  timeoff?: { on: boolean };
  multistate?: { on: boolean };
  trips?: { on: boolean };
  mileage?: { on: boolean };
  tipcredit?: { on: boolean };
  bonuses?: { on: boolean };
  deductions?: { on: boolean };
  prior?: { on: boolean };
}

// ---------------------------------------------------------------- validating answers

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() !== '' && v.trim().length <= max && !/[\u0000-\u001f<>]/.test(v) ? v.trim().replace(/\s+/g, ' ') : null);

/** Check one answer. Returns the cleaned value, or the message the form shows. */
export function checkAnswer(industry: IndustryId, id: string, value: unknown, date: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const q = QUESTIONS[industry].find((x) => x.id === id);
  if (!q) return { ok: false, error: `'${id}' is not a question for this industry.` };
  const fail = (error: string) => ({ ok: false as const, error });
  switch (q.kind) {
    case 'state': {
      if (typeof value !== 'string' || !/^[A-Za-z]{2}$/.test(value)) return fail('Choose a state.');
      const f = stateFacts(value, date);
      if (!f.supported) return fail(`Totali can't run payroll in ${value.toUpperCase()} yet: the tax engine has no ${date.slice(0, 4)} rules for it.`);
      return { ok: true, value: f.code };
    }
    case 'locations': {
      if (!Array.isArray(value) || value.length < 1 || value.length > 25) return fail('Add at least one location, up to 25.');
      const out: Location[] = [];
      for (const l of value) {
        if (!isObj(l)) return fail('A location is missing its details.');
        const name = text(l.name, 80);
        const city = text(l.city ?? l.name, 80);
        const state = typeof l.state === 'string' && /^[A-Za-z]{2}$/.test(l.state) ? l.state.toUpperCase() : null;
        if (!name || !city || !state) return fail('Each location needs a name and a state.');
        if (!stateFacts(state, date).supported) return fail(`Totali can't run payroll in ${state} yet.`);
        if (out.some((x) => x.name.toLowerCase() === name.toLowerCase())) return fail(`You listed ${name} twice.`);
        out.push({ name, city, state });
      }
      return { ok: true, value: out };
    }
    case 'team':
      return typeof value === 'string' && TEAM_SIZES.some((t) => t.value === value) ? { ok: true, value } : fail('Choose a team size.');
    case 'tips': {
      if (!isObj(value) || typeof value.on !== 'boolean') return fail('Choose yes or no.');
      const pool = value.pool === 'hours' || value.pool === 'points' ? value.pool : 'none';
      return { ok: true, value: { on: value.on, pool: value.on ? pool : 'none' } };
    }
    case 'frequency': {
      if (!isObj(value) || !FREQUENCIES.includes(value.value as Frequency)) return fail('Choose how often you pay.');
      const f = value.value as Frequency;
      if (f === 'weekly' || f === 'biweekly') {
        const wd = value.weekday;
        if (!WEEKDAYS.includes(wd as never)) return fail('Choose the day you pay.');
        if (wd === 'saturday' || wd === 'sunday') return fail('Banks are closed on weekends. Choose a weekday.');
        return { ok: true, value: { value: f, weekday: wd } };
      }
      return { ok: true, value: { value: f } };
    }
    case 'contractors': {
      if (!isObj(value) || typeof value.on !== 'boolean') return fail('Choose yes or no.');
      const count = value.count === undefined ? undefined : Number(value.count);
      if (count !== undefined && (!Number.isInteger(count) || count < 0 || count > 5000)) return fail('Enter how many contractors, as a whole number.');
      return { ok: true, value: { on: value.on, ...(value.on && count !== undefined ? { count } : {}) } };
    }
    case 'departments': {
      if (!isObj(value) || typeof value.on !== 'boolean') return fail('Choose yes or no.');
      const names = Array.isArray(value.names) ? value.names.map((n) => text(n, 40)).filter((n): n is string => !!n).slice(0, 30) : [];
      return { ok: true, value: { on: value.on, names: value.on ? names : [] } };
    }
    case 'paytypes':
      return value === 'both' || value === 'hourly' || value === 'salaried' ? { ok: true, value } : fail('Choose how you pay people.');
    case 'yesno':
      return isObj(value) && typeof value.on === 'boolean' ? { ok: true, value: { on: value.on } } : fail('Choose yes or no.');
  }
}

/** Clean a whole saved set of answers. Anything invalid is dropped and reported, so a stale draft cannot break the builder. */
export function normalizeAnswers(industry: IndustryId, raw: unknown, date: string): { answers: Answers; errors: Record<string, string> } {
  const answers: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  if (isObj(raw)) {
    for (const q of QUESTIONS[industry]) {
      if (!(q.id in raw)) continue;
      const r = checkAnswer(industry, q.id, raw[q.id], date);
      if (r.ok) answers[q.id] = r.value;
      else errors[q.id] = r.error;
    }
  }
  return { answers: answers as Answers, errors };
}

// ---------------------------------------------------------------- the plan

/**
 * How an item sits in the business: auto (Totali does it), manual (you enter it each time), open (an action you take),
 * setup (needs a choice from you), todo (needs something from you before it works), reference (a rule shown for
 * your information, which Totali does not enforce), added (you chose it), ready (waiting for you to use it).
 */
export type ItemStatus = 'auto' | 'manual' | 'open' | 'setup' | 'todo' | 'reference' | 'added' | 'ready' | 'toset';

export interface BuiltItem {
  id: string;
  label: string;
  form: boolean;
  /** The one line under the name. */
  note: string;
  status: ItemStatus;
  /** Text for the chip when it is not the status's own word (Weekly, for a pay schedule that has been set). */
  chip?: string;
  detail?: string;
  /** The question that put it here. */
  source: string;
}
export interface BuiltModule {
  id: string;
  label: string;
  blurb: string;
  source: string;
  items: BuiltItem[];
}
export interface LeftOut {
  id: string;
  label: string;
  why: string;
  soon: boolean;
}
export interface Counts {
  modules: number;
  items: number;
  forms: number;
}

class Plan {
  readonly mods = new Map<string, BuiltModule>();
  readonly soon: LeftOut[] = [];
  module(id: string, label: string, blurb: string, source: string): BuiltModule {
    let m = this.mods.get(id);
    if (!m) {
      m = { id, label, blurb, source, items: [] };
      this.mods.set(id, m);
    }
    return m;
  }
  item(modId: string, it: { id: string; label: string; note?: string; status?: ItemStatus; chip?: string; form?: boolean; detail?: string; live?: boolean }, source: string): void {
    const m = this.mods.get(modId);
    if (!m) return;
    if (it.live === false) {
      this.soon.push({ id: it.id, label: it.label, why: 'Coming soon', soon: true });
      return;
    }
    if (!m.items.some((x) => x.id === it.id)) m.items.push({ id: it.id, label: it.label, form: !!it.form, note: it.note ?? '', status: it.status ?? 'auto', ...(it.chip ? { chip: it.chip } : {}), ...(it.detail ? { detail: it.detail } : {}), source });
  }
  drop(modId: string, itemId: string): void {
    const m = this.mods.get(modId);
    if (m) m.items = m.items.filter((x) => x.id !== itemId);
  }
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function frequencyLabel(f: NonNullable<Answers['frequency']>): string {
  if (f.value === 'weekly') return `Weekly, paid ${cap(f.weekday ?? 'friday')}s`;
  if (f.value === 'biweekly') return `Every other week, paid ${cap(f.weekday ?? 'friday')}s`;
  if (f.value === 'semimonthly') return 'Twice a month';
  return 'Monthly';
}

const FREQ_CHIP: Record<Frequency, string> = { weekly: 'Weekly', biweekly: 'Every other week', semimonthly: 'Twice a month', monthly: 'Monthly' };

function plan(industry: IndustryId, a: Answers, date: string): Plan {
  const p = new Plan();
  const restaurant = industry === 'restaurant';
  const teamLabel = a.team ? (TEAM_SIZES.find((t) => t.value === a.team)?.label ?? '').replace(' people', '') : '';

  // ---- the base every business starts with
  p.module('pay_run', 'Pay run', 'Schedule, overtime flags and pay stubs.', 'base');
  p.item('pay_run', a.frequency
    ? { id: 'pay_schedule', label: 'Pay schedule', note: `${frequencyLabel(a.frequency).replace(', paid ', ', paid on ')}.`, status: 'auto', chip: FREQ_CHIP[a.frequency.value], detail: frequencyLabel(a.frequency) }
    : { id: 'pay_schedule', label: 'Pay schedule', note: 'Not set yet. Choose how often you pay', status: 'toset' }, 'base');
  p.item('pay_run', { id: 'overtime_flags', label: 'Overtime flags', note: 'Hours over 40 are marked for review before approval', status: 'auto' }, 'base');
  p.item('pay_run', { id: 'pay_stubs', label: 'Pay stubs', note: 'One for each employee when you approve', status: 'auto' }, 'base');
  p.module('team', 'Team', 'Everyone you pay.', 'base');
  p.item('team', { id: 'roster', label: 'Employees', note: 'Add people one at a time or send an invite link', status: 'open' }, 'base');
  const hoursId = restaurant ? 'hours_tips' : 'hours';
  p.module(hoursId, restaurant ? 'Time and tips' : 'Hours', restaurant ? 'Shift hours and tip entry.' : 'Hours worked, with overtime.', 'base');
  p.item(hoursId, { id: 'hours_entry', label: 'Hours', note: 'Enter by week or import a spreadsheet', status: 'manual' }, 'base');
  if (restaurant) p.item(hoursId, { id: 'tip_entry', label: 'Tip entry', note: 'Card and cash tips for each shift', status: 'manual' }, 'base');
  p.module('federal_taxes', 'Federal taxes', 'Income tax, Social Security and Medicare, FUTA.', 'base');
  p.item('federal_taxes', { id: 'fed_income_tax', label: 'Federal income tax', note: 'From each employee’s W-4', status: 'auto' }, 'base');
  p.item('federal_taxes', { id: 'fica', label: 'Social Security and Medicare', note: 'Employee and employer shares', status: 'auto' }, 'base');
  p.item('federal_taxes', { id: 'futa', label: 'FUTA', note: 'Employer federal unemployment', status: 'auto' }, 'base');
  p.module('new_hire_forms', 'New-hire paperwork', 'What each new hire fills in on their phone.', 'base');
  p.item('new_hire_forms', { id: 'form_w4', label: 'W-4', note: 'Federal withholding form, filled in on the employee’s phone', status: 'auto', form: true }, 'base');
  p.item('new_hire_forms', { id: 'form_i9', label: 'I-9', note: 'Employee fills in section 1; you complete section 2', status: 'auto', form: true }, 'base');
  p.item('new_hire_forms', { id: 'form_direct_deposit', label: 'Direct deposit form', note: 'Bank details collected for setup', status: 'auto', form: true }, 'base');

  // ---- state cards: the home state, plus any other state a location is in
  const states: string[] = [];
  if (a.state) states.push(a.state);
  for (const l of a.locations ?? []) if (!states.includes(l.state)) states.push(l.state);
  for (const code of states) {
    const f = stateFacts(code, date);
    const id = `state_${code.toLowerCase()}`;
    const src = code === a.state ? 'state' : 'locations';
    p.module(id, f.name, `${f.name} taxes and reference rules.`, src);
    // The state's own form is something a new hire fills in, so it sits with the other forms.
    if (f.form) p.item('new_hire_forms', { id: `${id}_form`, label: f.form.label, note: `${f.name} withholding form, added for your state`, status: 'auto', form: true }, src);
    if (f.incomeTax) p.item(id, { id: `${id}_withholding`, label: `${f.name} income tax withholding`, note: f.form ? `Uses each employee’s ${f.form.label}` : 'From each employee’s state certificate', status: 'auto' }, src);
    p.item(id, { id: `${id}_unemployment`, label: 'Unemployment account', note: code === 'MI' ? 'Add your UIA employer account number' : 'Add your state unemployment account number', status: 'todo' }, src);
    p.item(id, { id: `${id}_min_wage`, label: 'Minimum wage reference', note: 'Shown beside each hourly rate', status: 'reference' }, src);
    if (f.sickLeaveLaw) p.item(id, { id: `${id}_sick_leave`, label: 'Earned sick time', note: 'Your state has a sick leave law. Totali shows the rule; it does not track the hours', status: 'reference' }, src);
  }

  // ---- locations: a city with its own tax adds it to its state's card; two or more add a Locations card
  const locs = a.locations ?? [];
  for (const l of locs) {
    const lt = localTax(l.state, l.city, date);
    if (lt) p.item(`state_${l.state.toLowerCase()}`, { id: `city_tax_${slug(lt.city)}`, label: `${lt.city} city income tax`, note: `For staff who work in ${lt.city}, resident and non-resident`, status: 'auto' }, 'locations');
  }
  if (locs.length >= 2) {
    p.module('locations', 'Locations', 'Where your people work.', 'locations');
    for (const l of locs) {
      const taxed = !!localTax(l.state, l.city, date);
      p.item('locations', { id: `loc_${slug(l.name)}`, label: l.name, note: `Work location · ${taxed ? 'city income tax applies' : 'no city tax set up'}`, status: 'added', ...(l.city.toLowerCase() !== l.name.toLowerCase() ? { detail: l.city } : {}) }, 'locations');
    }
  }

  // ---- team size
  if (a.team && a.team !== '1-10') p.item('team', { id: 'bulk_invite', label: 'Bulk invite', note: `Upload a spreadsheet for a team of ${teamLabel}`, status: 'added' }, 'team');

  // ---- industry rules
  if (restaurant && a.tips) {
    if (a.tips.on) {
      p.item(hoursId, { id: 'tip_reporting', label: 'Tip reporting', note: 'Tips show on each stub and count toward taxable pay', status: 'auto' }, 'tips');
      if (a.tips.pool !== 'none') p.item(hoursId, { id: 'tip_pool', label: 'Tip pool', note: a.tips.pool === 'hours' ? 'Split by hours worked' : 'Split by role', status: 'setup', detail: a.tips.pool === 'hours' ? 'Split by hours' : 'Split by role' }, 'tips');
      if (a.state) p.item(`state_${a.state.toLowerCase()}`, { id: 'tip_credit_ref', label: 'Tip credit reference', note: 'Shown when you set tipped base rates', status: 'reference' }, 'tips');
      p.item('federal_taxes', { id: 'tips_taxable', label: 'Tips in taxable wages', note: 'Included when taxes are worked out', status: 'auto' }, 'tips');
    } else {
      p.drop(hoursId, 'tip_entry');
    }
  }
  if (industry === 'hotel_lodging') {
    if (a.departments?.on) {
      p.module('departments', 'Departments', 'Tag people to departments.', 'departments');
      p.item('departments', { id: 'dept_tags', label: 'Department tags', note: a.departments.names.length ? a.departments.names.join(', ') : 'Tag each person to a department', status: 'open', ...(a.departments.names.length ? { detail: a.departments.names.join(', ') } : {}) }, 'departments');
      p.item('departments', { id: 'dept_costs', label: 'Labor cost by department', note: 'Hours and cost for each department', status: 'auto' }, 'departments');
    }
    if (a.seasonal?.on) {
      p.module('seasonal', 'Seasonal staff', 'Season dates and who is ending.', 'seasonal');
      p.item('seasonal', { id: 'seasonal_dates', label: 'Season start and end dates', note: 'Set on each seasonal person', status: 'open' }, 'seasonal');
      p.item('seasonal', { id: 'seasonal_ending', label: 'Ending soon', note: 'Who is about to finish their season', status: 'auto' }, 'seasonal');
    }
    if (a.service?.on) {
      p.module(hoursId, 'Time and tips', 'Hours, tips and service charges.', 'service');
      p.item(hoursId, { id: 'tip_entry', label: 'Tip entry', note: 'Card and cash tips for each shift', status: 'manual' }, 'service');
      p.item(hoursId, { id: 'service_charge', label: 'Service charge distribution', note: 'A mandatory service charge paid to staff is wages', status: 'setup' }, 'service');
      p.item('federal_taxes', { id: 'tips_taxable', label: 'Tips in taxable wages', note: 'Included when taxes are worked out', status: 'auto' }, 'service');
    }
  }
  if (industry === 'construction_trades') {
    if (a.jobs?.on) {
      p.module('job_costing', 'Job costing', 'Hours coded to jobs.', 'jobs');
      p.item('job_costing', { id: 'job_codes', label: 'Job codes on hours', note: 'Code each shift to a job', status: 'manual' }, 'jobs');
      p.item('job_costing', { id: 'job_costs', label: 'Cost by job', note: 'Hours and cost for each job', status: 'auto' }, 'jobs');
    }
    if (a.crews?.on) {
      p.module('crews', 'Crews', 'Tag people to crews.', 'crews');
      p.item('crews', { id: 'crew_tags', label: 'Crew tags', note: 'Tag each person to a crew', status: 'open' }, 'crews');
      p.item('crews', { id: 'crew_hours', label: 'Hours by crew', note: 'Each crew’s hours this week', status: 'auto' }, 'crews');
    }
    if (a.wc?.on) {
      p.module('workers_comp', 'Workers’ comp classes', 'Payroll by class for your insurer.', 'wc');
      p.item('workers_comp', { id: 'wc_classes', label: 'Class code per person', note: 'Your insurer assigns the classes', status: 'open' }, 'wc');
      p.item('workers_comp', { id: 'wc_payroll', label: 'Payroll by class', note: 'For your insurer’s audit', status: 'auto' }, 'wc');
    }
  }
  if (industry === 'office_studios') {
    if (a.timeoff?.on) {
      p.module('time_off', 'Time off', 'Policies and balances.', 'timeoff');
      p.item('time_off', { id: 'pto_policy', label: 'Time-off policy', live: false }, 'timeoff');
      p.item('time_off', { id: 'pto_balances', label: 'Balances per person', live: false }, 'timeoff');
    }
    if (a.multistate?.on) {
      p.module('multi_state', 'More than one state', 'Each person taxed by their own state.', 'multistate');
      p.item('multi_state', { id: 'work_state', label: 'Work state per person', note: 'Set on each person', status: 'open' }, 'multistate');
      p.item('multi_state', { id: 'state_totals', label: 'Taxes by state', note: 'Each state’s totals on every run', status: 'auto' }, 'multistate');
    }
  }
  if (industry === 'delivery_couriers') {
    if (a.trips?.on) {
      p.module('trips', 'Trips', 'Pay by the trip.', 'trips');
      p.item('trips', { id: 'trip_log', label: 'Trip log', live: false }, 'trips');
      p.item('trips', { id: 'trip_pay', label: 'Pay per trip', live: false }, 'trips');
    }
    if (a.mileage?.on) {
      p.module('mileage', 'Mileage', 'Miles driven.', 'mileage');
      p.item('mileage', { id: 'mileage_log', label: 'Mileage log', live: false }, 'mileage');
      p.item('mileage', { id: 'mileage_report', label: 'Mileage report', live: false }, 'mileage');
    }
  }

  // ---- the optional questions every business can answer
  if (industry === 'restaurant' && a.tips?.on && a.tipcredit?.on) p.item('hours_tips', { id: 'tip_credit', label: 'Tip credit', note: 'Tips count toward minimum wage. Each tipped hire needs your written notice first', status: 'setup' }, 'tipcredit');
  if (a.bonuses?.on) p.item('pay_run', { id: 'bonus_pay', label: 'Bonuses and reimbursements', note: 'Add them to anyone while you run payroll', status: 'manual' }, 'bonuses');
  if (a.deductions?.on) {
    p.module('deductions', 'Deductions', 'Taken out of pay besides taxes.', 'deductions');
    p.item('deductions', { id: 'deduction_plans', label: 'Health and retirement', note: 'Set up on each person: premiums, 401(k) and similar', status: 'open' }, 'deductions');
    p.item('deductions', { id: 'garnishments', label: 'Garnishments and repayments', note: 'Amounts taken after tax, set on each person', status: 'open' }, 'deductions');
  }
  if (a.prior?.on) p.item('team', { id: 'opening_balances', label: 'Opening balances', note: 'Bring in this year’s pay from your old service so tax limits are right', status: 'todo' }, 'prior');

  // ---- contractors
  if (a.contractors?.on) {
    const label = industry === 'delivery_couriers' ? 'Contractor drivers' : 'Contractors';
    p.module('contractors', label, 'Kept apart from payroll.', 'contractors');
    p.item('contractors', { id: 'contractor_1099', label: '1099 contractors', note: 'Payments tracked separately from payroll', status: 'auto', ...(a.contractors.count ? { detail: `About ${a.contractors.count}` } : {}) }, 'contractors');
    p.item('contractors', { id: 'contractor_w9', label: 'W-9 collection', note: 'Request and store forms', status: 'ready' }, 'contractors');
    p.item('contractors', { id: 'contractor_pay', label: 'Year totals', note: 'For your records and your accountant', status: 'ready' }, 'contractors');
  }
  return p;
}

/** Every optional answer set to its fullest, to see what a business that said yes to everything would have. */
function fullest(industry: IndustryId, a: Answers): Answers {
  const on = { on: true };
  return {
    ...(a.state ? { state: a.state } : {}),
    locations: (a.locations?.length ?? 0) >= 2 ? a.locations! : [{ name: 'Location one', city: 'x', state: a.state ?? 'XX' }, { name: 'Location two', city: 'y', state: a.state ?? 'XX' }],
    team: '11-25',
    tips: { on: true, pool: 'hours' },
    ...(a.frequency ? { frequency: a.frequency } : {}),
    contractors: on,
    departments: { on: true, names: [] },
    seasonal: on, service: on, jobs: on, crews: on, wc: on, timeoff: on, multistate: on, trips: on, mileage: on, tipcredit: on, bonuses: on, deductions: on, prior: on,
  };
}

export interface Progress {
  answered: string[];
  total: number;
  next: string | null;
  ready: boolean;
}

export interface BuildResult {
  industry: IndustryId;
  modules: BuiltModule[];
  counts: Counts;
  leftOut: LeftOut[];
  progress: Progress;
}

function count(mods: BuiltModule[]): Counts {
  return { modules: mods.length, items: mods.reduce((n, m) => n + m.items.length, 0), forms: mods.reduce((n, m) => n + m.items.filter((i) => i.form).length, 0) };
}

export function build(industry: IndustryId, answers: Answers, date: string): BuildResult {
  const p = plan(industry, answers, date);
  // A card with nothing live in it is not shown (its items are listed as coming soon instead).
  const modules = [...p.mods.values()].filter((m) => m.items.length > 0);
  const questions = QUESTIONS[industry];
  const has = (id: string) => (answers as Record<string, unknown>)[id] !== undefined;

  // What is left out: whatever the fullest version of this business has that this one does not, grouped by the question that would add it.
  const full = plan(industry, fullest(industry, answers), date);
  const currentIds = new Set(modules.flatMap((m) => [m.id, ...m.items.map((i) => i.id)]));
  const grouped = new Map<string, string[]>();
  for (const m of full.mods.values()) {
    if (m.items.length === 0 || m.id === 'state_xx') continue;
    if (!currentIds.has(m.id) && m.source !== 'base') {
      grouped.set(m.source, [...(grouped.get(m.source) ?? []), m.label]);
      continue;
    }
    for (const i of m.items) if (i.source !== 'base' && !currentIds.has(i.id)) grouped.set(i.source, [...(grouped.get(i.source) ?? []), i.label]);
  }
  const leftOut: LeftOut[] = [];
  for (const [source, labels] of grouped) {
    const q = questions.find((x) => x.id === source);
    if (!q) continue;
    const unique = [...new Set(labels)];
    leftOut.push({ id: source, label: unique.length > 3 ? `${unique.slice(0, 3).join(', ')} and ${unique.length - 3} more` : unique.join(', '), why: has(source) ? `You said no to ${q.rail.toLowerCase()}` : `Answer ${q.rail} to add`, soon: false });
  }
  if (!answers.state) leftOut.unshift({ id: 'state', label: 'Your state: withholding, forms, unemployment', why: 'Answer State to add', soon: false });
  const soonSeen = new Set<string>();
  for (const s of p.soon) if (!soonSeen.has(s.id)) { soonSeen.add(s.id); leftOut.push(s); }

  // A question that depends on an earlier yes is only counted once that yes is given.
  const asked = questions.filter((q) => !q.when || ((answers as Record<string, { on?: boolean } | undefined>)[q.when.question]?.on === true));
  const answered = asked.filter((q) => has(q.id)).map((q) => q.id);
  const next = asked.find((q) => !has(q.id))?.id ?? null;
  const required = ['state', 'team', 'frequency'];
  return { industry, modules, counts: count(modules), leftOut, progress: { answered, total: asked.length, next, ready: required.every((r) => has(r)) && (questions.some((q) => q.id === 'locations') ? has('locations') : true) } };
}

export function questionsFor(industry: IndustryId): Question[] {
  return QUESTIONS[industry];
}

export function assertIndustry(v: unknown): IndustryId {
  if (typeof v !== 'string' || !INDUSTRY_IDS.includes(v as IndustryId)) throw badRequest('Choose an industry.');
  return v as IndustryId;
}
