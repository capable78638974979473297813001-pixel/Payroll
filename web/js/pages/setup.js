import { h } from '../dom.js';
import { api } from '../api.js';
import { link, navigate } from '../router.js';
import { Button, Alert, Field, Hand, Logo, Steps3, Chip, StatusChip, TextLink, icon, setLoading, toast } from '../ui.js';
import { refreshUser, session, signOut } from '../session.js';

let meta = null;
async function loadMeta() {
  if (!meta) meta = await api.get('/v1/builder/industries');
  return meta;
}

const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// ---------------------------------------------------------------- the industry cards (look and wording from the design)
const IND = {
  restaurant: { color: '#8E1F4E', title: ['Restaurants', 'and bars'], blurb: 'Servers, cooks and bartenders. Hours, tips and tip pools on one pay run.', noun: 'restaurant', tab: 'Time & tips', icon: 'M4 21h22M6 21a9 9 0 0 1 18 0M15 10V7M13 7h4' },
  hotel_lodging: { color: '#0E5A66', title: ['Hotels', 'and venues'], blurb: 'Front desk to housekeeping. Departments, split shifts and service charges.', noun: 'hotel', tab: 'Departments', icon: 'M14.5 16H27M23 16v4.5M27 16v3', circle: [10, 16, 4.5] },
  construction_trades: { color: '#F0613A', title: ['Trades', 'and construction'], blurb: 'Crews, jobs and cost codes. Prevailing wage and union rates when you need them.', noun: 'trades business', tab: 'Job costing', icon: 'M7 24l9-9M15 6l9 9-3.2 3.2-9-9zM13 8.5l-4 4' },
  office_studios: { color: '#3B2A33', title: ['Office', 'and studios'], blurb: 'Salaried and hourly staff, time off, and people in more than one state.', noun: 'studio', tab: 'Time off', icon: 'M11 10V7h8v3M4 17.5h22', rect: [4, 10, 22, 15, 2.2], wide: true },
  delivery_couriers: { color: '#0E4D5A', title: ['Delivery', 'and couriers'], blurb: 'Drivers paid by the hour and by the trip. Mileage and contractor drivers.', noun: 'delivery business', tab: 'Trips', icon: 'M4 10l11-5 11 5v11l-11 5-11-5zM4 10l11 5 11-5M15 15v11', wide: true },
};

function indIcon(def) {
  return h('svg', { viewBox: '0 0 30 30' }, def.circle ? h('circle', { cx: def.circle[0], cy: def.circle[1], r: def.circle[2] }) : null, def.rect ? h('rect', { x: def.rect[0], y: def.rect[1], width: def.rect[2], height: def.rect[3], rx: def.rect[4] }) : null, h('path', { d: def.icon }));
}

// ---------------------------------------------------------------- choices in the design's .opt style
function optionList(options, selected, onPick, { columns = 1, label } = {}) {
  const wrap = h('div', { class: `opts ${columns === 2 ? 'c2' : ''}`, role: 'radiogroup', 'aria-label': label });
  const draw = (sel) => {
    wrap.replaceChildren(...options.map((o) => h('button', { type: 'button', class: `opt ${o.value === sel ? 'on' : ''}`, role: 'radio', 'aria-checked': String(o.value === sel), 'data-value': o.value, onClick: () => { onPick(o.value); draw(o.value); } },
      h('span', { class: 'rd' }), h('span', {}, o.label, o.help ? h('small', {}, o.help) : null))));
  };
  draw(selected);
  return { el: wrap, redraw: draw };
}

