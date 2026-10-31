/**
 * Every card a dashboard can hold. A widget type says what it is called, which sizes it may take (of 12 columns),
 * what the owner can set on it, and which part of the business it needs: a tip pool card needs a tip pool. The
 * dashboard's front end draws each type; the server only validates what is saved.
 */

export type SettingType = 'select' | 'number' | 'text' | 'toggle' | 'multi';

export interface SettingDef {
  key: string;
  label: string;
  type: SettingType;
  options?: Array<{ value: string; label: string }>;
  min?: number;
  max?: number;
  maxLength?: number;
  /** Free text a person writes for themselves (a note). It is only ever shown as text, so it may contain any character but a control one. */
  freeText?: boolean;
  default: string | number | boolean | string[];
}

export type Category = 'General' | 'Payroll' | 'People' | 'Time' | 'Taxes' | 'Setup';

export interface WidgetDef {
  type: string;
  label: string;
  description: string;
  category: Category;
  spans: number[];
  defaultSpan: number;
  /** The card is only offered when the business has at least one of these modules or items. */
  needs?: string[];
  needsLabel?: string;
  settings: SettingDef[];
}

const opts = (...pairs: Array<[string, string]>) => pairs.map(([value, label]) => ({ value, label }));
const SPANS = [3, 4, 6, 8, 12];

export const METRICS = opts(
  ['headcount', 'People on payroll'], ['hours_week', 'Hours this week'], ['overtime_week', 'Overtime hours this week'],
  ['tips_week', 'Tips this week'], ['gross_last_run', 'Gross pay, latest run'], ['net_last_run', 'Net pay, latest run'],
  ['employer_cost_last_run', 'Total cost, latest run'], ['open_onboarding', 'People with forms to finish'], ['days_to_payday', 'Days to payday'],
);

export const QUICK_ACTIONS = opts(
  ['run_payroll', 'Run payroll'], ['invite_hire', 'Invite a new hire'], ['enter_hours', 'Enter hours and tips'],
  ['import_hours', 'Import a spreadsheet'], ['add_person', 'Add a person'], ['pay_stubs', 'Pay stubs'],
);

