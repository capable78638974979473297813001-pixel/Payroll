import { h } from '../dom.js';
import { api } from '../api.js';
import { navigate } from '../router.js';
import { Button, Alert, Field, Logo, Tag, icon, setLoading, toast } from '../ui.js';
import { refreshUser, session } from '../session.js';

let meta = null;
async function loadMeta() {
  if (!meta) meta = await api.get('/v1/builder/industries');
  return meta;
}

const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// ---------------------------------------------------------------- shared widgets
function choiceGrid(options, selected, onPick, { columns = 1, label } = {}) {
  const wrap = h('div', { class: `choice-grid ${columns === 2 ? 'two' : ''}`, role: 'radiogroup', 'aria-label': label });
  const draw = (sel) => {
    wrap.replaceChildren(...options.map((o) => h('button', { type: 'button', class: 'choice', role: 'radio', 'aria-checked': String(o.value === sel), onClick: () => { onPick(o.value); draw(o.value); } }, o.label, o.help ? h('small', {}, o.help) : null)));
  };
  draw(selected);
  return { el: wrap, redraw: draw };
}

function stateCombobox(states, value, onPick) {
  const input = h('input', { class: 'input', type: 'text', role: 'combobox', 'aria-expanded': 'false', 'aria-autocomplete': 'list', autocomplete: 'off', placeholder: 'Start typing, like “Mi”', 'data-autofocus': '' });
  const list = h('ul', { class: 'combo-list', role: 'listbox', hidden: true });
  let hits = []; let active = 0;
  const show = () => { list.hidden = hits.length === 0; input.setAttribute('aria-expanded', String(!list.hidden)); };
  const draw = () => {
    list.replaceChildren(...hits.map((s, i) => h('li', { role: 'option', 'aria-selected': String(i === active), onMousedown: (e) => { e.preventDefault(); pick(s); } }, h('b', {}, s.name), h('span', {}, s.code))));
    show();
  };
  function pick(s) { input.value = `${s.name} (${s.code})`; hits = []; show(); onPick(s.code); }
  function search() {
    const q = input.value.trim().toLowerCase();
    if (!q) { hits = []; show(); onPick(null); return; }
    const starts = states.filter((s) => s.name.toLowerCase().startsWith(q) || s.code.toLowerCase() === q);
    const has = states.filter((s) => !starts.includes(s) && s.name.toLowerCase().includes(q));
    hits = [...starts, ...has].slice(0, 8); active = 0; draw();
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
  if (cur) input.value = `${cur.name} (${cur.code})`;
  return { el: h('div', { class: 'combo' }, h('label', { class: 'field-label', style: { display: 'block', fontSize: '13px', fontWeight: 700, marginBottom: '8px' }, for: 'state-in' }, 'State'), input, list), input };
}

// ---------------------------------------------------------------- question bodies
// Each returns { el, value(), valid(), } and calls change() whenever the provisional answer changes.
function bodyFor(q, current, ctx, change) {
  const states = ctx.meta.states;
  switch (q.kind) {
    case 'state': {
      let code = current || null;
      const cb = stateCombobox(states, code, (c) => { code = c; change(); });
      cb.input.id = 'state-in';
      return { el: cb.el, value: () => code, valid: () => !!code };
    }
    case 'locations': {
      const home = ctx.answers.state || 'MI';
      let rows = (current && current.length ? current : [{ name: '', city: '', state: home }]).map((r) => ({ ...r }));
      const host = h('div', { class: 'stack', style: { '--gap': '16px' } });
      const draw = () => {
        host.replaceChildren(...rows.map((r, i) => {
          const name = Field({ label: i === 0 ? 'Name' : undefined, value: r.name, placeholder: i === 0 ? 'Detroit' : 'Ferndale', onInput: (v) => { r.name = v; if (!r.cityEdited) { r.city = v; city.input.value = v; } change(); } });
          const city = Field({ label: i === 0 ? 'City' : undefined, value: r.city, placeholder: 'Same as name', onInput: (v) => { r.city = v; r.cityEdited = true; change(); } });
          const st = Field({ label: i === 0 ? 'State' : undefined, select: true, value: r.state, options: states.map((s) => ({ value: s.code, label: s.code })), onInput: (v) => { r.state = v; change(); } });
          return h('div', { class: 'loc-row' }, name.el, city.el, st.el, rows.length > 1 ? h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Remove location ${i + 1}`, onClick: () => { rows.splice(i, 1); draw(); change(); } }, icon('x')) : h('span'));
        }), Button({ variant: 'secondary', size: 'md', type: 'button', onClick: () => { rows.push({ name: '', city: '', state: rows[0]?.state || home }); draw(); } }, icon('plus'), 'Add a location'));
      };
      draw();
      const clean = () => rows.filter((r) => r.name.trim()).map((r) => ({ name: r.name.trim(), city: (r.city || r.name).trim(), state: r.state }));
      return { el: host, value: clean, valid: () => clean().length >= 1 };
    }
    case 'team': {
      let v = current || null;
      const g = choiceGrid(ctx.meta.teamSizes.map((t) => ({ value: t.value, label: t.label, help: t.value === '1-10' ? undefined : 'Adds bulk invite by spreadsheet' })), v, (x) => { v = x; change(); }, { label: 'Team size' });
      return { el: g.el, value: () => v, valid: () => !!v };
    }
    case 'tips': {
      let on = current ? current.on : null; let pool = current && current.on ? current.pool : 'hours';
      const poolBox = h('div', { class: 'stack', style: { '--gap': '12px' }, hidden: on !== true });
      const yn = choiceGrid([{ value: 'yes', label: 'Yes, they earn tips' }, { value: 'no', label: 'No tips here' }], on === null ? null : on ? 'yes' : 'no', (x) => { on = x === 'yes'; poolBox.hidden = !on; change(); }, { columns: 2, label: 'Tipped staff' });
      const pg = choiceGrid([{ value: 'hours', label: 'Pool split by hours', help: 'Everyone in the pool shares by hours worked' }, { value: 'points', label: 'Pool split by role', help: 'Roles carry points, like captains 3, servers 2, bussers 1' }, { value: 'none', label: 'No pool', help: 'Everyone keeps their own tips' }], pool, (x) => { pool = x; change(); }, { label: 'How tips are shared' });
      poolBox.append(h('p', { class: 'label-mono', style: { margin: 0 } }, 'How do you share tips?'), pg.el);
      return { el: h('div', { class: 'stack', style: { '--gap': '24px' } }, yn.el, poolBox), value: () => (on === null ? null : { on, pool: on ? pool : 'none' }), valid: () => on !== null };
    }
    case 'frequency': {
      let f = current ? current.value : null; let weekday = current && current.weekday ? current.weekday : 'friday';
      const dayBox = h('div', { hidden: !(f === 'weekly' || f === 'biweekly') });
      const wd = Field({ label: 'Which day?', select: true, value: weekday, options: WEEKDAYS.map((d) => ({ value: d, label: cap(d) })), onInput: (v) => { weekday = v; change(); } });
      dayBox.append(wd.el);
      const g = choiceGrid([{ value: 'weekly', label: 'Weekly' }, { value: 'biweekly', label: 'Every other week' }, { value: 'semimonthly', label: 'Twice a month' }, { value: 'monthly', label: 'Monthly' }], f, (x) => { f = x; dayBox.hidden = !(x === 'weekly' || x === 'biweekly'); change(); }, { columns: 2, label: 'Pay frequency' });
      return { el: h('div', { class: 'stack', style: { '--gap': '24px' } }, g.el, dayBox), value: () => (f ? { value: f, ...(f === 'weekly' || f === 'biweekly' ? { weekday } : {}) } : null), valid: () => !!f };
    }
    case 'contractors': {
      let on = current ? current.on : null; let count = current && current.count ? current.count : 2;
      const countBox = h('div', { hidden: on !== true });
      const cf = Field({ label: 'About how many?', type: 'number', value: String(count), inputmode: 'numeric', onInput: (v) => { count = Math.max(0, Math.min(5000, Math.floor(Number(v) || 0))); change(); } });
      countBox.append(cf.el);
      const yn = choiceGrid([{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }], on === null ? null : on ? 'yes' : 'no', (x) => { on = x === 'yes'; countBox.hidden = !on; change(); }, { columns: 2, label: 'Contractors' });
      return { el: h('div', { class: 'stack', style: { '--gap': '24px' } }, yn.el, countBox), value: () => (on === null ? null : on ? { on, count } : { on }), valid: () => on !== null };
    }
    case 'departments': {
      let on = current ? current.on : null; let names = current ? current.names.join(', ') : '';
      const box = h('div', { hidden: on !== true });
      const nf = Field({ label: 'Department names', value: names, placeholder: 'Front desk, Housekeeping, Banquets', hint: 'Separate with commas. You can change these later.', onInput: (v) => { names = v; change(); } });
      box.append(nf.el);
      const yn = choiceGrid([{ value: 'yes', label: 'Yes, by department' }, { value: 'no', label: 'No' }], on === null ? null : on ? 'yes' : 'no', (x) => { on = x === 'yes'; box.hidden = !on; change(); }, { columns: 2, label: 'Departments' });
      return { el: h('div', { class: 'stack', style: { '--gap': '24px' } }, yn.el, box), value: () => (on === null ? null : { on, names: on ? names.split(',').map((x) => x.trim()).filter(Boolean) : [] }), valid: () => on !== null };
    }
    case 'paytypes': {
      let v = current || null;
      const g = choiceGrid([{ value: 'both', label: 'Both salaried and hourly' }, { value: 'hourly', label: 'Everyone is hourly' }, { value: 'salaried', label: 'Everyone is salaried' }], v, (x) => { v = x; change(); }, { label: 'How you pay people' });
      return { el: g.el, value: () => v, valid: () => !!v };
    }
    default: { // yesno
      let on = current ? current.on : null;
      const g = choiceGrid([{ value: 'yes', label: q.yes || 'Yes' }, { value: 'no', label: q.no || 'No' }], on === null ? null : on ? 'yes' : 'no', (x) => { on = x === 'yes'; change(); }, { columns: 2, label: q.rail });
      return { el: g.el, value: () => (on === null ? null : { on }), valid: () => on !== null };
    }
  }
}

function summarize(q, v, ctx) {
  if (v === undefined || v === null) return 'Not answered';
  switch (q.kind) {
    case 'state': { const s = ctx.meta.states.find((x) => x.code === v); return s ? s.name : v; }
    case 'locations': return v.map((l) => `${l.name}${l.state !== ctx.answers.state ? `, ${l.state}` : ''}`).join(' and ');
    case 'team': return (ctx.meta.teamSizes.find((t) => t.value === v) || {}).label || v;
    case 'tips': return !v.on ? 'No tips' : v.pool === 'hours' ? 'Yes, pool split by hours' : v.pool === 'points' ? 'Yes, pool split by role' : 'Yes, no pool';
    case 'frequency': return v.weekday ? `${{ weekly: 'Weekly', biweekly: 'Every other week' }[v.value]}, paid ${cap(v.weekday)}s` : { semimonthly: 'Twice a month', monthly: 'Monthly' }[v.value];
    case 'contractors': return v.on ? `Yes${v.count ? `, about ${v.count}` : ''}` : 'No';
    case 'departments': return v.on ? `Yes${v.names.length ? `: ${v.names.join(', ')}` : ''}` : 'No';
    case 'paytypes': return { both: 'Both salaried and hourly', hourly: 'Everyone is hourly', salaried: 'Everyone is salaried' }[v];
    default: return v.on ? 'Yes' : 'No';
  }
}

// ---------------------------------------------------------------- the live preview
function previewCard(m, newIds) {
  const isNew = newIds.has(m.id);
  return h('article', { class: `pv-card ${isNew ? 'is-new' : ''}`, 'data-module': m.id },
    h('h3', {}, m.label, isNew ? h('span', { class: 'new-chip' }, 'New') : null),
    h('p', {}, m.blurb),
    h('ul', { class: 'pv-items' }, ...m.items.map((i) => h('li', { 'data-item': i.id }, i.label, i.form ? h('span', { class: 'form-tag' }, 'FORM') : null, newIds.has(i.id) && !isNew ? h('span', { class: 'new-chip' }, 'New') : null, i.detail ? h('small', {}, i.detail) : null))));
}

function previewPane(build, newIds) {
  const c = build.counts;
  return h('div', {},
    h('div', { class: 'pv-head' },
      h('div', {}, h('p', { class: 'label-mono muted', style: { margin: 0 } }, 'Your dashboard'), h('h2', { class: 't-title', style: { margin: '4px 0 0' } }, 'Built as you answer')),
      h('div', { class: 'pv-counter', 'data-testid': 'counter', 'aria-live': 'polite' }, ...[['modules', 'Modules'], ['items', 'Items'], ['forms', 'Forms']].map(([k, l]) => h('div', {}, h('b', { 'data-count': k }, String(c[k])), h('span', {}, l))))),
    h('div', { class: 'pv-grid' }, ...build.modules.map((m) => previewCard(m, newIds))),
    build.leftOut.length ? h('div', { class: 'left-out', 'data-testid': 'left-out' }, h('p', { class: 'label-mono muted', style: { margin: 0 } }, 'Left out for now'), h('div', { class: 'chips' }, ...build.leftOut.map((l) => h('span', { class: 'chip', 'data-left': l.id }, l.label, h('small', {}, l.why))))) : h('div', { class: 'left-out' }, h('p', { class: 'label-mono muted', style: { margin: 0 } }, 'Nothing left out')));
}

// ---------------------------------------------------------------- B: pick your industry
export async function industry() {
  const m = await loadMeta();
  let pick = (session.user.setup && session.user.setup.industry) || null;
  const cards = h('div', { class: 'ind-pick', role: 'radiogroup', 'aria-label': 'Industry' });
  const go = Button({ variant: 'primary', arrow: true, disabled: !pick, type: 'button' }, pick ? `Continue with ${m.industries.find((i) => i.id === pick).pickLabel}` : 'Continue');
  const draw = () => {
    cards.replaceChildren(...m.industries.map((i) => h('button', { type: 'button', class: 'ind-option', role: 'radio', 'aria-checked': String(pick === i.id), 'data-industry': i.id, onClick: () => { pick = i.id; draw(); } }, h('h2', {}, i.label), h('div', { class: 'tags' }, ...i.tags.map((t) => h('span', {}, t))))));
    go.disabled = !pick;
    go.firstChild.textContent = pick ? `Continue with ${m.industries.find((i) => i.id === pick).pickLabel}` : 'Continue';
  };
  draw();
  go.addEventListener('click', async () => {
    setLoading(go, true);
    try {
      const prev = session.user.setup;
      const answers = prev && prev.industry === pick ? prev.answers : {};
      await api.put('/v1/builder/draft', { industry: pick, answers, step: prev && prev.industry === pick ? prev.step : 'state' });
      await refreshUser();
      navigate('/setup/builder');
    } catch (e) { toast('error', e.message); setLoading(go, false); }
  });
  return { title: 'Pick your industry — Totali', el: h('div', {}, h('header', { class: 'topbar' }, h('div', { class: 'wrap' }, Logo(), h('span', { class: 'micro' }, `Step 03 of 03 · Your business`))),
    h('main', { class: 'ind-page' }, h('p', { class: 'eyebrow', style: { color: 'var(--color-cobalt)' } }, 'Your business'), h('h1', { class: 't-heading-lg', style: { marginTop: '16px' } }, 'Pick your industry.'), h('p', { class: 't-lead', style: { marginTop: '16px', maxWidth: '620px' } }, 'Each one starts with the parts that kind of business needs.'), cards,
      h('div', { class: 'row', style: { marginTop: '40px', gap: '24px', flexWrap: 'wrap' } }, go, h('span', { class: 't-small muted' }, 'Not sure? Pick the closest. You can change it later.')))) };
}

// ---------------------------------------------------------------- C: the builder
export async function builder() {
  const m = await loadMeta();
  const setup = session.user.setup;
  if (!setup || !setup.industry) { navigate('/setup/industry', { replace: true }); return h('div'); }
  const ind = m.industries.find((i) => i.id === setup.industry);
  const questions = ind.questions;
  const stepsAll = [...questions.map((q) => ({ id: q.id, rail: q.rail })), { id: 'review', rail: 'Review' }];
  const ctx = { meta: m, answers: { ...setup.answers } };
  let build = null; let prevIds = new Set(); let newIds = new Set();
  let stepIdx = Math.max(0, stepsAll.findIndex((s) => s.id === setup.step));
  if (setup.step === 'state' && Object.keys(ctx.answers).length === 0) stepIdx = 0;

  const root = h('div', {});
  const left = h('div', { class: 'setup-left' });
  const right = h('div', { class: 'setup-right', 'aria-label': 'Live dashboard preview' });
  let token = 0;
  const idsOf = (b) => new Set(b.modules.flatMap((x) => [x.id, ...x.items.map((i) => i.id)]));

  async function refresh(answers, { commit = false } = {}) {
    const my = ++token;
    const r = await api.post('/v1/builder/preview', { industry: ind.id, answers });
    if (my !== token) return;
    const ids = idsOf(r);
    newIds = new Set([...ids].filter((x) => !prevIds.has(x)));
    build = r;
    if (commit) prevIds = ids;
    right.replaceChildren(previewPane(build, newIds));
    drawRail();
    // The newest addition can land below the fold: bring it into view.
    const fresh = right.querySelector('.is-new, .new-chip');
    if (fresh && commit === false && newIds.size) fresh.scrollIntoView({ block: 'nearest', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }

  const rail = h('div', { class: 'rail', role: 'list' });
  const save = Button({ variant: 'secondary', size: 'sm', type: 'button' }, 'Save and finish later');
  const top = h('header', { class: 'setup-top' }, Logo(), rail, save);
  function drawRail() {
    rail.replaceChildren(...stepsAll.map((s, i) => {
      const answered = s.id === 'review' ? false : ctx.answers[s.id] !== undefined;
      const state = i === stepIdx ? 'current' : answered ? 'done' : 'todo';
      return h('button', { class: `rail-step ${state}`, role: 'listitem', type: 'button', 'aria-current': i === stepIdx ? 'step' : undefined, disabled: s.id === 'review' && !(build && build.progress.ready), onClick: () => go(i), 'data-step': s.id }, h('div', { class: 'bar' }), h('div', { class: 'lab' }, s.rail));
    }));
  }

  async function persist(step) {
    const r = await api.put('/v1/builder/draft', { industry: ind.id, answers: ctx.answers, step });
    session.user = r.user;
  }

  save.addEventListener('click', async () => {
    setLoading(save, true);
    try { await persist(stepsAll[stepIdx].id); toast('success', 'Saved. Log in any time to pick up where you left off.'); navigate('/'); } catch (e) { toast('error', e.message); setLoading(save, false); }
  });

  async function go(i) {
    stepIdx = Math.max(0, Math.min(stepsAll.length - 1, i));
    drawStep();
  }

  function drawStep() {
    const s = stepsAll[stepIdx];
    drawRail();
    if (s.id === 'review') return drawReview();
    const q = questions.find((x) => x.id === s.id);
    const provisional = { ...ctx.answers };
    let body;
    const next = Button({ variant: 'primary', arrow: true, type: 'button', disabled: true }, stepIdx === questions.length - 1 ? 'Review' : 'Continue');
    const err = h('div', {});
    const change = () => {
      next.disabled = !body.valid();
      const v = body.value();
      if (body.valid()) refresh({ ...provisional, [q.id]: v });
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
        await refresh(ctx.answers, { commit: true });
        const target = stepIdx + 1;
        await persist(stepsAll[Math.min(target, stepsAll.length - 1)].id);
        go(target);
      } catch (e) { err.append(Alert('error', e.message)); setLoading(next, false); }
    });
    left.replaceChildren(
      h('p', { class: 'label-mono q-eyebrow' }, `Question ${stepIdx + 1} of ${questions.length}`),
      h('h1', { class: 't-heading-md q-title', 'data-autofocus': '', tabindex: '-1' }, q.title),
      h('p', { class: 't-lead q-help' }, q.help),
      h('div', { class: 'q-body' }, body.el, err),
      h('div', { class: 'q-nav' }, stepIdx > 0 ? Button({ variant: 'text', type: 'button', onClick: () => go(stepIdx - 1) }, 'Back') : null, next));
    left.querySelector('[data-autofocus]').focus();
  }

  function drawReview() {
    const missing = [];
    if (build && build.progress.ready) missing.push('Your EIN');
    const build_ = Button({ variant: 'primary', arrow: true, type: 'button' }, 'Build my dashboard');
    const err = h('div', {});
    build_.addEventListener('click', async () => {
      setLoading(build_, true);
      try {
        await persist('review');
        await api.post('/v1/builder/finish');
        await refreshUser();
        navigate('/app');
      } catch (e) { err.replaceChildren(Alert('error', e.message)); setLoading(build_, false); }
    });
    left.replaceChildren(
      h('p', { class: 'label-mono q-eyebrow' }, 'Review'),
      h('h1', { class: 't-heading-md q-title', 'data-autofocus': '', tabindex: '-1' }, 'Your dashboard is ready.'),
      h('p', { class: 't-lead q-help' }, 'This is everything you told us. Change any answer and the dashboard changes with it.'),
      h('div', { style: { marginTop: '32px' } }, ...questions.map((q, i) => h('div', { class: 'review-row' }, h('span', { class: 'k' }, q.rail), h('span', { 'data-review': q.id }, summarize(q, ctx.answers[q.id], ctx)), h('button', { class: 'btn btn-text btn-sm', type: 'button', onClick: () => go(i) }, 'Edit')))),
      missing.length ? h('div', { style: { marginTop: '24px' } }, Alert('info', 'One account number is still missing.', 'Your EIN. You add it in Company setup before your first payroll.')) : null,
      err,
      h('div', { class: 'q-nav' }, Button({ variant: 'text', type: 'button', onClick: () => go(questions.length - 1) }, 'Back'), build_));
    left.querySelector('[data-autofocus]').focus();
  }

  root.append(top, h('div', { class: 'setup-body' }, left, right));
  await refresh(ctx.answers, { commit: true });
  prevIds = idsOf(build);
  newIds = new Set();
  right.replaceChildren(previewPane(build, newIds));
  if (stepsAll[stepIdx].id === 'review' && !build.progress.ready) stepIdx = Math.max(0, questions.findIndex((q) => ctx.answers[q.id] === undefined));
  drawStep();
  return { title: 'Build your dashboard — Totali', el: root };
}