function stateCombobox(states, value, onPick) {
  const input = h('input', { class: 'in', id: 'state-in', type: 'text', role: 'combobox', 'aria-expanded': 'false', 'aria-autocomplete': 'list', autocomplete: 'off', placeholder: 'Start typing, like “Mi”', 'data-autofocus': '' });
  const list = h('div', { class: 'dd', role: 'listbox', hidden: true });
  let hits = []; let active = 0;
  const show = () => { list.hidden = hits.length === 0; input.setAttribute('aria-expanded', String(!list.hidden)); };
  const draw = () => {
    list.replaceChildren(...hits.map((s, i) => h('div', { role: 'option', class: i === active ? 'on' : '', 'aria-selected': String(i === active), onMousedown: (e) => { e.preventDefault(); pick(s); } }, s.name)));
    show();
  };
  function pick(s) { input.value = s.name; hits = []; show(); onPick(s.code); }
  function search() {
    const q = input.value.trim().toLowerCase();
    if (!q) { hits = []; show(); onPick(null); return; }
    const starts = states.filter((s) => s.name.toLowerCase().startsWith(q) || s.code.toLowerCase() === q);
    const has = states.filter((s) => !starts.includes(s) && s.name.toLowerCase().includes(q));
    hits = [...starts, ...has].slice(0, 6); active = 0; draw();
    const exact = states.find((s) => s.name.toLowerCase() === q);
    onPick(exact ? exact.code : null);
  }
  input.addEventListener('input', search);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { active = Math.min(hits.length - 1, active + 1); draw(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { active = Math.max(0, active - 1); draw(); e.preventDefault(); }
    else if (e.key === 'Enter' && hits[active]) { pick(hits[active]); e.preventDefault(); }
    else if (e.key === 'Escape') { hits = []; show(); }
  });
  input.addEventListener('blur', () => setTimeout(() => { hits = []; show(); }, 120));
  const cur = states.find((s) => s.code === value);
  if (cur) input.value = cur.name;
  return { el: h('div', {}, h('label', { class: 'lab', for: 'state-in' }, 'State'), h('div', { class: 'inwrap' }, input), list), input };
}

/** Cities people commonly add. A hint only: anything can be typed. */
const CITY_HINTS = {
  MI: ['Royal Oak', 'Dearborn', 'Ann Arbor', 'Grand Rapids', 'Lansing'],
  OH: ['Columbus', 'Cleveland', 'Cincinnati', 'Toledo', 'Akron'],
  KY: ['Louisville', 'Lexington', 'Covington'],
  PA: ['Philadelphia', 'Pittsburgh', 'Allentown'],
  NY: ['Brooklyn', 'Buffalo', 'Albany'],
  TX: ['Austin', 'Houston', 'Dallas'],
  CA: ['Oakland', 'San Diego', 'Sacramento'],
  CO: ['Denver', 'Boulder', 'Fort Collins'],
};

