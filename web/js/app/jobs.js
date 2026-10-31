import { h, money, shortDate, hoursFromMinutes, plural } from '../dom.js';
import { api } from '../api.js';
import { navigate } from '../router.js';
import { Button, Alert, Chip, Field, modal, setLoading, toast } from '../ui.js';
import { dollarsToCents, hoursToMinutes, who } from './payroll.js';
import { appPage } from './shell.js';
import { app, base, refreshData } from './state.js';

const centsText = (c) => (c / 100).toFixed(2);

function jobModal(job, done) {
  const name = Field({ label: 'Job name', name: 'name', value: job ? job.name : '', autofocus: true });
  const budget = Field({ label: 'Labor budget', name: 'budget', value: job && job.budgetCents ? centsText(job.budgetCents) : '', placeholder: '18,400.00', inputmode: 'decimal', hint: 'Leave blank to track hours without a budget.' });
  const pw = h('input', { type: 'checkbox', name: 'prevailing', checked: !!(job && job.prevailingWage) });
  const codes = (job ? job.rawCodes : []).map((c) => ({ ...c }));
  const list = h('div', { class: 'stack', style: { '--gap': '8px' } });
  const drawCodes = () => list.replaceChildren(...codes.map((c, i) => h('div', { class: 'tab-row', style: { gridTemplateColumns: '80px 1fr 110px auto' }, 'data-code-row': i },
    h('input', { class: 'in', value: c.code, placeholder: '01', 'aria-label': `Code ${i + 1}`, onInput: (e) => { c.code = e.target.value; } }),
    h('input', { class: 'in', value: c.label, placeholder: 'Rough-in', 'aria-label': `Name of code ${i + 1}`, onInput: (e) => { c.label = e.target.value; } }),
    h('input', { class: 'in', value: c.budgetCents ? centsText(c.budgetCents) : '', placeholder: 'Budget', inputmode: 'decimal', 'aria-label': `Budget of code ${i + 1}`, onInput: (e) => { c.budget = e.target.value; } }),
    h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Remove code ${i + 1}`, onClick: () => { codes.splice(i, 1); drawCodes(); } }, '×'))));
  drawCodes();
  const err = h('div', {}); const go = Button({}, job ? 'Save job' : 'Add job');
  const m = modal({ title: job ? `Edit ${job.name}` : 'Add a job', body: h('div', { class: 'f' }, name.el, budget.el, h('label', { class: 'ck2' }, pw, h('span', { class: 'cb' }), h('span', { class: 'fine' }, 'Prevailing wage applies to this job')),
    h('div', {}, h('label', { class: 'lab' }, 'Cost codes ', h('small', {}, '(optional)')), list, h('div', { style: { marginTop: '8px' } }, Button({ variant: 'ghost', size: 'sm', type: 'button', onClick: () => { codes.push({ code: '', label: '', budgetCents: 0 }); drawCodes(); } }, 'Add a cost code'))), err), actions: [Button({ variant: 'ghost', onClick: () => m.close() }, 'Cancel'), go] });
  go.addEventListener('click', async () => {
    err.replaceChildren();
    const b = budget.value.trim() ? dollarsToCents(budget.value) : 0;
    if (b === null) return budget.setError('Enter dollars, like 18400.00.');
    const costCodes = [];
    for (const c of codes) { if (!c.code.trim() && !c.label.trim()) continue; const cb = c.budget !== undefined ? (c.budget.trim() ? dollarsToCents(c.budget) : 0) : c.budgetCents; if (cb === null) return err.replaceChildren(Alert('error', `Cost code ${c.code}: the budget isn’t a number.`)); costCodes.push({ code: c.code.trim(), label: c.label.trim() || c.code.trim(), budgetCents: cb }); }
    setLoading(go, true);
    try {
      const body = { name: name.value, budgetCents: b, prevailingWage: pw.checked, costCodes };
      if (job) await api.patch(`${base()}/jobs/${job.id}`, body); else await api.post(`${base()}/jobs`, body);
      m.close(); toast('success', 'Saved.'); done();
    } catch (e) { if (e.details && e.details.field === undefined && /name|job/i.test(e.message)) name.setError(e.message); else err.replaceChildren(Alert('error', e.message)); setLoading(go, false); }
  });
}

function logModal(r, done) {
  const people = app.data.people;
  const emp = Field({ label: 'Who', name: 'employeeId', select: true, value: people[0] && people[0].id, options: people.map((p) => ({ value: p.id, label: p.name })) });
  const date = Field({ label: 'Day', name: 'date', type: 'date', value: new Date().toISOString().slice(0, 10) });
  const hours = Field({ label: 'Hours', name: 'hours', placeholder: '8', inputmode: 'decimal' });
  const job = Field({ label: 'Job', name: 'jobId', select: true, value: r.jobs[0].id, options: r.jobs.map((j) => ({ value: j.id, label: j.name })) });
  const code = Field({ label: 'Cost code', name: 'costCode', select: true, value: '', options: [{ value: '', label: 'No cost code' }] });
  const setCodes = () => { const j = r.jobs.find((x) => x.id === job.value); code.input.replaceChildren(...[{ value: '', label: 'No cost code' }, ...j.rawCodes.map((c) => ({ value: c.code, label: `${c.code} ${c.label}` }))].map((o) => h('option', { value: o.value }, o.label))); };
  setCodes(); job.input.addEventListener('change', setCodes);
  const err = h('div', {}); const go = Button({}, 'Save hours');
  const m = modal({ title: 'Log hours to a job', body: h('div', { class: 'f' }, h('p', { class: 'fine', style: { margin: 0 } }, 'Saving the same person, day, job and code again replaces it. Enter 0 to remove it.'), emp.el, h('div', { class: 'r2' }, date.el, hours.el), job.el, code.el, err), actions: [Button({ variant: 'ghost', onClick: () => m.close() }, 'Cancel'), go] });
  go.addEventListener('click', async () => {
    const mins = hoursToMinutes(hours.value);
    if (mins === null || mins > 1440 || hours.value.trim() === '') return hours.setError('Hours must be a number from 0 to 24.');
    setLoading(go, true);
    try { await api.post(`${base()}/jobs/log`, { employeeId: emp.value, date: date.value, minutes: mins, jobId: job.value, costCode: code.value }); m.close(); toast('success', 'Saved.'); done(); } catch (e) { err.replaceChildren(Alert('error', e.message)); setLoading(go, false); }
  });
}

export function jobsPage() {
  return async (ctx) => appPage(ctx, { active: 'time', title: 'Job costing', render: async () => {
    await refreshData();
    const start = app.data.hours.weekStart; const end = app.data.hours.weekEnd;
    const r = await api.get(`${base()}/jobs/report?start=${start}&end=${end}`);
    const redraw = () => navigate(location.pathname + location.search);
    let selected = r.jobs.find((j) => j.over) || r.jobs[0] || null;
    const side = h('div', { class: 'grid' });
    const bars = h('div', {});
    const drawSide = () => {
      if (!selected) return side.replaceChildren(h('div', { class: 'card' }, h('div', { class: 'empty' }, 'Add a job to see its cost codes here.')));
      const j = selected;
      side.replaceChildren(
        h('div', { class: 'card' }, h('div', { class: 'ch' }, h('h3', { class: 'ct' }, j.name), h('span', { style: { display: 'flex', gap: '8px', alignItems: 'center' } }, j.prevailingWage ? Chip('Prevailing wage', 'berry') : null, h('button', { class: 'link as-button', type: 'button', 'data-edit-job': j.id, onClick: () => jobModal(j, redraw) }, 'Edit'), h('button', { class: 'link as-button', type: 'button', onClick: async () => { try { await api.del(`${base()}/jobs/${j.id}`); toast('success', 'Job closed. Its hours stay in your records.'); redraw(); } catch (e) { toast('error', e.message); } } }, 'Close job'))),
          j.costCodes.length ? h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, h('th', { class: 'l' }, 'Cost code'), h('th', {}, 'Hours'), h('th', {}, 'Labor'), h('th', {}, 'Budget'), h('th', {}))), h('tbody', {}, ...j.costCodes.map((c) => h('tr', {}, h('td', { class: 'l' }, c.code === '—' ? c.label : `${c.code} ${c.label}`), h('td', {}, hoursFromMinutes(c.minutes) || '0'), h('td', {}, money(c.costCents)), h('td', {}, c.budgetCents ? money(c.budgetCents) : '–'), h('td', {}, c.over ? Chip('Over', 'warn') : null))))) : h('div', { class: 'empty' }, 'No cost codes on this job. Edit it to add some, or log hours without one.')),
        j.over ? h('div', { class: 'alert' }, h('span', { class: 'dot' }), h('span', {}, h('b', {}, `${j.name} is ${j.pct - 100}% over its labor budget`), ` (${money(j.spentCents)} of ${money(j.budgetCents)}).`)) : null);
    };
    const drawBars = () => bars.replaceChildren(...(r.jobs.length ? r.jobs.map((j) => h('div', { class: 'jc', 'data-job': j.id, style: { cursor: 'pointer', outline: selected && selected.id === j.id ? '2px solid var(--berry)' : 'none', outlineOffset: '4px', borderRadius: '6px' }, onClick: () => { selected = j; drawBars(); drawSide(); } },
      h('span', {}, h('b', {}, j.name), h('br'), h('span', { class: 'cap' }, j.budgetCents ? `Budget ${money(j.budgetCents)}` : 'No budget')), h('div', { class: 'jbar' }, h('span', { class: j.over ? 'over' : '', style: { width: `${j.pct === null ? 0 : Math.min(100, j.pct)}%` } }), h('b', { style: { left: '100%' } })), h('span', { class: 'right' }, h('b', {}, j.pct === null ? '–' : `${j.pct}%`), h('br'), h('span', { class: 'cap' }, money(j.spentCents))))) : [h('div', { class: 'empty' }, 'No jobs yet. Add one, then log hours to it.')]));
    drawBars(); drawSide();
    const stat = (l, v) => h('div', {}, h('i', {}, l), h('b', {}, v));
    return h('div', {}, h('div', { class: 'ph2' }, h('div', {}, h('h1', { class: 'pt' }, 'Job ', h('em', {}, 'costing')), h('p', {}, `${app.data.company.name} · Week of ${shortDate(start)}`)),
      h('div', { class: 'acts' }, Button({ variant: 'ghost', size: 'sm', type: 'button', 'data-testid': 'add-job', onClick: () => jobModal(null, redraw) }, 'Add job'), Button({ variant: 'ghost', size: 'sm', type: 'button', disabled: !r.jobs.length, 'data-testid': 'log-hours', onClick: () => logModal(r, redraw) }, 'Log hours'), Button({ size: 'sm', type: 'button', disabled: !r.jobs.length, onClick: async () => { try { await api.download(`${base()}/jobs/export?start=${start}&end=${end}`, `job-costing-${start}.csv`); } catch (e) { toast('error', e.message); } } }, 'Export for the week'))),
      h('div', { style: { marginBottom: '18px' } }, h('div', { class: 'stats' }, stat('Active jobs', String(r.stats.activeJobs)), stat('Labor this week', money(r.stats.periodLaborCents)), stat('Over budget', String(r.stats.overBudget)), stat('Prevailing wage jobs', String(r.stats.prevailingWage)))),
      h('div', { class: 'grid', style: { gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', alignItems: 'start' } }, h('div', { class: 'card' }, h('div', { class: 'ch' }, h('h3', { class: 'ct' }, 'Labor against budget'), h('span', { class: 'cap' }, 'Line shows 100% of budget')), bars), side),
      h('p', { class: 'cap', style: { marginTop: '14px', maxWidth: '70ch' } }, r.note));
  } });
}
