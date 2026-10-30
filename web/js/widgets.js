import { h, money, hoursFromMinutes, longDate, shortDate, plural } from './dom.js';
import { link } from './router.js';
import { Button, Chip, StatusChip } from './ui.js';
import { session } from './session.js';

const svgNs = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}, ...kids) => { const el = document.createElementNS(svgNs, tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v)); for (const c of kids) if (c) el.append(c); return el; };
const svgText = (x, y, t) => { const el = svg('text', { x, y }); el.textContent = t; return el; };

const pct = (n, d) => (d > 0 ? Math.round((n / d) * 100) : 0);
const dayLabel = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'narrow', timeZone: 'UTC' });

function barChart(values, labels, { line = false, fmt = (v) => String(v) } = {}) {
  const W = 300; const H = 120; const pad = 18; const max = Math.max(...values, 1);
  const bw = (W - pad * 2) / values.length;
  const root = svg('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': values.map((v, i) => `${labels[i]} ${fmt(v)}`).join(', '), preserveAspectRatio: 'none' });
  if (line) {
    const pts = values.map((v, i) => [pad + bw * i + bw / 2, H - 20 - (v / max) * (H - 40)]);
    root.append(svg('polyline', { class: 'ln', points: pts.map((p) => p.join(',')).join(' ') }), ...pts.map(([x, y]) => svg('circle', { class: 'dotc', cx: x, cy: y, r: 3.5 })));
  } else {
    values.forEach((v, i) => { const bh = Math.max(v > 0 ? 3 : 0, (v / max) * (H - 40)); root.append(svg('rect', { class: 'b', x: pad + bw * i + bw * 0.15, y: H - 20 - bh, width: bw * 0.7, height: bh })); });
  }
  labels.forEach((l, i) => root.append(svgText(pad + bw * i + bw / 2, H - 6, l)));
  return root;
}

function splitBar(parts) {
  const total = parts.reduce((n, p) => n + p.value, 0) || 1;
  const cls = ['', 'two', 'three'];
  return h('div', { class: 'stack', style: { '--gap': '10px' } },
    h('div', { class: 'bar-track', role: 'img', 'aria-label': parts.map((p) => `${p.label} ${money(p.value)}`).join(', ') }, ...parts.map((p, i) => h('div', { class: `bar-seg ${cls[i] || 'three'}`, style: { width: `${(p.value / total) * 100}%` } }))),
    h('div', { class: 'legend' }, ...parts.map((p, i) => h('span', {}, h('i', { class: cls[i] || 'three' }), `${p.label} `, h('b', {}, money(p.value))))));
}

const progress = (n, d) => h('div', { class: 'bar-track', role: 'progressbar', 'aria-valuenow': String(n), 'aria-valuemax': String(d) }, h('div', { class: 'bar-seg', style: { width: `${pct(n, d)}%` } }));
const empty = (text, to, cta) => h('div', { class: 'empty' }, text, to ? [' ', link(to, { class: 'link' }, cta)] : null);

const ACTIONS = {
  run_payroll: { label: 'Run payroll', to: '/app/payroll/run', primary: true },
  invite_hire: { label: 'Invite a new hire', to: '/app/onboarding' },
  enter_hours: { label: 'Enter hours and tips', to: '/app/time/hours' },
  import_hours: { label: 'Import a spreadsheet', to: '/app/time/hours?import=1' },
  add_person: { label: 'Add a person', to: '/app/people/new' },
  pay_stubs: { label: 'Pay stubs', to: '/app/payroll/stubs' },
};