// ---------------------------------------------------------------- question bodies
// Each returns { el, value(), valid() } and calls change() whenever the provisional answer changes.
export function bodyFor(q, current, ctx, change) {
  const states = ctx.meta.states;
  switch (q.kind) {
    case 'state': {
      let code = current || null;
      const cb = stateCombobox(states, code, (c) => { code = c; change(); });
      return { el: cb.el, value: () => code, valid: () => !!code };
    }
    case 'locations': {
      const home = ctx.answers.state || 'MI';
      const rows = (current && current.length ? current : []).map((r) => ({ ...r }));
      const pills = h('div', { class: 'chips2', style: { marginBottom: '12px' } });
      const hints = h('div', { class: 'chips2', style: { marginTop: '10px' } });
      const input = h('input', { class: 'in', placeholder: 'Add another city', 'aria-label': 'Add a city', 'data-autofocus': '' });
      const add = (name) => {
        const n = name.trim();
        if (!n || rows.some((r) => r.name.toLowerCase() === n.toLowerCase())) return;
        rows.push({ name: n, city: n, state: home });
        input.value = '';
        draw(); change();
      };
      function draw() {
        pills.replaceChildren(...rows.map((r, i) => h('span', { class: 'pill on', 'data-location': r.name }, r.name, h('small', {}, r.state), h('button', { type: 'button', class: 'pill-x', 'aria-label': `Remove ${r.name}`, onClick: () => { rows.splice(i, 1); draw(); change(); } }, icon('x', 10)))));
        hints.replaceChildren(...(CITY_HINTS[home] || []).filter((c) => !rows.some((r) => r.name === c)).map((c) => h('button', { type: 'button', class: 'pill', onClick: () => add(c) }, c)));
      }
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(input.value); } });
      draw();
      const el = h('div', {}, h('label', { class: 'lab' }, 'Where your team works'), pills,
        h('div', { class: 'addrow' }, input, Button({ variant: 'ghost', size: 'sm', onClick: () => add(input.value) }, 'Add')), hints,
        h('div', { class: 'help' }, 'City income tax follows the work location. If a city has one, it is added for you.'));
      const clean = () => rows.map((r) => ({ name: r.name, city: r.city || r.name, state: r.state }));
      return { el, value: clean, valid: () => rows.length >= 1 };
    }
    case 'team': {
      let v = current || null;
      const g = optionList(ctx.meta.teamSizes.map((t) => ({ value: t.value, label: t.label, help: t.value === '1-10' ? undefined : 'Adds bulk invite by spreadsheet' })), v, (x) => { v = x; change(); }, { label: 'Team size' });
      return { el: g.el, value: () => v, valid: () => !!v };
    }
    case 'tips': {
      let on = current ? current.on : null; let pool = current && current.on ? current.pool : 'hours';
      const poolBox = h('div', { style: { marginTop: '16px' }, hidden: on !== true });
      const yn = optionList([{ value: 'yes', label: 'Yes', help: 'Servers, bartenders, hosts, others' }, { value: 'no', label: 'No', help: 'Nobody earns tips' }], on === null ? null : on ? 'yes' : 'no', (x) => { on = x === 'yes'; poolBox.hidden = !on; change(); }, { label: 'Tipped staff' });
      const pg = optionList([{ value: 'hours', label: 'Split by hours worked', help: 'Everyone in the pool shares by hours' }, { value: 'points', label: 'Split by role', help: 'Roles carry points, like captains 3, servers 2, bussers 1' }, { value: 'none', label: 'No pool', help: 'Everyone keeps their own tips' }], pool, (x) => { pool = x; change(); }, { label: 'How tips are shared' });
      poolBox.append(h('label', { class: 'lab' }, 'How do you share tips?'), pg.el);
      return { el: h('div', {}, yn.el, poolBox), value: () => (on === null ? null : { on, pool: on ? pool : 'none' }), valid: () => on !== null };
    }
    case 'frequency': {
      let f = current ? current.value : null; let weekday = current && current.weekday ? current.weekday : 'friday';
      const dayBox = h('div', { style: { marginTop: '14px' }, hidden: !(f === 'weekly' || f === 'biweekly') });
      const wd = Field({ label: 'Which day?', select: true, value: weekday, options: WEEKDAYS.map((d) => ({ value: d, label: cap(d) })), onInput: (v) => { weekday = v; change(); } });
      dayBox.append(wd.el);
      const g = optionList([{ value: 'weekly', label: 'Weekly' }, { value: 'biweekly', label: 'Every other week' }, { value: 'semimonthly', label: 'Twice a month' }, { value: 'monthly', label: 'Monthly' }], f, (x) => { f = x; dayBox.hidden = !(x === 'weekly' || x === 'biweekly'); change(); }, { columns: 2, label: 'Pay frequency' });
      return { el: h('div', {}, g.el, dayBox), value: () => (f ? { value: f, ...(f === 'weekly' || f === 'biweekly' ? { weekday } : {}) } : null), valid: () => !!f };
    }
    case 'contractors': {
      let on = current ? current.on : null; let count = current && current.count ? current.count : 2;
      const countBox = h('div', { class: 'r2', style: { marginTop: '14px' }, hidden: on !== true });
      const cf = Field({ label: 'About how many?', type: 'number', value: String(count), inputmode: 'numeric', onInput: (v) => { count = Math.max(0, Math.min(5000, Math.floor(Number(v) || 0))); change(); } });
      countBox.append(cf.el, h('div'));
      const yn = optionList([{ value: 'yes', label: 'Yes', help: q.id === 'contractors' && ctx.industry === 'delivery_couriers' ? 'Drivers who bring their own vehicle and invoice you' : 'A plumber, a bookkeeper, a sign painter' }, { value: 'no', label: 'No', help: 'Everyone is on payroll' }], on === null ? null : on ? 'yes' : 'no', (x) => { on = x === 'yes'; countBox.hidden = !on; change(); }, { label: 'Contractors' });
      return { el: h('div', {}, yn.el, countBox), value: () => (on === null ? null : on ? { on, count } : { on }), valid: () => on !== null };
    }
    case 'departments': {
      let on = current ? current.on : null; let names = current ? current.names.join(', ') : '';
      const box = h('div', { style: { marginTop: '14px' }, hidden: on !== true });
      const nf = Field({ label: 'Department names', value: names, placeholder: 'Front desk, Housekeeping, Banquets', hint: 'Separate with commas. You can change these later.', onInput: (v) => { names = v; change(); } });
      box.append(nf.el);
      const yn = optionList([{ value: 'yes', label: 'Yes, by department' }, { value: 'no', label: 'No' }], on === null ? null : on ? 'yes' : 'no', (x) => { on = x === 'yes'; box.hidden = !on; change(); }, { columns: 2, label: 'Departments' });
      return { el: h('div', {}, yn.el, box), value: () => (on === null ? null : { on, names: on ? names.split(',').map((x) => x.trim()).filter(Boolean) : [] }), valid: () => on !== null };
    }
    case 'paytypes': {
      let v = current || null;
      const g = optionList([{ value: 'both', label: 'Both salaried and hourly' }, { value: 'hourly', label: 'Everyone is hourly' }, { value: 'salaried', label: 'Everyone is salaried' }], v, (x) => { v = x; change(); }, { label: 'How you pay people' });
      return { el: g.el, value: () => v, valid: () => !!v };
    }
    default: { // yesno
      let on = current ? current.on : (q.optional ? false : null);
      const g = optionList([{ value: 'yes', label: q.yes || 'Yes' }, { value: 'no', label: q.no || 'No' }], on === null ? null : on ? 'yes' : 'no', (x) => { on = x === 'yes'; change(); }, { columns: 2, label: q.rail });
      return { el: g.el, value: () => (on === null ? null : { on }), valid: () => on !== null };
    }
  }
}

