import { build, normalizeAnswers, type IndustryId } from '../builder/catalog.ts';
import type { Company } from '../domain/types.ts';
import type { Availability, DashboardConfig, DashboardTab, DashboardWidget } from './schema.ts';

/** What this business has, from the same engine that drew the builder's preview. */
export function availabilityFor(company: Company, date: string): Availability & { moduleIds: string[]; build: ReturnType<typeof build> } {
  const industry = (company.setup?.industry ?? company.industry) as IndustryId;
  const raw = company.setup ? company.setup.answers : { state: company.homeState };
  const { answers } = normalizeAnswers(industry, raw, date);
  const b = build(industry, answers, date);
  const ids = new Set(b.modules.flatMap((m) => [m.id, ...m.items.map((i) => i.id)]));
  const stateModules = b.modules.filter((m) => m.id.startsWith('state_')).map((m) => m.id.slice(6).toUpperCase());
  // The home state comes first.
  const states = [company.homeState, ...stateModules.filter((s) => s !== company.homeState)].filter((s, i, arr) => arr.indexOf(s) === i && stateModules.includes(s));
  return {
    has: (id) => (id.endsWith('*') ? [...ids].some((x) => x.startsWith(id.slice(0, -1))) : ids.has(id)),
    states: states.length ? states : [company.homeState],
    moduleIds: b.modules.map((m) => m.id),
    build: b,
  };
}

let counter = 0;
const wid = () => `w_d${(++counter).toString(36).padStart(3, '0')}`;
const w = (type: string, span: number, settings: DashboardWidget['settings'] = {}): DashboardWidget => ({ id: wid(), type, span, settings });

/**
 * The starting dashboard for a business, built from what it has. It is a starting point, not a template: every card,
 * size, tab, color, font and word in it can be changed, and two businesses rarely start the same.
 */
export function defaultConfig(company: Company, a: Availability): DashboardConfig {
  counter = 0;
  const restaurant = company.industry === 'restaurant';
  const has = a.has;
  const tabs: DashboardTab[] = [];

  // The overview is the sections the setup built (pay run, team, taxes and so on), each with its live numbers and
  // checklist, in the order and sizes the owner would expect. The owner can move, resize, swap or remove any of them.
  const overview: DashboardWidget[] = [w('setup_guide', 12), w('next_payroll_hero', 8), w('todo_list', 4), w('week_snapshot', 12), w('cost_trend', 6), w('tax_due', 6), w('pos_status', 12), w('built_from', 12)];
  const a2 = a as Availability & { build?: { modules: Array<{ id: string }> } };
  for (const m of a2.build?.modules ?? []) overview.push(w('module', m.id === 'pay_run' ? 8 : 4, { module: m.id }));
  tabs.push({ id: 'overview', label: 'Overview', kind: 'page', widgets: overview });

  tabs.push({ id: 'payroll', label: 'Payroll', kind: 'page', widgets: [w('next_payroll_hero', 12), w('payroll_history', 6), w('cost_trend', 6), w('payroll_cost', 6), w('tax_summary', 6)] });

  const people: DashboardWidget[] = [w('people_directory', 12), w('team_summary', 6), w('onboarding_progress', 6)];
  if (has('locations')) people.push(w('locations_card', 6));
  if (has('contractors')) people.push(w('contractors_card', 6));
  tabs.push({ id: 'people', label: 'People', kind: 'page', widgets: people });

  const time: DashboardWidget[] = has('tip_reporting') ? [w('pos_status', 8), w('tips_panel', 4), w('labor_by_role', 12), w('overtime_watch', 6)] : [w('pos_status', 12), w('labor_by_role', 12), w('overtime_watch', 6)];
  const group = has('dept_costs') ? 'department' : has('crew_hours') ? 'crew' : has('job_costs') ? 'job' : has('wc_payroll') ? 'wc' : null;
  if (group) time.push(w('group_cost', 12, { groupBy: group }));
  tabs.push({ id: 'time', label: restaurant ? 'Time and tips' : 'Time', kind: 'page', widgets: time });

  tabs.push({ id: 'onboarding', label: 'Onboarding', kind: 'page', widgets: [w('onboarding_board', 8), w('invite_form', 4), w('forms_status', 6), w('onboarding_progress', 6)] });
  const taxTab: DashboardWidget[] = [w('tax_due', 12, { count: 20 }), w('compliance', 6)];
  for (const st of a.states) taxTab.push(w('state_card', 6, { state: st }));
  tabs.push({ id: 'taxes', label: 'Taxes', kind: 'page', widgets: taxTab });
  tabs.push({ id: 'reports', label: 'Reports', kind: 'page', widgets: [w('reports_list', 12)] });
  tabs.push({ id: 'help', label: 'Help', kind: 'help', widgets: [] });
  tabs.push({ id: 'settings', label: 'Settings', kind: 'settings', widgets: [] });

  return {
    version: 1,
    brand: { name: company.legalName, tagline: '', mark: 'initial' },
    theme: { mode: 'cream', accent: '#8e1f4e', accent2: '#0e5a66', font: 'instrument', headingFont: 'fraunces', radius: 12, density: 'comfortable', cardStyle: 'flat', nav: 'top', header: 'plain', numbers: 'bold' },
    terms: {},
    tabs,
  };
}