const METRIC = {
  headcount: (d) => ({ v: String(d.team.active), l: 'People on payroll' }),
  hours_week: (d) => ({ v: hoursFromMinutes(d.hours.totalMinutes), l: 'Hours this week' }),
  overtime_week: (d) => ({ v: hoursFromMinutes(d.hours.overtimeMinutes), l: 'Overtime hours this week' }),
  tips_week: (d) => ({ v: money(d.tips.chargedCents + d.tips.cashCents), l: 'Tips this week' }),
  gross_last_run: (d) => ({ v: d.latest ? money(d.latest.grossCents) : '—', l: 'Gross pay, latest run' }),
  net_last_run: (d) => ({ v: d.latest ? money(d.latest.netCents) : '—', l: 'Net pay, latest run' }),
  employer_cost_last_run: (d) => ({ v: d.latest ? money(d.latest.totalCostCents) : '—', l: 'Total cost, latest run' }),
  open_onboarding: (d) => ({ v: String(d.onboarding.total - d.onboarding.complete), l: 'People with forms to finish' }),
  days_to_payday: (d) => ({ v: String(Math.max(0, d.nextPayday.daysUntil)), l: 'Days to payday' }),
};

const STATUS = { draft: ['Draft', 'warn'], approved: ['Approved', 'accent'], funding: ['Paying', 'accent'], funded: ['Paying', 'accent'], disbursing: ['Paying', 'accent'], completed: ['Paid', 'good'], failed: ['Failed', 'bad'] };
const statusChip = (s) => { const [l, c] = STATUS[s] || [s, 'muted']; return h('span', { class: `dchip ${c}` }, l); };

/**
 * One renderer per card type. Each gets { data, settings, t, config } and returns what goes inside the card, and may
 * set `title` (the small heading) and `className`. A card with nothing to show says so and says what to do.
 */
// ---------------------------------------------------------------- modules: the sections the setup built
const initial = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'narrow', timeZone: 'UTC' });