/** The question text, with the design's italic emphasis. */
function titleFor(q, business) {
  const em = (t) => h('em', {}, t);
  switch (q.id) {
    case 'state': return q.kind === 'state' ? ['Where is ', em(business), '?'] : [q.title];
    case 'locations': return ['Where does your team ', em('work'), '?'];
    case 'team': return ['How many ', em('people'), ' do you pay?'];
    case 'tips': return ['Does anyone earn ', em('tips'), '?'];
    case 'frequency': return ['How often do you ', em('pay'), ' your team?'];
    case 'contractors': return ['Do you pay ', em('contractors'), '?'];
    default: return [q.title];
  }
}
const HELP = {
  state: 'Pick the state your team works in. We’ll add the right taxes and notices.',
  locations: 'Add each place you have a location.',
  tips: 'Tips change how pay stubs and taxes are worked out.',
  contractors: 'People you pay by invoice and send a 1099, not a paycheck.',
};

export function summarize(q, v, ctx) {
  if (v === undefined || v === null) return q.optional ? 'No' : 'Not answered';
  switch (q.kind) {
    case 'state': { const s = ctx.meta.states.find((x) => x.code === v); return s ? s.name : v; }
    case 'locations': return v.map((l) => `${l.name}${l.state !== ctx.answers.state ? `, ${l.state}` : ''}`).join(', ');
    case 'team': return (ctx.meta.teamSizes.find((t) => t.value === v) || {}).label || v;
    case 'tips': return v.on ? 'Yes' : 'No';
    case 'frequency': return { weekly: 'Weekly', biweekly: 'Every other week', semimonthly: 'Twice a month', monthly: 'Monthly' }[v.value];
    case 'contractors': return v.on ? 'Yes' : 'No';
    case 'departments': return v.on ? `Yes${v.names.length ? `: ${v.names.join(', ')}` : ''}` : 'No';
    case 'paytypes': return { both: 'Both salaried and hourly', hourly: 'Everyone is hourly', salaried: 'Everyone is salaried' }[v];
    default: return v.on ? 'Yes' : 'No';
  }
}

// ---------------------------------------------------------------- the live preview
const STAMP = () => h('svg', { class: 'stamp', viewBox: '0 0 120 120', 'aria-hidden': 'true' },
  h('defs', {}, h('path', { id: 'circ-pv', d: 'M60 60 m-44 0 a44 44 0 1 1 88 0 a44 44 0 1 1 -88 0' })),
  h('circle', { cx: 60, cy: 60, r: 55, fill: 'none', stroke: '#F0613A', 'stroke-width': 3 }),
  h('circle', { cx: 60, cy: 60, r: 33, fill: 'none', stroke: '#F0613A', 'stroke-width': 1.5 }),
  h('text', { 'font-family': 'Inter', 'font-weight': 600, 'font-size': 11.5, 'letter-spacing': 3.2, fill: '#F0613A' }, h('textPath', { href: '#circ-pv' }, 'SAMPLE DATA · SAMPLE DATA ·')),
  h('text', { x: 60, y: 66, 'text-anchor': 'middle', 'font-family': 'Fraunces', 'font-style': 'italic', 'font-size': 19, fill: '#F0613A' }, 'preview'));