export const WIDGETS: WidgetDef[] = [
  { type: 'module', label: 'Module', description: 'One of the sections your setup built: its live numbers and its checklist.', category: 'Setup', spans: [4, 6, 8, 12], defaultSpan: 4,
    settings: [{ key: 'module', label: 'Section', type: 'text', maxLength: 40, default: '' }, { key: 'items', label: 'Show the checklist', type: 'toggle', default: true }] },
  { type: 'people_directory', label: 'People directory', description: 'Everyone on payroll, with filters, search, pay and paperwork at a glance.', category: 'People', spans: [8, 12], defaultSpan: 12,
    settings: [{ key: 'rows', label: 'Rows per page', type: 'number', min: 5, max: 100, default: 25 }, { key: 'showPay', label: 'Show pay rates', type: 'toggle', default: true }] },
  { type: 'onboarding_board', label: 'Who\'s finished', description: 'Every person\'s new-hire forms, with a reminder button for those still to do.', category: 'People', spans: [6, 8, 12], defaultSpan: 8,
    settings: [] },
  { type: 'invite_form', label: 'Invite a new hire', description: 'Send a new hire a link to fill in their forms on their phone.', category: 'People', spans: [4, 6, 8], defaultSpan: 4,
    settings: [] },
  { type: 'time_week', label: 'Hours by day', description: 'A week of hours, day by day, that you can edit. Move between weeks.', category: 'Time', spans: [8, 12], defaultSpan: 8,
    settings: [{ key: 'showLocation', label: 'Show work location', type: 'toggle', default: true }] },
  { type: 'tips_panel', label: 'Tips and tip pool', description: 'The week\'s card and cash tips, and how the pool splits.', category: 'Time', spans: [4, 6, 8, 12], defaultSpan: 4, needs: ['tip_reporting'], needsLabel: 'tips',
    settings: [] },
  { type: 'employee_access', label: 'Employee sign-in code', description: 'The code you give your team so they can sign in to their own pay stubs and forms.', category: 'People', spans: [4, 6, 8, 12], defaultSpan: 4,
    settings: [] },
  { type: 'built_from', label: 'Built from your answers', description: 'The answers your dashboard was built from, with a way to change them.', category: 'Setup', spans: [6, 8, 12], defaultSpan: 12,
    settings: [] },
  { type: 'welcome', label: 'Welcome banner', description: 'Your business name, a line of your own, and today\'s date.', category: 'General', spans: [6, 8, 12], defaultSpan: 12,
    settings: [{ key: 'greeting', label: 'Greeting', type: 'text', maxLength: 80, default: '' }, { key: 'showDate', label: 'Show today\'s date', type: 'toggle', default: true }] },
  { type: 'quick_actions', label: 'Quick actions', description: 'Buttons for the things you do most.', category: 'General', spans: SPANS, defaultSpan: 4,
    settings: [{ key: 'actions', label: 'Buttons', type: 'multi', options: QUICK_ACTIONS, default: ['run_payroll', 'invite_hire', 'enter_hours'] }] },
  { type: 'big_number', label: 'Big number', description: 'One figure you care about, shown large.', category: 'General', spans: [3, 4, 6], defaultSpan: 3,
    settings: [{ key: 'metric', label: 'Show', type: 'select', options: METRICS, default: 'headcount' }, { key: 'label', label: 'Label (optional)', type: 'text', maxLength: 40, default: '' }] },
  { type: 'note', label: 'Note', description: 'A note to yourself or your managers.', category: 'General', spans: SPANS, defaultSpan: 4,
    settings: [{ key: 'title', label: 'Title', type: 'text', maxLength: 60, default: 'Note' }, { key: 'text', label: 'Text', type: 'text', maxLength: 600, freeText: true, default: '' }] },
  { type: 'next_payroll', label: 'Next payroll', description: 'The period, the pay date, and a button to run it.', category: 'Payroll', spans: [4, 6, 8, 12], defaultSpan: 4,
    settings: [{ key: 'showPeriod', label: 'Show the pay period', type: 'toggle', default: true }, { key: 'emphasis', label: 'Lead with', type: 'select', options: opts(['date', 'The pay date'], ['countdown', 'Days to go']), default: 'date' }] },
  { type: 'payroll_history', label: 'Recent pay runs', description: 'Your last few runs and their totals.', category: 'Payroll', spans: [4, 6, 8, 12], defaultSpan: 6,
    settings: [{ key: 'count', label: 'How many', type: 'number', min: 1, max: 10, default: 4 }] },
  { type: 'payroll_cost', label: 'Payroll cost', description: 'What the latest run cost and where it went.', category: 'Payroll', spans: [3, 4, 6, 8], defaultSpan: 4,
    settings: [{ key: 'view', label: 'Show', type: 'select', options: opts(['split', 'Net, taxes and deductions'], ['gross', 'Gross pay'], ['total', 'Total cost to you']), default: 'split' }] },
  { type: 'tax_summary', label: 'Tax summary', description: 'What was withheld and what you owe on the latest run.', category: 'Taxes', spans: [4, 6, 8, 12], defaultSpan: 6,
    settings: [{ key: 'view', label: 'Show', type: 'select', options: opts(['both', 'Withheld and employer'], ['withheld', 'Withheld from employees'], ['employer', 'Employer taxes']), default: 'both' }] },
  { type: 'state_card', label: 'State card', description: 'A state\'s taxes, forms and reference rules.', category: 'Taxes', spans: [4, 6, 8, 12], defaultSpan: 6, needs: ['state_*'], needsLabel: 'a state',
    settings: [{ key: 'state', label: 'State', type: 'text', maxLength: 2, default: '' }] },
  { type: 'compliance', label: 'Compliance reminders', description: 'Rules for your industry and state, with where Totali helps and where it does not.', category: 'Taxes', spans: [4, 6, 8, 12], defaultSpan: 6,
    settings: [{ key: 'count', label: 'How many', type: 'number', min: 1, max: 12, default: 5 }] },
  { type: 'team_summary', label: 'Team', description: 'How many people you pay, and how they split.', category: 'People', spans: [3, 4, 6, 8], defaultSpan: 4,
    settings: [{ key: 'groupBy', label: 'Group by', type: 'select', options: opts(['role', 'Role'], ['location', 'Location'], ['department', 'Department'], ['crew', 'Crew'], ['pay', 'Hourly or salaried']), default: 'role' }] },
  { type: 'people_table', label: 'People list', description: 'Everyone on payroll, searchable.', category: 'People', spans: [6, 8, 12], defaultSpan: 12,
    settings: [{ key: 'rows', label: 'Rows', type: 'number', min: 3, max: 50, default: 10 }, { key: 'showPay', label: 'Show pay rates', type: 'toggle', default: true }, { key: 'showForms', label: 'Show forms status', type: 'toggle', default: true }] },
  { type: 'onboarding_progress', label: 'Onboarding progress', description: 'Who has finished their new-hire forms.', category: 'People', spans: [3, 4, 6, 8, 12], defaultSpan: 4,
    settings: [{ key: 'showNames', label: 'List who is behind', type: 'toggle', default: true }] },
  { type: 'forms_status', label: 'Forms status', description: 'W-4, I-9 and direct deposit across the team.', category: 'People', spans: [4, 6, 8, 12], defaultSpan: 6,
    settings: [] },
  { type: 'locations_card', label: 'Locations', description: 'Your locations and who works at each.', category: 'People', spans: [4, 6, 8, 12], defaultSpan: 6, needs: ['locations'], needsLabel: 'more than one location',
    settings: [] },
  { type: 'contractors_card', label: 'Contractors', description: 'Contractors, W-9s collected, and 1099 totals. Kept apart from payroll.', category: 'People', spans: [4, 6, 8, 12], defaultSpan: 6, needs: ['contractors'], needsLabel: 'contractors',
    settings: [] },
  { type: 'hours_week', label: 'Hours this week', description: 'Hours worked, day by day, with overtime.', category: 'Time', spans: [4, 6, 8, 12], defaultSpan: 6,
    settings: [{ key: 'chart', label: 'Chart', type: 'select', options: opts(['bars', 'Bars'], ['line', 'Line'], ['none', 'Numbers only']), default: 'bars' }] },
  { type: 'overtime_watch', label: 'Overtime watch', description: 'People close to or over 40 hours this week.', category: 'Time', spans: [3, 4, 6, 8], defaultSpan: 4,
    settings: [{ key: 'threshold', label: 'Warn from (hours)', type: 'number', min: 20, max: 60, default: 36 }] },
  { type: 'tips_week', label: 'Tips this week', description: 'Card and cash tips, day by day.', category: 'Time', spans: [3, 4, 6, 8, 12], defaultSpan: 6, needs: ['tip_reporting'], needsLabel: 'tips',
    settings: [{ key: 'chart', label: 'Chart', type: 'select', options: opts(['bars', 'Bars'], ['none', 'Numbers only']), default: 'bars' }] },
  { type: 'tip_pool_card', label: 'Tip pool', description: 'How this week\'s pool splits across the people in it.', category: 'Time', spans: [4, 6, 8, 12], defaultSpan: 6, needs: ['tip_pool'], needsLabel: 'a tip pool',
    settings: [{ key: 'rows', label: 'People shown', type: 'number', min: 3, max: 20, default: 8 }] },
  { type: 'group_cost', label: 'Cost by group', description: 'Hours and labor cost by department, crew, job or workers\' comp class.', category: 'Time', spans: [4, 6, 8, 12], defaultSpan: 6, needs: ['dept_costs', 'crew_hours', 'job_costs', 'wc_payroll'], needsLabel: 'departments, crews, job costing or workers\' comp classes',
    settings: [{ key: 'groupBy', label: 'Group by', type: 'select', options: opts(['department', 'Department'], ['crew', 'Crew'], ['job', 'Job'], ['wc', 'Workers\' comp class']), default: 'department' }] },
  { type: 'setup_progress', label: 'Finish setting up', description: 'What is left before your first payroll.', category: 'Setup', spans: [4, 6, 8, 12], defaultSpan: 12,
    settings: [] },
];