/** The live part of a module, above its checklist. A module with nothing live to show has none. */
const RICH = {
  pay_run(data) {
    const n = data.nextPayday; const l = data.latest;
    const issues = [];
    const noW4 = data.onboarding.behind.filter((p) => !p.w4);
    if (noW4.length) issues.push(`${noW4.slice(0, 2).map((p) => p.name).join(' and ')}${noW4.length > 2 ? ` and ${noW4.length - 2} more` : ''} ${noW4.length === 1 ? 'has' : 'have'} no W-4 on file.`);
    const ot = data.hours.people.filter((p) => p.minutes > 2400);
    if (ot.length) issues.push(`${ot[0].name} has ${hoursFromMinutes(ot[0].minutes - 2400)} overtime hours.`);
    const stat = (label, v) => h('div', {}, h('i', {}, label), h('b', {}, v));
    return h('div', { class: 'rich' },
      h('div', { class: 'big2' }, h('div', {}, h('i', {}, `${shortDate(n.period.periodStart)} to ${shortDate(n.period.periodEnd)} · pay date ${longDate(n.period.checkDate)}`), h('span', { class: 'n' }, n.state === 'in_progress' ? 'Pay run in progress' : 'Next pay run')),
        Button({ href: `/app/payroll/run?start=${n.period.periodStart}`, size: 'sm' }, n.state === 'in_progress' ? 'Continue payroll' : 'Run payroll')),
      h('div', { class: 'stats' }, stat(l ? 'Gross pay, latest run' : 'Gross pay', l ? money(l.grossCents) : '—'), stat('Employee taxes', l ? money(l.employeeTaxCents) : '—'), stat('Net pay', l ? money(l.netCents) : '—'), stat('Employees', String(l ? l.employees : data.team.active))),
      issues.length ? h('div', { class: 'alert', style: { marginTop: '12px' } }, h('span', { class: 'dot' }), h('span', {}, h('b', {}, `${plural(issues.length, 'item')} to review. `), issues.join(' '))) : null);
  },
  team(data) {
    const o = data.onboarding; const left = o.total - o.complete;
    return h('div', { class: 'rich' },
      h('div', { class: 'big2' }, h('div', {}, h('i', {}, 'On the roster'), h('span', { class: 'n' }, plural(data.team.active, 'employee'))),
        data.team.byLocation.length > 1 ? h('div', { class: 'minis' }, ...data.team.byLocation.slice(0, 3).map((x) => h('div', {}, h('i', {}, x.label), h('b', {}, String(x.count))))) : null),
      o.total ? h('div', { class: 'prg', role: 'progressbar', 'aria-valuenow': String(o.complete), 'aria-valuemax': String(o.total) }, h('span', { style: { width: `${pct(o.complete, o.total)}%` } })) : null,
      h('p', { class: 'cap' }, o.total ? (left === 0 ? 'Everyone has finished their paperwork.' : `${o.complete} of ${o.total} have finished their paperwork. ${left} still to do.`) : 'Nobody here yet. Add people or send an invite link.'));
  },
  hours_tips(data) {
    const days = data.hours.byDay; const max = Math.max(...days.map((d) => d.minutes), 1);
    const top = days.reduce((b, d, i) => (d.minutes > days[b].minutes ? i : b), 0);
    const tips = data.tips.chargedCents + data.tips.cashCents;
    return h('div', { class: 'rich' },
      h('div', { class: 'bars', role: 'img', 'aria-label': days.map((d) => `${initial(d.date)} ${hoursFromMinutes(d.minutes)} hours`).join(', ') }, ...days.map((d, i) => h('span', { class: i === top && d.minutes > 0 ? 't' : '', style: { height: `${Math.max(4, Math.round((d.minutes / max) * 100))}%` } }))),
      h('div', { class: 'bl' }, ...days.map((d) => h('span', {}, initial(d.date)))),
      h('p', { class: 'cap', style: { marginTop: '8px' } }, data.hours.totalMinutes ? `${hoursFromMinutes(data.hours.totalMinutes)} hours this week${tips ? `, ${money(tips)} in tips` : ''}.` : 'No hours entered this week yet.'));
  },
  federal_taxes(data) {
    const lines = data.taxLines.filter((l) => l.payer === 'employee' && /federal|fed/i.test(l.jurisdiction)).slice(0, 3);
    return lines.length ? h('div', { class: 'rich' }, h('table', {}, h('tbody', {}, ...lines.map((l) => h('tr', {}, h('td', {}, l.name), h('td', {}, money(l.amountCents)))))), h('p', { class: 'cap', style: { paddingBottom: '6px' } }, 'Worked out by the Omnia.tax engine, latest run.')) : h('div', { class: 'rich' }, h('p', { class: 'cap' }, 'Federal taxes show here after your first pay run. The Omnia.tax engine works out every line.'));
  },
  locations(data) {
    const locs = data.company.locations; const counts = new Map(data.team.byLocation.map((x) => [x.label, x.count]));
    return locs.length ? h('div', { class: 'rich' }, h('table', {}, h('tbody', {}, ...locs.map((l) => h('tr', {}, h('td', {}, l.name, h('i', {}, ` · ${l.city}, ${l.state}`)), h('td', {}, plural(counts.get(l.name) || 0, 'person', 'people'))))))) : null;
  },
  contractors(data) {
    const c = data.contractors;
    return h('div', { class: 'rich' }, c.count === 0 ? h('p', { class: 'cap' }, 'No contractors yet. They are paid apart from payroll.') : h('div', { class: 'big2' }, h('div', {}, h('i', {}, 'On file'), h('span', { class: 'n' }, plural(c.count, 'contractor'))), h('div', { class: 'cap' }, `${c.w9} of ${c.count} W-9s collected`)), link('/app/contractors', { class: 'link' }, c.count ? 'Open contractors' : 'Add a contractor'));
  },
};

/** An item's note, kept live where the data knows better than the setup did. */
function itemNote(i, data) {
  if (i.id === 'pay_schedule' && i.status !== 'toset' && data.nextPayday) return `${i.note.replace(/\.$/, '')}. Next pay date ${shortDate(data.nextPayday.period.checkDate)}`;
  return i.note || i.detail || '';
}