function moduleCard(m, wide, newIds) {
  const isNew = newIds.has(m.id);
  return h('section', { class: `mod ${wide ? 'w2' : ''} ${isNew ? 'isnew' : ''}`, 'data-module': m.id },
    h('header', {}, h('h4', {}, m.label), isNew ? Chip(`Added: ${m.label}`, 'new') : null),
    h('ul', { class: 'ml' }, ...m.items.map((i) => {
      const fresh = newIds.has(i.id) && !isNew;
      return h('li', { class: fresh ? 'isnew' : '', 'data-item': i.id }, h('span', { class: 'lt' }, h('b', {}, i.label), h('i', {}, i.note || i.detail || '')), fresh ? Chip('new', 'new') : StatusChip(i));
    })));
}

function previewPane({ build, newIds, business, industry, note, countUp }) {
  const def = IND[industry.id] || IND.restaurant;
  const c = build.counts;
  const tabs = ['Overview', 'Payroll', 'People', def.tab];
  const mods = build.modules;
  return h('div', { class: 'pvwrap ui' },
    h('div', { class: 'pvtop' }, h('h3', {}, 'Your dashboard, as it builds'),
      h('div', { class: 'counts', 'data-testid': 'counter', 'aria-live': 'polite' }, ...[['modules', 'modules'], ['items', 'items'], ['forms', 'forms']].map(([k, l]) => h('span', { class: countUp[k] ? 'up' : '' }, h('b', { 'data-count': k }, String(c[k])), l)))),
    h('div', { class: 'hand', style: { margin: '0 0 12px 4px', fontSize: '24px', display: 'flex', gap: '6px', alignItems: 'flex-end' } }, note),
    h('div', { class: 'pv' },
      h('div', { class: 'atop' }, h('span', { class: 'org' }, h('span', { class: 'orgmark' }, (business[0] || 'T').toUpperCase()), h('b', {}, business)), h('span', { class: 'tabs' }, ...tabs.map((t, i) => h('a', { class: i === 0 ? 'on' : '' }, t)))),
      h('div', { class: 'pvb' },
        h('div', { class: 'mgrid' }, ...mods.map((m, i) => moduleCard(m, m.id === 'pay_run' || (i === mods.length - 1 && i % 2 === 1 && mods[0].id === 'pay_run'), newIds))),
        build.leftOut.length ? h('div', { class: 'mods', 'data-testid': 'left-out' }, h('span', {}, 'Left out for now:'), ...build.leftOut.map((l) => h('span', { class: `chip ${l.soon ? 'na' : ''}`, 'data-left': l.id, title: l.why }, l.label))) : h('div', { class: 'mods', 'data-testid': 'left-out' }, h('span', {}, 'Nothing left out.'))),
      STAMP()));
}