export const WIDGET_BY_TYPE: Record<string, WidgetDef> = Object.fromEntries(WIDGETS.map((w) => [w.type, w]));

/** The words a business can rename. The value is what shows by default. */
export const TERMS: Record<string, { label: string; default: string }> = {
  team: { label: 'Team', default: 'Team' },
  person: { label: 'A person', default: 'Person' },
  people: { label: 'People', default: 'People' },
  hours: { label: 'Hours', default: 'Hours' },
  tips: { label: 'Tips', default: 'Tips' },
  payroll: { label: 'Payroll', default: 'Payroll' },
  onboarding: { label: 'Onboarding', default: 'Onboarding' },
  new_hire: { label: 'New hire', default: 'New hire' },
  pay_day: { label: 'Pay day', default: 'Pay day' },
};

export const FONTS = opts(
  ['sans', 'Clean sans'], ['grotesk', 'Neo-grotesque'], ['humanist', 'Humanist'], ['rounded', 'Rounded'],
  ['serif', 'Classic serif'], ['didone', 'High-contrast serif'], ['slab', 'Slab serif'], ['mono', 'Monospace'],
  ['fraunces', 'Warm serif'], ['instrument', 'Friendly sans'],
);
export const MODES = opts(['cream', 'Cream'], ['light', 'Light'], ['paper', 'Paper'], ['slate', 'Slate'], ['dark', 'Dark']);
export const CARD_STYLES = opts(['flat', 'Flat'], ['outlined', 'Outlined'], ['ruled', 'Ruled'], ['elevated', 'Raised'], ['filled', 'Filled']);
export const DENSITIES = opts(['compact', 'Compact'], ['comfortable', 'Comfortable'], ['airy', 'Airy']);
export const NAVS = opts(['top', 'Top bar'], ['side', 'Side rail']);
export const HEADERS = opts(['plain', 'Plain'], ['band', 'Color band']);
export const NUMBER_STYLES = opts(['bold', 'Bold'], ['light', 'Light'], ['mono', 'Monospace']);
export const MARKS = opts(['initial', 'Initial'], ['dot', 'Dot'], ['bar', 'Bar'], ['none', 'None']);
export const RADII = [0, 2, 4, 8, 12, 16, 24];