export const RENDERERS = {
  module({ data, settings, t }) {
    const m = data.built.modules.find((x) => x.id === settings.module);
    if (!m) return { title: 'Section', body: empty('This section is not part of your setup any more. Remove this card, or pick another section.') };
    const rich = RICH[m.id] ? RICH[m.id](data) : m.id.startsWith('state_') ? null : null;
    return { className: 'modcard', title: m.id === 'team' ? t('team') : m.label, body: h('div', {}, rich, settings.items === false ? null : h('ul', { class: 'ml' }, ...m.items.map((i) => h('li', { 'data-item': i.id }, h('span', { class: 'lt' }, h('b', {}, i.label), h('i', {}, itemNote(i, data))), StatusChip(i))))) };
  },
  built_from({ data }) {
    const b = data.built;
    return { className: 'built flat', title: null, body: h('div', { class: 'built-body', style: { display: 'contents' } },
      h('span', { class: 'cap', style: { whiteSpace: 'nowrap' } }, 'Built from your answers'),
      h('div', { class: 'chips2' }, ...b.answers.map((a) => Chip(a, 'berry'))),
      link('/app/settings', { class: 'link' }, 'Edit answers'),
      h('div', { class: 'hand', style: { flexBasis: '100%', fontSize: '23px' } }, `What you told us is what’s in here. `, h('span', { style: { color: 'var(--mut)', fontSize: '19px' } }, `(${b.counts.modules} modules, ${b.counts.items} items)`))) };
  },
  welcome({ settings, config }) {
    const name = session.user ? session.user.firstName : '';
    const hr = new Date().getHours();
    const greet = settings.greeting || `${hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening'}${name ? `, ${name}` : ''}`;
    return { className: 'welcome', title: config.brand.name, body: h('div', { class: 'stack', style: { '--gap': '6px' } }, h('h2', {}, greet), config.brand.tagline ? h('div', { class: 'sub' }, config.brand.tagline) : null, settings.showDate ? h('div', { class: 'sub' }, new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })) : null) };
  },
  quick_actions({ settings }) {
    return { title: 'Quick actions', body: h('div', { class: 'stack', style: { '--gap': '8px' } }, ...(settings.actions || []).filter((a) => ACTIONS[a]).map((a) => Button({ variant: ACTIONS[a].primary ? 'primary' : 'ghost', full: true, href: ACTIONS[a].to }, ACTIONS[a].label))) };
  },
  big_number({ data, settings }) {
    const m = (METRIC[settings.metric] || METRIC.headcount)(data);
    return { title: settings.label || m.l, body: h('div', { class: 'big accent' }, m.v) };
  },
  note({ settings }) {
    return { title: settings.title || 'Note', body: settings.text ? h('p', { style: { margin: 0, whiteSpace: 'pre-wrap', lineHeight: '24px' } }, settings.text) : empty('Nothing here yet. Edit this card to write a note.') };
  },
  next_payroll({ data, settings }) {
    const n = data.nextPayday;
    const when = n.daysUntil < 0 ? `${-n.daysUntil} days ago` : n.daysUntil === 0 ? 'Today' : n.daysUntil === 1 ? 'Tomorrow' : `In ${n.daysUntil} days`;
    const stateChip = n.state === 'in_progress' ? h('span', { class: 'dchip accent' }, 'Run started') : n.ready ? h('span', { class: 'dchip warn' }, 'Hours needed') : h('span', { class: 'dchip muted' }, 'Period open');
    return { title: 'Next payroll', body: h('div', { class: 'stack', style: { '--gap': '10px' } },
      settings.emphasis === 'countdown' ? h('div', { class: 'big accent' }, n.daysUntil <= 0 ? 'Today' : String(n.daysUntil), n.daysUntil > 0 ? h('span', { class: 'sub', style: { fontSize: '16px', marginLeft: '8px' } }, plural(n.daysUntil, 'day').replace(/^\d+ /, '') + ' to go') : null) : h('div', { class: 'big accent' }, longDate(n.period.checkDate)),
      h('div', { class: 'sub' }, settings.emphasis === 'countdown' ? `Pay date ${longDate(n.period.checkDate)}` : when),
      settings.showPeriod ? h('div', { class: 'sub' }, `Period ${shortDate(n.period.periodStart)} to ${shortDate(n.period.periodEnd)}`) : null,
      h('div', { class: 'chip-row' }, stateChip),
      Button({ href: `/app/payroll/run?start=${n.period.periodStart}` }, n.state === 'in_progress' ? 'Continue payroll' : 'Run payroll')) };
  },
  payroll_history({ data, settings }) {
    const runs = data.runs.slice(0, settings.count || 4);
    if (!runs.length) return { title: 'Recent pay runs', body: empty('No pay runs yet.', '/app/payroll/run', 'Run your first payroll') };
    return { title: 'Recent pay runs', body: h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Period'), h('th', {}, 'Pay date'), h('th', { class: 'r' }, 'People'), h('th', { class: 'r' }, 'Gross'), h('th', {}, 'Status'))),
      h('tbody', {}, ...runs.map((r) => h('tr', {}, h('td', {}, link(`/app/payroll/runs/${r.id}`, { class: 'pl-name' }, `${shortDate(r.periodStart)} to ${shortDate(r.periodEnd)}`)), h('td', {}, shortDate(r.checkDate)), h('td', { class: 'r' }, String(r.employees)), h('td', { class: 'r' }, money(r.grossCents)), h('td', {}, statusChip(r.status)))))) };
  },
  payroll_cost({ data, settings }) {
    const l = data.latest;
    if (!l) return { title: 'Payroll cost', body: empty('Nothing to show until your first pay run.') };
    const sub = `${shortDate(l.periodStart)} to ${shortDate(l.periodEnd)} · ${plural(l.employees, 'person', 'people')}`;
    if (settings.view === 'gross') return { title: 'Payroll cost', body: h('div', { class: 'stack', style: { '--gap': '8px' } }, h('div', { class: 'big accent' }, money(l.grossCents)), h('div', { class: 'sub' }, `Gross pay · ${sub}`)) };
    if (settings.view === 'total') return { title: 'Payroll cost', body: h('div', { class: 'stack', style: { '--gap': '8px' } }, h('div', { class: 'big accent' }, money(l.totalCostCents)), h('div', { class: 'sub' }, `Gross plus employer taxes · ${sub}`)) };
    return { title: 'Payroll cost', body: h('div', { class: 'stack', style: { '--gap': '14px' } }, h('div', {}, h('div', { class: 'big accent' }, money(l.grossCents)), h('div', { class: 'sub' }, `Gross pay · ${sub}`)), splitBar([{ label: 'Net', value: l.netCents }, { label: 'Taxes', value: l.employeeTaxCents }, { label: 'Deductions', value: l.deductionsCents }].filter((p) => p.value > 0))) };
  },
  tax_summary({ data, settings }) {
    if (!data.taxLines.length) return { title: 'Tax summary', body: empty('Taxes appear here once you have a pay run. The Omnia.tax engine calculates every line.') };
    const lines = data.taxLines.filter((l) => settings.view === 'both' || (settings.view === 'withheld' ? l.payer === 'employee' : l.payer === 'employer'));
    const sum = (p) => data.taxLines.filter((l) => l.payer === p).reduce((n, l) => n + l.amountCents, 0);
    return { title: 'Tax summary', body: h('div', { class: 'stack', style: { '--gap': '12px' } },
      h('div', { style: { display: 'flex', gap: '32px' } }, settings.view !== 'employer' ? h('div', {}, h('div', { class: 'big sm accent' }, money(sum('employee'))), h('div', { class: 'sub' }, 'Withheld from employees')) : null, settings.view !== 'withheld' ? h('div', {}, h('div', { class: 'big sm' }, money(sum('employer'))), h('div', { class: 'sub' }, 'Employer taxes')) : null),
      h('ul', { class: 'row-list' }, ...lines.slice(0, 8).map((l) => h('li', {}, h('span', {}, l.name, h('span', { class: 'muted' }, ` · ${l.payer === 'employee' ? 'withheld' : 'employer'}`)), h('span', { class: 'amt' }, money(l.amountCents)))))) };
  },
  state_card({ data, settings }) {
    const s = data.stateCards.find((x) => x.code === settings.state) || data.stateCards[0];
    if (!s) return { title: 'State', body: empty('No state set up.') };
    return { title: s.name, body: h('ul', { class: 'row-list' }, ...s.items.map((i) => h('li', {}, h('span', {}, i.label), i.form ? h('span', { class: 'dchip accent' }, 'Form') : i.detail ? h('span', { class: 'sub' }, i.detail) : null))) };
  },
  compliance({ data, settings }) {
    if (!data.checklist.length) return { title: 'Compliance reminders', body: empty('No reminders for your industry yet.') };
    return { title: 'Compliance reminders', body: h('ul', { class: 'row-list' }, ...data.checklist.slice(0, settings.count || 5).map((c) => h('li', { style: { alignItems: 'flex-start' } }, h('span', {}, h('b', {}, c.title), h('div', { class: 'sub' }, c.notModelled ? 'You handle this. Totali only reminds.' : 'Totali covers part of this.')), c.verified ? null : h('span', { class: 'dchip muted', title: 'Written from general knowledge, not checked against a primary source' }, 'Unchecked')))) };
  },
  team_summary({ data, settings, t }) {
    const g = { role: data.team.byRole, location: data.team.byLocation, department: data.team.byDepartment, crew: data.team.byCrew, pay: data.team.byPay }[settings.groupBy] || data.team.byRole;
    const max = Math.max(...g.map((x) => x.count), 1);
    return { title: t('team'), body: h('div', { class: 'stack', style: { '--gap': '14px' } }, h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '12px' } }, h('div', { class: 'big accent' }, String(data.team.active)), h('div', { class: 'sub' }, data.team.newThisMonth ? `${data.team.newThisMonth} new this month` : 'on payroll')),
      g.length ? h('ul', { class: 'row-list' }, ...g.slice(0, 6).map((x) => h('li', {}, h('span', {}, x.label), h('span', { style: { display: 'flex', alignItems: 'center', gap: '8px' } }, h('span', { class: 'bar-track', style: { width: '60px' } }, h('span', { class: 'bar-seg', style: { width: `${(x.count / max) * 100}%` } })), h('b', { class: 'amt' }, String(x.count)))))) : empty(data.team.active ? `Nobody is tagged by ${settings.groupBy} yet.` : 'Nobody here yet.', '/app/people/new', 'Add a person')) };
  },
  people_table({ data, settings, t }) {
    const input = h('input', { class: 'in search', type: 'search', placeholder: `Search ${t('people').toLowerCase()}`, 'aria-label': 'Search people' });
    const body = h('tbody', {});
    const draw = () => {
      const q = input.value.trim().toLowerCase();
      const rows = data.people.filter((p) => !q || p.name.toLowerCase().includes(q) || p.role.toLowerCase().includes(q)).slice(0, settings.rows || 10);
      body.replaceChildren(...(rows.length ? rows.map((p) => h('tr', {}, h('td', {}, link(`/app/people/${p.id}`, { class: 'pl-name' }, p.name)), h('td', {}, p.role), h('td', {}, p.location || '—'), settings.showPay ? h('td', { class: 'r' }, p.pay.kind === 'hourly' ? `${money(p.pay.cents)}/hr` : `${money(p.pay.cents)}/yr`) : null, settings.showForms ? h('td', {}, p.done ? h('span', { class: 'dchip good' }, 'Ready') : h('span', { class: 'dchip warn' }, 'Forms')) : null)) : [h('tr', {}, h('td', { colspan: 5 }, empty(data.people.length ? 'No one matches.' : 'Nobody here yet.', '/app/people/new', 'Add a person')))]));
    };
    input.addEventListener('input', draw); draw();
    return { title: t('people'), body: h('div', { class: 'stack', style: { '--gap': '12px' } }, input, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Role'), h('th', {}, 'Location'), settings.showPay ? h('th', { class: 'r' }, 'Pay') : null, settings.showForms ? h('th', {}, 'Forms') : null)), body)) };
  },
  onboarding_progress({ data, settings, t }) {
    const o = data.onboarding;
    if (!o.total) return { title: t('onboarding'), body: empty('Nobody to onboard yet.', '/app/onboarding', 'Invite a new hire') };
    const left = o.total - o.complete;
    return { title: t('onboarding'), body: h('div', { class: 'stack', style: { '--gap': '12px' } }, h('div', { class: 'big accent' }, left === 0 ? 'All done' : `${o.complete} of ${o.total}`), h('div', { class: 'sub' }, left === 0 ? 'Everyone has finished their forms.' : `${left} still to do`), progress(o.complete, o.total),
      settings.showNames && o.behind.length ? h('ul', { class: 'row-list' }, ...o.behind.slice(0, 5).map((p) => h('li', {}, link(`/app/people/${p.id}`, { class: 'pl-name' }, p.name), h('span', { class: 'sub' }, [!p.w4 && 'W-4', p.i9 !== 'done' && 'I-9', !p.deposit && 'Deposit'].filter(Boolean).join(', '))))) : null) };
  },
  forms_status({ data }) {
    const o = data.onboarding;
    if (!o.total) return { title: 'Forms status', body: empty('Forms show up once you add people.') };
    const row = (label, n) => h('div', { class: 'stack', style: { '--gap': '6px' } }, h('div', { class: 'row-between' }, h('span', {}, label), h('b', { class: 'amt' }, `${n} of ${o.total}`)), progress(n, o.total));
    return { title: 'Forms status', body: h('div', { class: 'stack', style: { '--gap': '16px' } }, row('W-4', o.w4), row('I-9', o.i9), row('Direct deposit', o.deposit), o.stateForm !== null ? row(`${data.company.state} withholding form`, o.stateForm) : null) };
  },
  locations_card({ data }) {
    const locs = data.company.locations;
    if (!locs.length) return { title: 'Locations', body: empty('One location. Add more in Settings.') };
    const counts = new Map(data.team.byLocation.map((x) => [x.label, x.count]));
    return { title: 'Locations', body: h('ul', { class: 'row-list' }, ...locs.map((l) => h('li', {}, h('span', {}, h('b', {}, l.name), l.city.toLowerCase() !== l.name.toLowerCase() ? h('span', { class: 'sub' }, ` · ${l.city}`) : null, h('span', { class: 'sub' }, `, ${l.state}`)), h('span', { class: 'amt' }, plural(counts.get(l.name) || 0, 'person', 'people'))))) };
  },
  contractors_card({ data }) {
    const c = data.contractors;
    return { title: 'Contractors', body: c.count === 0 ? empty('No contractors yet. They are paid apart from payroll.', '/app/contractors', 'Add a contractor') : h('div', { class: 'stack', style: { '--gap': '10px' } }, h('div', { class: 'big accent' }, String(c.count)), h('div', { class: 'sub' }, `${c.w9} of ${c.count} W-9s collected`), h('div', { class: 'sub' }, `${money(c.ytdCents)} paid this year`), link('/app/contractors', { class: 'link' }, 'Open contractors')) };
  },
  hours_week({ data, settings }) {
    const hs = data.hours;
    return { title: 'Hours this week', body: h('div', { class: 'stack', style: { '--gap': '12px' } }, h('div', { style: { display: 'flex', gap: '32px', alignItems: 'baseline' } }, h('div', {}, h('div', { class: 'big accent' }, hoursFromMinutes(hs.totalMinutes)), h('div', { class: 'sub' }, `${shortDate(hs.weekStart)} to ${shortDate(hs.weekEnd)}`)), h('div', {}, h('div', { class: 'big sm' }, hoursFromMinutes(hs.overtimeMinutes)), h('div', { class: 'sub' }, 'Overtime'))),
      settings.chart === 'none' ? null : hs.totalMinutes === 0 ? empty('No hours entered this week.', '/app/time/hours', 'Enter hours') : barChart(hs.byDay.map((d) => d.minutes / 60), hs.byDay.map((d) => dayLabel(d.date)), { line: settings.chart === 'line', fmt: (v) => `${v.toFixed(1)} hours` })) };
  },
  overtime_watch({ data, settings }) {
    const lim = (settings.threshold || 36) * 60;
    const list = data.hours.people.filter((p) => p.minutes >= lim);
    return { title: 'Overtime watch', body: list.length ? h('ul', { class: 'row-list' }, ...list.slice(0, 8).map((p) => h('li', {}, h('span', {}, p.name), h('span', { style: { display: 'flex', gap: '8px', alignItems: 'center' } }, p.minutes > 2400 ? h('span', { class: 'dchip bad' }, 'Over 40') : h('span', { class: 'dchip warn' }, 'Close'), h('b', { class: 'amt' }, hoursFromMinutes(p.minutes) + ' h'))))) : empty(`Nobody is at ${settings.threshold || 36} hours this week.`) };
  },
  tips_week({ data, settings }) {
    const t = data.tips;
    return { title: 'Tips this week', body: h('div', { class: 'stack', style: { '--gap': '12px' } }, h('div', { style: { display: 'flex', gap: '32px', alignItems: 'baseline' } }, h('div', {}, h('div', { class: 'big accent' }, money(t.chargedCents + t.cashCents)), h('div', { class: 'sub' }, 'Total')), h('div', {}, h('div', { class: 'big sm' }, money(t.chargedCents)), h('div', { class: 'sub' }, 'Card')), h('div', {}, h('div', { class: 'big sm' }, money(t.cashCents)), h('div', { class: 'sub' }, 'Cash'))),
      settings.chart === 'none' ? null : t.chargedCents + t.cashCents === 0 ? empty('No tips entered this week.', '/app/time/hours', 'Enter tips') : barChart(t.byDay.map((d) => (d.chargedTipsCents + d.cashTipsCents) / 100), t.byDay.map((d) => dayLabel(d.date)), { fmt: (v) => `$${v.toFixed(2)}` })) };
  },
  tip_pool_card({ data, settings }) {
    const p = data.tipPool;
    if (!p || !p.rows.length) return { title: 'Tip pool', body: empty('Enter this week\'s hours and tips to see the split.', '/app/time/hours', 'Enter hours') };
    return { title: `Tip pool · by ${p.basis === 'points' ? 'role' : 'hours'}`, body: h('div', { class: 'stack', style: { '--gap': '10px' } }, h('div', { class: 'sub' }, `An estimate of ${money(p.totalCents)} across ${plural(p.rows.length, 'person', 'people')}. Pay runs apply tip-outs and the tip credit rules.`), h('ul', { class: 'row-list' }, ...p.rows.slice(0, settings.rows || 8).map((r) => h('li', {}, h('span', {}, r.name), h('b', { class: 'amt' }, money(r.shareCents)))))) };
  },
  group_cost({ data, settings }) {
    const g = { department: data.team.byDepartment, crew: data.team.byCrew }[settings.groupBy];
    if (!g || !g.length) return { title: `Cost by ${settings.groupBy}`, body: empty(`Tag people with a ${settings.groupBy} to see hours and cost grouped here.`, '/app/people', 'Open people') };
    return { title: `By ${settings.groupBy}`, body: h('ul', { class: 'row-list' }, ...g.map((x) => h('li', {}, h('span', {}, x.label), h('b', { class: 'amt' }, plural(x.count, 'person', 'people'))))) };
  },
  setup_progress({ data }) {
    const left = data.setup.filter((s) => !s.done);
    if (!left.length) return { title: 'Setup', body: h('div', { class: 'sub' }, 'Everything is set up.') };
    return { title: `Finish setting up · ${data.setup.length - left.length} of ${data.setup.length}`, body: h('ul', { class: 'row-list' }, ...data.setup.map((s) => h('li', {}, h('span', { style: { display: 'flex', gap: '10px', alignItems: 'center' } }, h('span', { class: `dchip ${s.done ? 'good' : 'warn'}` }, s.done ? 'Done' : 'To do'), s.label), s.done ? null : link(s.to, { class: 'link' }, 'Go')))) };
  },
};