// ---------------------------------------------------------------- pick your industry
export async function industry() {
  const m = await loadMeta();
  const user = session.user;
  let pick = (user.setup && user.setup.industry) || 'restaurant';
  const grid = h('div', { class: 'indgrid ui', role: 'radiogroup', 'aria-label': 'Industry' });
  const go = Button({ size: 'lg', type: 'button' }, 'Continue');
  const labelFor = () => 'Continue';
  const draw = () => {
    grid.replaceChildren(...m.industries.map((i) => {
      const d = IND[i.id] || IND.restaurant;
      return h('a', { class: `it ${d.wide ? 'w3' : ''} ${pick === i.id ? 'on' : ''}`, href: '#', role: 'radio', 'aria-checked': String(pick === i.id), 'data-industry': i.id, tabindex: 0,
        onClick: (e) => { e.preventDefault(); pick = i.id; draw(); }, onKeydown: (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); pick = i.id; draw(); } } },
      h('span', { class: 'ic', style: { background: d.color } }, indIcon(d)), h('span', { class: 'tick' }),
      h('h3', {}, d.title[0], ' ', h('em', {}, d.title[1])), h('p', {}, d.blurb), h('div', { class: 'tags' }, ...i.tags.map((t) => Chip(t, 'line'))));
    }));
    go.firstChild.textContent = labelFor();
  };
  draw();
  go.addEventListener('click', async () => {
    setLoading(go, true);
    try {
      const prev = session.user.setup;
      const same = prev && prev.industry === pick;
      await api.put('/v1/builder/draft', { industry: pick, answers: same ? prev.answers : {}, step: same ? prev.step : 'state' });
      await refreshUser();
      navigate('/setup/builder');
    } catch (e) { toast('error', e.message); setLoading(go, false); }
  });
  const out = TextLink('Back', { onClick: async () => { await signOut(); navigate('/'); } });
  return { title: 'Your restaurant | Totali', el: h('div', {},
    h('header', { class: 'authtop ui' }, Logo(), h('span', {}, `Signed in as ${user.email}`)),
    h('div', { class: 'indhead ui' }, Steps3(2),
      h('h1', { class: 'pt', style: { fontSize: '30px' } }, 'Totali is payroll for ', h('em', {}, 'restaurants'), '.'),
      h('p', { class: 'cap', style: { marginTop: '8px', maxWidth: '560px', fontSize: '15px' } }, 'Answer a few questions about your restaurant and your dashboard is built around it: your state’s tax rules, tips, locations and pay schedule.')),
    grid,
    h('div', { class: 'indfoot ui' }, h('span'), h('div', { class: 'acts' }, out, go)),
    h('div', { style: { height: '70px' } })) };
}

// ---------------------------------------------------------------- the builder
export async function builder() {
  const m = await loadMeta();
  const setup = session.user.setup;
  if (!setup || !setup.industry) { navigate('/setup/industry', { replace: true }); return h('div'); }
  const ind = m.industries.find((i) => i.id === setup.industry);
  const def = IND[ind.id] || IND.restaurant;
  const business = session.user.businessName;
  const allQuestions = ind.questions;
  let questions = []; let stepsAll = [];
  const ctx = { meta: m, answers: { ...setup.answers }, industry: ind.id };
  /** Some questions only make sense after an earlier yes (the tip credit, once someone earns tips). */
  const rebuildSteps = () => { questions = allQuestions.filter((q) => !q.when || (ctx.answers[q.when.question] && ctx.answers[q.when.question].on === true)); stepsAll = [...questions.map((q) => ({ id: q.id, rail: q.rail })), { id: 'review', rail: 'Review' }]; };
  rebuildSteps();
  let build = null; let prevIds = new Set(); let newIds = new Set(); let prevCounts = null; let note = `Every ${def.noun} starts here`;
  let stepIdx = Math.max(0, stepsAll.findIndex((s) => s.id === setup.step));

  const left = h('div', {});
  const right = h('div', {});
  const stepper = h('ul', { class: 'stepper', 'aria-label': 'Steps' });
  const seg = h('div', { class: 'seg' });
  const progText = h('span', {});
  const save = TextLink('Save and finish later', { onClick: () => saveLater() });
  const top = h('header', { class: 'bhead ui' }, Logo({ small: true }), h('div', { class: 'prog' }, progText, seg), save);
  let token = 0;
  const idsOf = (b) => new Set(b.modules.flatMap((x) => [x.id, ...x.items.map((i) => i.id)]));
  const labelsOf = (b) => new Map(b.modules.flatMap((x) => [[x.id, x.label], ...x.items.map((i) => [i.id, i.label])]));

  function drawPreview(countUp = {}) {
    right.replaceChildren(previewPane({ build, newIds, business, industry: ind, note, countUp }));
  }

  /** Re-run the preview for a provisional answer. `commit` makes it the new baseline for "new". */
  async function refresh(answers, { commit = false, announce = true } = {}) {
    const my = ++token;
    const r = await api.post('/v1/builder/preview', { industry: ind.id, answers });
    if (my !== token) return;
    const ids = idsOf(r);
    newIds = new Set([...ids].filter((x) => !prevIds.has(x)));
    build = r;
    const up = {};
    if (prevCounts) for (const k of ['modules', 'items', 'forms']) up[k] = r.counts[k] !== prevCounts[k];
    if (!announce) { /* keep the note as it is */ } else if (newIds.size) {
      const labels = labelsOf(r);
      const firstModule = [...newIds].find((x) => r.modules.some((mm) => mm.id === x));
      note = firstModule ? `${labels.get(firstModule)} card appeared` : `${labels.get([...newIds][0])} appeared`;
    } else if (prevCounts) note = 'Nothing new to add for that answer.';
    if (commit) { prevIds = ids; prevCounts = { ...r.counts }; }
    drawPreview(up);
    drawRail();
    // The newest addition can land below the fold: bring it into view.
    const fresh = announce && newIds.size ? right.querySelector('.mod.isnew, li.isnew') : null;
    if (fresh) fresh.scrollIntoView({ block: 'nearest', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }

  function drawRail() {
    const answered = (s) => s.id !== 'review' && ctx.answers[s.id] !== undefined;
    stepper.replaceChildren(...stepsAll.map((s, i) => {
      const state = i === stepIdx ? 'cur' : answered(s) || (s.id === 'review' && false) ? 'done' : '';
      const q = questions.find((x) => x.id === s.id);
      return h('li', { class: state, 'data-step': s.id, 'aria-current': i === stepIdx ? 'step' : undefined, onClick: () => { if (state === 'done' || (s.id === 'review' && build && build.progress.ready)) go(i); }, style: state === 'done' || s.id === 'review' ? { cursor: 'pointer' } : {} }, s.rail, state === 'done' && q ? h('i', {}, summarize(q, ctx.answers[s.id], ctx)) : null);
    }));
    seg.replaceChildren(...stepsAll.map((s, i) => h('span', { class: i === stepIdx ? 'cur' : i < stepIdx ? 'on' : '' })));
    progText.textContent = stepsAll[stepIdx].id === 'review' ? 'All set' : `Question ${stepIdx + 1} of ${questions.length}`;
  }

  async function persist(step) {
    const r = await api.put('/v1/builder/draft', { industry: ind.id, answers: ctx.answers, step });
    session.user = r.user;
  }
  async function saveLater() {
    try { await persist(stepsAll[stepIdx].id); toast('success', 'Saved. Log in any time to pick up where you left off.'); navigate('/'); } catch (e) { toast('error', e.message); }
  }
  let fromReview = false; // an answer opened from the review goes straight back there
  function go(i) { stepIdx = Math.max(0, Math.min(stepsAll.length - 1, i)); drawStep(); }

  /** "This adds to your dashboard": what the current provisional answer put on the dashboard that was not there before. */
  function addsBox() {
    if (!build || newIds.size === 0) return null;
    const labels = labelsOf(build);
    const itemIds = [...newIds].filter((x) => !build.modules.some((mm) => mm.id === x));
    const names = (itemIds.length ? itemIds : [...newIds]).map((x) => labels.get(x));
    const shown = names.slice(0, 3);
    return h('div', { class: 'adds', 'data-testid': 'adds' }, h('b', {}, 'This adds to your dashboard'), h('ul', {}, ...shown.map((n) => h('li', {}, n)), names.length > 3 ? h('li', {}, `and ${names.length - 3} more`) : null));
  }

  function drawStep() {
    const s = stepsAll[stepIdx];
    drawRail();
    if (s.id === 'review') return drawReview();
    const q = questions.find((x) => x.id === s.id);
    const provisional = { ...ctx.answers };
    let body; let adds = h('div', {});
    const next = Button({ type: 'button', disabled: true }, fromReview || stepIdx === questions.length - 1 ? 'Review' : 'Continue');
    const err = h('div', {});
    const change = () => {
      next.disabled = !body.valid();
      if (body.valid()) refresh({ ...provisional, [q.id]: body.value() }).then(() => adds.replaceChildren(...[addsBox()].filter(Boolean)));
    };
    body = bodyFor(q, ctx.answers[q.id], ctx, change);
    next.disabled = !body.valid();
    next.addEventListener('click', async () => {
      err.replaceChildren();
      setLoading(next, true);
      try {
        const chk = await api.post('/v1/builder/check', { industry: ind.id, question: q.id, value: body.value() });
        if (!chk.ok) { err.append(Alert('error', chk.error)); setLoading(next, false); return; }
        ctx.answers[q.id] = chk.value;
        rebuildSteps();
        await refresh(ctx.answers, { commit: true });
        await persist(stepsAll[Math.min(stepIdx + 1, stepsAll.length - 1)].id);
        if (fromReview) { fromReview = false; go(stepsAll.length - 1); } else go(stepIdx + 1);
      } catch (e) { err.append(Alert('error', e.message)); setLoading(next, false); }
    });
    const hand = Hand(q.id === 'state' ? 'Pick your state and watch the right side.' : 'Each answer adds or removes cards.', { style: { margin: '20px 0 0 8px', fontSize: '24px', transform: 'rotate(-1.5deg)', position: 'static' } });
    left.replaceChildren(
      h('div', { class: 'qcard' },
        h('div', { class: 'qn' }, `QUESTION ${stepIdx + 1} OF ${questions.length}`),
        h('h2', { 'data-autofocus': '', tabindex: '-1' }, ...titleFor(q, business)),
        h('p', { class: 'q' }, HELP[q.id] && q.id !== 'frequency' ? HELP[q.id] : q.help),
        body.el, err, adds,
        h('div', { class: 'qfoot' }, stepIdx > 0 ? TextLink('Back', { onClick: () => { fromReview = false; go(stepIdx - 1); } }) : h('span'), next)),
      hand);
    left.querySelector('[data-autofocus]').focus();
    // Showing a step you already answered: show what it added, so Back is not a blank.
    note = stepIdx === 0 ? `Every ${def.noun} starts here` : 'Answer, and watch the right side.';
    refresh(body.valid() ? { ...provisional, [q.id]: body.value() } : provisional, { announce: false }).then(() => { if (body.valid()) adds.replaceChildren(...[addsBox()].filter(Boolean)); });
  }

  function drawReview() {
    const missingEin = true; // a company made by the builder has no EIN until Company setup
    const finish = Button({ size: 'lg', type: 'button' }, 'Build my dashboard');
    const err = h('div', {});
    finish.addEventListener('click', async () => {
      setLoading(finish, true);
      try {
        await persist('review');
        await api.post('/v1/builder/finish');
        await refreshUser();
        navigate('/app');
      } catch (e) { err.replaceChildren(Alert('error', e.message)); setLoading(finish, false); }
    });
    const c = build ? build.counts : { modules: 0, items: 0 };
    left.replaceChildren(
      h('div', { class: 'qcard' },
        h('div', { class: 'qn' }, 'ALL SET'),
        h('h2', { 'data-autofocus': '', tabindex: '-1' }, 'Your dashboard is ', h('em', {}, 'ready')),
        h('p', { class: 'q' }, 'Here’s what you told us. Change any answer and the dashboard changes with it.'),
        ...questions.map((q, i) => h('div', { class: 'row' }, h('span', { class: 'l1' }, h('b', {}, q.rail)), h('span', { 'data-review': q.id, style: { fontFamily: 'Fraunces', fontStyle: 'italic', color: 'var(--berry)' } }, summarize(q, ctx.answers[q.id], ctx)), TextLink('Edit', { onClick: () => { fromReview = true; go(i); }, 'aria-label': `Edit ${q.rail}` }))),
        err,
        h('div', { class: 'qfoot' }, TextLink('Back', { onClick: () => go(questions.length - 1) }), finish)),
      h('div', { class: 'hand', style: { margin: '18px 0 0 6px', fontSize: '25px' } }, `${c.modules} modules, ${c.items} items.${missingEin ? ' One account number still to add.' : ''}`));
    left.querySelector('[data-autofocus]').focus();
    refresh(ctx.answers, { commit: true });
  }

  await refresh(ctx.answers, { commit: true });
  newIds = new Set();
  if (stepsAll[stepIdx].id === 'review' && !build.progress.ready) stepIdx = Math.max(0, questions.findIndex((q) => ctx.answers[q.id] === undefined));
  drawStep();
  return { title: 'Build your dashboard | Totali', el: h('div', {}, top, h('main', { class: 'bgrid ui' }, stepper, left, right)) };
}
