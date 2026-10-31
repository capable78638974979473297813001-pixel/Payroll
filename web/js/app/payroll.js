import { h, money, longDate, shortDate, plural, hoursFromMinutes } from '../dom.js';
import { api } from '../api.js';
import { link, navigate } from '../router.js';
import { Button, Alert, Chip, Field, modal, setLoading, toast } from '../ui.js';
import { session } from '../session.js';
import { appPage } from './shell.js';
import { app, base, refreshData } from './state.js';

// ---------------------------------------------------------------- small pieces shared by the payroll screens
const initials = (name) => name.split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
export const who = (name, sub) => h('div', { class: 'who' }, h('span', { class: 'av' }, initials(name)), h('span', {}, h('b', {}, name), sub ? h('i', {}, sub) : null));
const year = (iso) => iso.slice(0, 4);
export const rangeLabel = (a, b) => `${shortDate(a)} to ${shortDate(b)}, ${year(b)}`;
const FREQ = { weekly: 'Weekly', biweekly: 'Every other week', semimonthly: 'Twice a month', monthly: 'Monthly' };
const legal = () => h('div', { class: 'legal ui' }, h('p', {}, 'Totali is a product of OMNIA TAX LLC. Tax amounts are calculated by the Omnia.tax engine.'));

const STEPS = ['Pick period', 'Hours and tips', 'Review', 'Approve'];
function pstep(current) {
  const kids = [];
  STEPS.forEach((s, i) => {
    kids.push(h('span', { class: i < current ? 'done' : i === current ? 'on' : '', 'data-n': String(i + 1), 'aria-current': i === current ? 'step' : undefined }, s));
    if (i < STEPS.length - 1) kids.push(h('i'));
  });
  return h('div', { class: 'pstep', role: 'list', 'aria-label': 'Pay run steps' }, ...kids);
}
const pageHead = (title, sub, ...acts) => h('div', { class: 'ph2' }, h('div', {}, h('h1', { class: 'pt' }, ...title), sub ? h('p', {}, sub) : null), h('div', { class: 'acts' }, ...acts));

/** "6.5" or "6:30" or "" to minutes. Returns null for anything that is not a non-negative number of hours. */
export function hoursToMinutes(text) {
  const s = String(text).trim();
  if (s === '') return 0;
  const colon = /^(\d+):([0-5]\d)$/.exec(s);
  if (colon) return Number(colon[1]) * 60 + Number(colon[2]);
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  return Math.round(Number(s) * 60);
}
export function dollarsToCents(text) {
  const s = String(text).trim().replace(/^\$/, '').replace(/,/g, '');
  if (s === '') return 0;
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  return Math.round(Number(s) * 100);
}
const minutesText = (m) => (m === 0 ? '0' : hoursFromMinutes(m));
const centsText = (c) => (c / 100).toFixed(2);

/** A small CSV reader: quoted fields, commas, newlines inside quotes. */
export function parseCsv(text) {
  const rows = []; let row = []; let cur = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cur); cur = ''; if (row.some((x) => x.trim() !== '')) rows.push(row); row = []; }
    else cur += ch;
  }
  row.push(cur); if (row.some((x) => x.trim() !== '')) rows.push(row);
  return rows;
}

// ---------------------------------------------------------------- 1 and 2: pick the period, then hours and tips
export function runPayrollPage() {
  return async (ctx) => appPage(ctx, { active: 'payroll', title: 'Run payroll', render: async ({ data }) => {
    await refreshData();
    const q = ctx.query;
    if (q.get('start') && q.get('end') && q.get('check')) return hoursStep({ periodStart: q.get('start'), periodEnd: q.get('end'), checkDate: q.get('check') }, app.data);
    if (q.get('start')) {
      // A link from a card knows the start only: find the rest in the schedule.
      const r = await api.get(`${base()}/payroll/periods`);
      const hit = r.periods.find((p) => p.periodStart === q.get('start'));
      if (hit && hit.state !== 'paid') return hoursStep(hit, app.data);
    }
    return pickStep(data || app.data);
  } });
}

async function pickStep(data) {
  const r = await api.get(`${base()}/payroll/periods`);
  const next = data.nextPayday.period;
  let pick = r.periods.find((p) => p.periodStart === next.periodStart && p.state !== 'paid') || r.periods.find((p) => p.state !== 'paid');
  const list = h('div', { class: 'opts', role: 'radiogroup', 'aria-label': 'Pay period' });
  const go = Button({ size: 'lg', type: 'button' }, 'Continue');
  const status = (p) => (p.state === 'paid' ? 'Paid' : p.state === 'in_progress' ? 'Run started' : p.current ? 'Still open' : 'Ready to run');
  const draw = () => {
    list.replaceChildren(...r.periods.map((p) => h('button', { type: 'button', class: `opt ${pick && pick.periodStart === p.periodStart ? 'on' : ''}`, role: 'radio', 'aria-checked': String(!!pick && pick.periodStart === p.periodStart), disabled: p.state === 'paid', 'data-period': p.periodStart, onClick: () => { pick = p; draw(); } },
      h('span', { class: 'rd' }), h('span', {}, rangeLabel(p.periodStart, p.periodEnd), h('small', {}, `Pay date ${longDate(p.checkDate)} · ${status(p)}`)),
      p.periodStart === next.periodStart && p.state !== 'paid' ? h('em', {}, 'Next') : null)));
    go.disabled = !pick;
    go.firstChild.textContent = pick && pick.state === 'in_progress' ? 'Continue this run' : 'Continue';
  };
  draw();
  go.addEventListener('click', async () => {
    if (!pick) return;
    if (pick.state === 'in_progress' && pick.runId) return navigate(`/app/payroll/runs/${pick.runId}`);
    navigate(`/app/payroll/run?start=${pick.periodStart}&end=${pick.periodEnd}&check=${pick.checkDate}`);
  });
  return h('div', {}, pageHead(['Run ', h('em', {}, 'payroll')], `${FREQ[data.company.schedule.frequency] || 'Pay'} pay run for ${data.company.name}`), pstep(0),
    h('div', { class: 'card', style: { maxWidth: '640px', marginTop: '18px' } }, h('div', { class: 'ch' }, h('h3', { class: 'ct' }, 'Which pay period?'), h('span', { class: 'cap' }, 'Your pay schedule picks these.')), list,
      h('div', { class: 'acts', style: { justifyContent: 'flex-end', marginTop: '18px' } }, go)), legal());
}

async function hoursStep(period, data) {
  const week = await api.get(`${base()}/time/week?start=${period.periodStart}&end=${period.periodEnd}`);
  const weeks = Math.max(1, Math.ceil((Math.round((Date.parse(`${period.periodEnd}T12:00:00Z`) - Date.parse(`${period.periodStart}T12:00:00Z`)) / 86_400_000) + 1) / 7));
  const capMinutes = 2400 * weeks;
  // bonuses, commissions and reimbursements for this run live on its draft, if there is one
  const hasExtras = app.data.built.modules.some((m) => m.items.some((i) => i.id === 'bonus_pay'));
  const earlier = (await api.get(`${base()}/pay-runs`)).payRuns.find((x) => x.status === 'draft' && x.periodStart === period.periodStart && x.periodEnd === period.periodEnd);
  let adjustments = earlier ? (await api.get(`${base()}/pay-runs/${earlier.id}`)).adjustments : [];
  const rows = week.people.map((p) => ({ ...p, reg: minutesText(p.regularMinutes), ot: minutesText(p.overtimeMinutes), tips: centsText(p.tipsCents), errors: {} }));
  const tbody = h('tbody', {});
  const tipsTotal = h('span', { class: 'n' });
  const sideAlerts = h('div', { class: 'stack', style: { '--gap': '12px' } });
  const formError = h('div', {});

  const totalOf = (r) => (hoursToMinutes(r.reg) ?? 0) + (hoursToMinutes(r.ot) ?? 0);
  /** Overtime is worked out from the week's total: whatever was typed, 46 hours is 40 regular and 6 overtime. */
  function normalize(r) {
    const t = totalOf(r); const reg = Math.min(t, capMinutes);
    r.reg = minutesText(reg); r.ot = minutesText(t - reg);
  }
  const notes = (r) => [
    (hoursToMinutes(r.ot) || 0) > 0 ? h('span', { class: 'chip warn' }, `${hoursFromMinutes(hoursToMinutes(r.ot))} hrs overtime`) : null,
    r.w4Missing ? h('span', { class: 'dt no' }, 'W-4 missing') : null,
    r.shiftByShift ? h('span', { class: 'chip line', title: 'This person has shift-by-shift time. Change it on the shifts.' }, 'Shifts') : null,
    r.locked ? h('span', { class: 'chip line' }, 'Paid') : null,
  ];
  function drawTotals() {
    const t = rows.reduce((n, r) => n + (dollarsToCents(r.tips) || 0), 0);
    tipsTotal.textContent = money(t);
  }
  const cells = new Map(); // employeeId -> { reg, ot, tips, notes }
  /** Cells are updated in place, never rebuilt: a rebuild while someone is tabbing to the next cell would swallow their click. */
  function syncRow(r) {
    const c = cells.get(r.employeeId);
    c.reg.value = r.reg; c.ot.value = r.ot; if (c.tips) c.tips.value = r.tips;
    c.ot.className = (hoursToMinutes(r.ot) || 0) > 0 ? 'e' : '';
    c.notes.replaceChildren(...notes(r).filter(Boolean));
  }
  function field(r, key, label) {
    const input = h('input', { value: r[key], inputmode: 'decimal', 'aria-label': `${label} for ${r.name}`, 'data-key': key, disabled: r.locked || r.shiftByShift });
    input.addEventListener('input', () => {
      r[key] = input.value;
      const bad = key === 'tips' ? dollarsToCents(input.value) === null : hoursToMinutes(input.value) === null;
      input.setAttribute('aria-invalid', String(bad)); input.style.borderColor = bad ? '#C0392B' : ''; drawTotals();
    });
    input.addEventListener('change', () => {
      if (key !== 'tips' && hoursToMinutes(input.value) !== null) { normalize(r); syncRow(r); }
      else if (key === 'tips' && dollarsToCents(input.value) !== null) { r.tips = centsText(dollarsToCents(input.value)); input.value = r.tips; }
    });
    return input;
  }
  const trs = new Map();
  function drawRow(r) {
    if (trs.has(r.employeeId)) { syncRow(r); return trs.get(r.employeeId); }
    const c = { reg: field(r, 'reg', 'Regular hours'), ot: field(r, 'ot', 'Overtime hours'), tips: r.tipped ? field(r, 'tips', 'Tips') : null, notes: h('td', { class: 'l hm' }) };
    cells.set(r.employeeId, c);
    const tr = h('tr', { 'data-employee': r.employeeId }, h('td', {}, who(r.name, r.role)), h('td', { class: 'l hm' }, r.location || ''), h('td', {}, c.reg), h('td', {}, c.ot), h('td', {}, c.tips || h('span', { class: 'mut' }, '–')), c.notes);
    trs.set(r.employeeId, tr);
    syncRow(r);
    return tr;
  }
  rows.forEach((r) => tbody.append(drawRow(r)));
  drawTotals();

  const missing = rows.filter((r) => r.w4Missing);
  sideAlerts.append(...missing.map((r) => h('div', { class: 'alert' }, h('span', { class: 'dot' }), h('span', {}, h('b', {}, r.name), ' has no W-4 on file, so taxes can’t be worked out yet. ', link('/app/onboarding', { class: 'link' }, 'Send reminder')))));

  /** Turn the grid into the numbers the server wants, or say which cell is wrong. */
  function collect() {
    const entries = [];
    for (const r of rows) {
      if (r.locked || r.shiftByShift) continue;
      const reg = hoursToMinutes(r.reg); const ot = hoursToMinutes(r.ot); const tips = dollarsToCents(r.tips);
      if (reg === null || ot === null) throw new Error(`${r.name}: hours must be a number like 32.5 or 32:30.`);
      if (tips === null) throw new Error(`${r.name}: tips must be dollars, like 412.30.`);
      entries.push({ employeeId: r.employeeId, regularMinutes: reg, overtimeMinutes: ot, tipsCents: tips });
    }
    return entries;
  }
  const save = async () => {
    const entries = collect();
    if (entries.length) await api.put(`${base()}/time/week`, { periodStart: period.periodStart, periodEnd: period.periodEnd, entries });
  };

  const saveDraft = Button({ variant: 'ghost', size: 'sm', type: 'button' }, 'Save draft');
  saveDraft.addEventListener('click', async () => {
    formError.replaceChildren(); setLoading(saveDraft, true);
    try { await save(); toast('success', 'Saved. Your hours and tips are kept.'); } catch (e) { formError.replaceChildren(Alert('error', e.message)); }
    setLoading(saveDraft, false);
  });
  const next = Button({ type: 'button' }, 'Continue to review');
  next.addEventListener('click', async () => {
    formError.replaceChildren(); setLoading(next, true);
    try {
      await save();
      const all = await api.get(`${base()}/pay-runs`);
      const existing = all.payRuns.find((x) => x.status === 'draft' && x.periodStart === period.periodStart && x.periodEnd === period.periodEnd);
      const run = existing ? await api.post(`${base()}/pay-runs/${existing.id}/recalculate`, { adjustments }) : await api.post(`${base()}/pay-runs`, { ...period, adjustments });
      navigate(`/app/payroll/runs/${run.id}`);
    } catch (e) { formError.replaceChildren(Alert('error', e.message, e.details && e.details.issues ? e.details.issues.map((i) => i.message).join(' ') : undefined)); setLoading(next, false); }
  });

  // spreadsheet import: Employee, Regular hrs (or Hours), Overtime hrs, Tips
  const file = h('input', { type: 'file', accept: '.csv,text/csv', hidden: true, 'aria-label': 'Hours spreadsheet' });
  file.addEventListener('change', async () => {
    const f = file.files[0]; if (!f) return;
    const csv = parseCsv(await f.text());
    file.value = '';
    if (csv.length < 2) return toast('error', 'That file has no rows.');
    const head = csv[0].map((x) => x.trim().toLowerCase());
    const col = (...names) => head.findIndex((x) => names.some((n) => x === n || x.startsWith(n)));
    const iName = col('employee', 'name'); const iReg = col('regular', 'hours', 'hrs'); const iOt = col('overtime', 'ot'); const iTips = col('tips', 'tip');
    if (iName < 0 || iReg < 0) return toast('error', 'The first row needs “Employee” and “Regular hrs” columns.');
    let filled = 0; const lost = [];
    for (const line of csv.slice(1)) {
      const nm = (line[iName] || '').trim().toLowerCase().replace(/\s+/g, ' ');
      const r = rows.find((x) => x.name.toLowerCase() === nm || x.name.toLowerCase().split(' ').reverse().join(', ') === nm);
      if (!r) { lost.push(line[iName]); continue; }
      if (r.locked || r.shiftByShift) continue;
      r.reg = (line[iReg] || '0').trim(); r.ot = iOt >= 0 ? (line[iOt] || '0').trim() : '0'; if (iTips >= 0 && r.tipped) r.tips = (line[iTips] || '0').trim().replace(/^\$/, '');
      if (hoursToMinutes(r.reg) !== null && hoursToMinutes(r.ot) !== null) normalize(r);
      drawRow(r); filled++;
    }
    drawTotals();
    toast(lost.length ? 'warn' : 'success', `Filled in ${plural(filled, 'person', 'people')}.${lost.length ? ` Not matched: ${lost.slice(0, 4).join(', ')}${lost.length > 4 ? ` and ${lost.length - 4} more` : ''}.` : ''} Check the numbers, then save.`);
  });
  const importBtn = Button({ variant: 'ghost', size: 'sm', type: 'button', full: true, onClick: () => file.click() }, 'Import hours from a spreadsheet');
  const template = h('a', { class: 'link', href: '#', style: { textAlign: 'center', fontSize: '12.5px' }, onClick: (e) => {
    e.preventDefault();
    const csv = ['Employee,Regular hrs,Overtime hrs,Tips', ...rows.map((r) => `"${r.name}",${r.reg},${r.ot},${r.tips}`)].join('\n');
    const a = h('a', { href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })), download: `hours-${period.periodStart}.csv` }); document.body.append(a); a.click(); a.remove();
  } }, 'Download a template with your people in it');

  const extrasList = h('div', {});
  const KINDS = [['BONUS', 'Bonus', 'supplemental'], ['COMMISSION', 'Commission', 'supplemental'], ['REIMB', 'Reimbursement', 'reimbursement']];
  const drawExtras = () => extrasList.replaceChildren(...(adjustments.length ? adjustments.map((a, i) => h('div', { class: 'row', 'data-adjustment': i }, h('span', { class: 'l1' }, h('b', {}, `${a.label}`), h('i', {}, `${(rows.find((r) => r.employeeId === a.employeeId) || {}).name || 'Someone'} · ${a.category === 'reimbursement' ? 'Not taxed' : 'Taxed as pay'}`)), h('span', {}, h('b', {}, money(a.amountCents)), ' ', h('button', { class: 'link as-button', type: 'button', 'aria-label': `Remove ${a.label}`, onClick: () => { adjustments.splice(i, 1); drawExtras(); } }, 'Remove')))) : [h('p', { class: 'cap' }, 'None on this run.')]));
  function addExtra() {
    const who2 = Field({ label: 'Who', name: 'employeeId', select: true, value: rows[0] && rows[0].employeeId, options: rows.map((r) => ({ value: r.employeeId, label: r.name })) });
    const kind = Field({ label: 'What kind', name: 'kind', select: true, value: 'BONUS', options: KINDS.map(([v, l]) => ({ value: v, label: l })) });
    const label = Field({ label: 'For', name: 'label', placeholder: 'Holiday bonus, mileage for Oct 12' });
    const amount = Field({ label: 'Amount', name: 'amount', placeholder: '250.00', inputmode: 'decimal' });
    const err = h('div', {}); const go = Button({}, 'Add');
    const m = modal({ title: 'Add a bonus or reimbursement', body: h('div', { class: 'f' }, h('p', { class: 'fine', style: { margin: 0 } }, 'Bonuses and commissions are taxed as pay. A reimbursement is paid back as is, with no tax.'), who2.el, kind.el, label.el, amount.el, err), actions: [Button({ variant: 'ghost', onClick: () => m.close() }, 'Cancel'), go] });
    go.addEventListener('click', () => {
      const cents = dollarsToCents(amount.value);
      if (!cents) return amount.setError('Enter an amount, like 250.00.');
      if (!label.value.trim()) return label.setError('Say what it’s for.');
      const k = KINDS.find(([v]) => v === kind.value);
      adjustments.push({ employeeId: who2.value, code: k[0], label: label.value.trim().slice(0, 100), category: k[2], amountCents: cents });
      m.close(); drawExtras();
    });
  }
  drawExtras();
  const sched = data.company.schedule.frequency;
  const locs = data.company.locations.map((l) => l.name);
  const tipped = rows.some((r) => r.tipped);
  const side = h('div', { class: 'grid' },
    h('div', { class: 'card' }, h('h3', { class: 'ct', style: { marginBottom: '10px' } }, 'This pay run'), h('dl', { class: 'kv', style: { gridTemplateColumns: '110px 1fr', fontSize: '13.5px' } }, h('dt', {}, 'Period'), h('dd', {}, rangeLabel(period.periodStart, period.periodEnd)), h('dt', {}, 'Pay date'), h('dd', {}, longDate(period.checkDate)), h('dt', {}, 'Schedule'), h('dd', {}, FREQ[sched] || sched), locs.length ? [h('dt', {}, 'Locations'), h('dd', {}, locs.join(', '))] : null)),
    tipped ? h('div', { class: 'card' }, h('h3', { class: 'ct', style: { marginBottom: '6px' } }, 'Tips this period'), h('div', { class: 'big2' }, h('div', {}, tipsTotal)), h('p', { class: 'cap' }, 'Tips paid through payroll. Cash tips someone already kept don’t need to be entered.')) : null,
    hasExtras || adjustments.length ? h('div', { class: 'card' }, h('div', { class: 'ch' }, h('h3', { class: 'ct' }, 'Bonuses and reimbursements'), h('button', { class: 'link as-button', type: 'button', 'data-testid': 'add-extra', onClick: addExtra }, 'Add')), extrasList) : null,
    sideAlerts, importBtn, template, file);

  return h('div', {}, pageHead(['Run ', h('em', {}, 'payroll')], `${FREQ[sched] || 'Pay'} pay run for ${data.company.name}`, saveDraft), pstep(1),
    h('div', { class: 'grid g32', style: { gridTemplateColumns: 'minmax(0,1fr) 340px', marginTop: '18px' } },
      h('div', { class: 'card' }, h('div', { class: 'ch' }, h('h3', { class: 'ct' }, 'Hours and tips'), h('span', { class: 'cap' }, `${weeks === 1 ? 'Week' : 'Period'} of ${shortDate(period.periodStart)}. Edit any cell.`)),
        rows.length ? h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, h('th', {}, 'Employee'), h('th', { class: 'l hm' }, 'Location'), h('th', {}, 'Regular hrs'), h('th', {}, 'Overtime hrs'), h('th', {}, 'Tips ($)'), h('th', { class: 'l hm' }, 'Notes'))), tbody)
          : h('div', { class: 'empty' }, 'Nobody is on payroll for this period yet. ', link('/app/onboarding', { class: 'link' }, 'Invite your first person')),
        h('p', { class: 'cap', style: { marginTop: '10px' } }, 'Overtime is worked out from the total: anything over 40 hours in a week is paid at time and a half, whichever box you type it in.')), side),
    formError,
    h('div', { class: 'acts', style: { justifyContent: 'flex-end', marginTop: '18px' } }, link('/app/payroll/run', { class: 'link' }, 'Back'), next), legal());
}

// ---------------------------------------------------------------- 3 and 4: review the run, approve it, then pay your team
const TAXCOL = (l) => (l.id === 'US_FIT' ? 'fit' : /^US_(SS|MED)_EE$/.test(l.id) ? 'fica' : l.jurisdiction === 'state' ? 'state' : l.jurisdiction === 'federal' ? 'other' : 'local');

export function runPage() {
  return async (ctx) => appPage(ctx, { active: 'payroll', title: 'Pay run', render: async () => {
    await refreshData();
    const run = await api.get(`${base()}/pay-runs/${ctx.params.id}`);
    const week = await api.get(`${base()}/time/week?start=${run.periodStart}&end=${run.periodEnd}`).catch(() => ({ people: [] }));
    const info = new Map(week.people.map((p) => [p.employeeId, p]));
    return run.status === 'draft' ? reviewView(run, info) : approvedView(run, info);
  } });
}

const stat = (label, value, small) => h('div', {}, h('i', {}, label), h('b', {}, value), small ? h('small', {}, small) : null);

function cols(run) {
  const has = (k) => run.paychecks.some((p) => p.taxLines.some((l) => l.payer === 'employee' && l.amount > 0 && TAXCOL(l) === k));
  const stateName = app.data.built ? app.data.built.answers[0] : app.data.company.state;
  return [['fit', 'Federal'], ['fica', 'SS + Medicare'], ['state', stateName], ['local', 'City']].filter(([k]) => has(k) || k === 'fit' || k === 'fica');
}
const taxIn = (pc, k) => pc.taxLines.filter((l) => l.payer === 'employee' && TAXCOL(l) === k).reduce((n, l) => n + l.amount, 0);

function paychecksTable(run, info, { stubs = false } = {}) {
  const C = cols(run);
  const tipsOf = (pc) => pc.tips.chargedKeptCents + pc.tips.tipOutReceivedCents + pc.tips.poolShareCents + pc.tips.cashCents;
  const grossOf = (pc) => pc.taxableWagesCents;
  const tot = { tips: 0, gross: 0, net: 0 }; const colTot = Object.fromEntries(C.map(([k]) => [k, 0]));
  const body = run.paychecks.map((pc) => {
    const p = info.get(pc.employeeId);
    tot.tips += tipsOf(pc); tot.gross += grossOf(pc); tot.net += pc.netPayCents;
    for (const [k] of C) colTot[k] += taxIn(pc, k);
    return h('tr', { 'data-employee': pc.employeeId },
      h('td', {}, stubs ? link(`/app/payroll/runs/${run.id}/stub/${pc.employeeId}`, { class: 'who-link' }, who(pc.name, p && p.role)) : who(pc.name, p && p.role)),
      h('td', { class: 'l hm' }, (p && p.location) || ''), h('td', { class: 'hm' }, String(Math.round(pc.hours * 100) / 100)),
      h('td', { class: 'hm' }, tipsOf(pc) ? money(tipsOf(pc)) : h('span', { class: 'mut' }, '–')), h('td', {}, money(grossOf(pc))),
      ...C.map(([k]) => h('td', { class: 'hm' }, money(taxIn(pc, k)))), h('td', {}, h('b', {}, money(pc.netPayCents))));
  });
  return h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, h('th', {}, 'Employee'), h('th', { class: 'l hm' }, 'Location'), h('th', { class: 'hm' }, 'Hours'), h('th', { class: 'hm' }, 'Tips'), h('th', {}, 'Gross'), ...C.map(([, label]) => h('th', { class: 'hm' }, label)), h('th', {}, 'Net'))),
    h('tbody', {}, ...body, h('tr', { class: 'tot' }, h('td', {}, `Total, ${plural(run.paychecks.length, 'employee')}`), h('td', { class: 'hm' }), h('td', { class: 'hm' }), h('td', { class: 'hm' }, money(tot.tips)), h('td', {}, money(tot.gross)), ...C.map(([k]) => h('td', { class: 'hm' }, money(colTot[k]))), h('td', {}, money(tot.net)))));
}

function statsStrip(run) {
  const left = Math.max(0, app.data.team.active - run.paychecks.length);
  return h('div', { style: { margin: '18px 0' } }, h('div', { class: 'stats' }, stat('Gross pay', money(run.totals.grossCents)), stat('Employee taxes', money(run.totals.employeeTaxCents)), stat('Net pay', money(run.paychecks.reduce((n, p) => n + p.netPayCents, 0))), stat('Employees on this run', String(run.paychecks.length), left ? `${left} left out` : undefined)));
}

function costCard(run) {
  return h('div', { class: 'card' }, h('h3', { class: 'ct', style: { marginBottom: '6px' } }, 'What it costs you'),
    h('table', { class: 'tbl' }, h('tbody', {}, h('tr', {}, h('td', {}, 'Gross pay'), h('td', {}, money(run.totals.grossCents))), h('tr', {}, h('td', {}, 'Employer taxes'), h('td', {}, money(run.totals.employerTaxCents))), h('tr', { class: 'tot' }, h('td', {}, 'Total'), h('td', {}, money(run.totals.grossCents + run.totals.employerTaxCents))))));
}

function reviewView(run, info) {
  const blockers = run.issues.filter((i) => i.severity === 'blocking');
  const reviews = run.issues.filter((i) => i.severity === 'review');
  const names = new Map(run.paychecks.map((p) => [p.employeeId, p.name]));
  const short = (m) => (m.length > 120 ? `${m.slice(0, 117)}…` : m);
  const row = (title, detail, chip) => h('div', { class: 'row' }, h('span', { class: 'l1' }, h('b', {}, title), detail ? h('i', {}, detail) : null), chip);
  const nameOfIssue = (i) => names.get(i.employeeId) || (i.message.match(/^(.+?) (is not|has no|is salaried|was hired)/) || [])[1] || 'Someone';
  const ISSUE = {
    w4_missing: (i) => [`${nameOfIssue(i)}, no W-4`, 'Left out until it’s on file'],
    payout_account_not_ready: (i) => [`${nameOfIssue(i)}, no direct deposit`, 'Their pay can’t go in the bank file until it’s set up'],
    ssn_missing: (i) => [`${nameOfIssue(i)}, no SSN`, 'Needed for the W-2 and filings'],
    salary_not_prorated: (i) => [`${nameOfIssue(i)}, started or left mid-period`, 'Salary is paid in full; proration isn’t worked out'],
    salaried_with_shifts: (i) => [`${nameOfIssue(i)}, salaried with shifts`, 'Overtime isn’t worked out for salaried staff'],
    tax_data_quality: (i) => [`${nameOfIssue(i)}, tax note`, short(i.message)],
  };
  const issueRow = (i, chip) => { const [t, d] = (ISSUE[i.code] || ((x) => [x.message.split(/[.:(]/)[0].slice(0, 60), short(x.message)]))(i); return row(t, d, chip); };
  const rowsIssues = [
    ...blockers.map((i) => issueRow(i, Chip('Fix first', 'warn'))),
    ...reviews.map((i) => issueRow(i, Chip('Review', 'warn'))),
    ...run.paychecks.filter((pc) => pc.weeks.some((w) => w.overtimeMinutes > 0)).map((pc) => { const m = pc.weeks.reduce((n, w) => n + w.overtimeMinutes, 0); return row(`${pc.name}, ${hoursFromMinutes(m)} overtime hours`, 'Paid at 1.5 times their rate', Chip('Looks right', 'ok')); }),
    ...(run.paychecks.some((pc) => pc.taxLines.some((l) => TAXCOL(l) === 'local' && l.amount > 0)) ? [row('City income tax', 'Applied by where each person works and lives', Chip('Auto', 'ok'))] : []),
  ];

  const approve = Button({ full: true, type: 'button', disabled: blockers.length > 0 || run.paychecks.length === 0 }, 'Approve pay run');
  const err = h('div', {});
  async function doApprove(ack) {
    setLoading(approve, true);
    try {
      await api.post(`${base()}/pay-runs/${run.id}/approve`, { acknowledgeReviewIssues: ack });
      toast('success', 'Pay run approved. Pay stubs are ready.');
      navigate(`/app/payroll/runs/${run.id}`, { replace: true });
    } catch (e) {
      setLoading(approve, false);
      if (e.code === 'company_not_verified') err.replaceChildren(Alert('error', 'Add your EIN before you approve.', 'It goes on every pay stub and tax filing.'), h('div', { style: { marginTop: '8px' } }, Button({ variant: 'ghost', size: 'sm', href: '/app/settings/company' }, 'Open Company setup')));
      else err.replaceChildren(Alert('error', e.message));
    }
  }
  approve.addEventListener('click', () => {
    err.replaceChildren();
    if (!reviews.length) return doApprove(false);
    const ok = h('input', { type: 'checkbox', id: 'ack' });
    const go = Button({ disabled: true }, 'Approve');
    ok.addEventListener('change', () => { go.disabled = !ok.checked; });
    const m = modal({ title: 'Before you approve', body: h('div', { class: 'f' }, h('p', { class: 'fine', style: { margin: 0 } }, `${plural(reviews.length, 'thing')} need${reviews.length === 1 ? 's' : ''} a person’s eye. Totali made a note instead of guessing:`), h('ul', { style: { margin: '10px 0 14px 18px', fontSize: '13.5px' } }, ...reviews.map((i) => h('li', {}, i.message))), h('label', { class: 'ck2' }, ok, h('span', { class: 'cb' }), h('span', { class: 'fine' }, 'I’ve read these and want to approve anyway.'))), actions: [Button({ variant: 'ghost', onClick: () => m.close() }, 'Go back'), go] });
    go.addEventListener('click', () => { m.close(); doApprove(true); });
  });

  return h('div', {}, pageHead(['Review the ', h('em', {}, 'pay run')], `${FREQ[app.data.company.schedule.frequency] || 'Pay'} · ${rangeLabel(run.periodStart, run.periodEnd)} · Pay date ${longDate(run.checkDate)}`, Button({ variant: 'ghost', size: 'sm', href: `/app/payroll/run?start=${run.periodStart}&end=${run.periodEnd}&check=${run.checkDate}` }, 'Back to hours')), pstep(2), statsStrip(run),
    h('div', { class: 'grid', style: { gridTemplateColumns: 'minmax(0,1fr) 360px' } },
      h('div', { class: 'card' }, h('div', { class: 'ch' }, h('h3', { class: 'ct' }, 'Every paycheck, line by line'), h('span', { class: 'cap' }, 'Taxes by the Omnia.tax engine')), run.paychecks.length ? paychecksTable(run, info) : h('div', { class: 'empty' }, 'No one has pay in this period. Go back and enter hours.')),
      h('div', { class: 'grid' },
        h('div', { class: 'card' }, h('h3', { class: 'ct', style: { marginBottom: '8px' } }, 'Before you approve'), ...(rowsIssues.length ? rowsIssues : [h('p', { class: 'cap' }, 'Nothing needs a second look.')])),
        costCard(run),
        h('div', { class: 'card', style: { background: 'color-mix(in srgb, var(--d-bg) 70%, var(--d-card))' } }, h('p', { class: 'cap', style: { marginBottom: '12px' } }, 'Approving locks these numbers and creates a pay stub for each person. Totali works out the pay and keeps the records. Paying your team happens at your own bank: you’ll get the file next.'), blockers.length ? h('p', { class: 'ferr', style: { marginBottom: '8px' } }, `${plural(blockers.length, 'problem')} must be fixed before you can approve. Go back, fix it, and continue again.`) : null, err, approve))), legal());
}

const STATUS_LABEL = { approved: ['Approved', 'ok'], funding: ['Paying', 'ok'], funded: ['Paying', 'ok'], disbursing: ['Paying', 'ok'], completed: ['Paid', 'ok'], failed: ['Needs attention', 'warn'], voided: ['Voided', 'line'], draft: ['Draft', 'warn'] };

function approvedView(run, info) {
  const [label, kind] = STATUS_LABEL[run.status] || [run.status, 'line'];
  const payCard = h('div', {});
  const voidBtn = run.status === 'approved' ? h('button', { class: 'link as-button', type: 'button', onClick: () => {
    const m = modal({ title: 'Void this pay run?', body: h('p', { style: { margin: 0 } }, 'The stubs are cancelled and these hours go back to open, so you can run it again. Only possible before anything is paid.'), actions: [Button({ variant: 'ghost', onClick: () => m.close() }, 'Keep it'), Button({ onClick: async () => { try { await api.post(`${base()}/pay-runs/${run.id}/void`); m.close(); toast('success', 'Pay run voided.'); navigate('/app/payroll'); } catch (e) { toast('error', e.message); } } }, 'Void pay run')] });
  } }, 'Void this run') : null;
  if (run.status === 'approved' || run.status === 'disbursing' || run.status === 'completed') payYourTeam(payCard, run);
  return h('div', {}, pageHead(['Pay run ', h('em', {}, label.toLowerCase())], `${FREQ[app.data.company.schedule.frequency] || 'Pay'} · ${rangeLabel(run.periodStart, run.periodEnd)} · Pay date ${longDate(run.checkDate)}`, h('span', { class: `chip ${kind}` }, label), voidBtn), pstep(run.status === 'voided' ? 2 : 4), statsStrip(run),
    h('div', { class: 'grid', style: { gridTemplateColumns: 'minmax(0,1fr) 360px' } },
      h('div', { class: 'card' }, h('div', { class: 'ch' }, h('h3', { class: 'ct' }, 'Pay stubs'), h('span', { class: 'cap' }, 'Click a name to open their stub')), paychecksTable(run, info, { stubs: true })),
      h('div', { class: 'grid' }, payCard, costCard(run), run.issues.filter((i) => i.severity !== 'info').length ? h('div', { class: 'card' }, h('h3', { class: 'ct', style: { marginBottom: '8px' } }, 'Notes kept with this run'), ...run.issues.filter((i) => i.severity !== 'info').map((i) => h('p', { class: 'cap', style: { marginBottom: '6px' } }, i.message))) : null)), legal());
}

/** The one manual step: Totali writes the bank file, the employer approves and uploads it at their own bank. */
async function payYourTeam(host, run) {
  host.className = 'card';
  host.replaceChildren(h('h3', { class: 'ct', style: { marginBottom: '8px' } }, 'Pay your team'), h('p', { class: 'cap' }, 'Loading…'));
  let setup;
  try { setup = await api.get(`${base()}/payment-setup`); } catch (e) { host.replaceChildren(h('h3', { class: 'ct' }, 'Pay your team'), Alert('error', e.message)); return; }
  const draw = (...kids) => host.replaceChildren(h('h3', { class: 'ct', style: { marginBottom: '8px' } }, 'Pay your team'), ...kids);
  if (!setup.employerBank) {
    return draw(h('p', { class: 'cap', style: { marginBottom: '12px' } }, 'Totali writes the payment file. You approve it and upload it at your own bank, so your money never passes through us. Tell Totali which bank you use and it checks the file against that bank’s rules.'), Button({ variant: 'ghost', size: 'sm', href: '/app/settings/payments' }, 'Set up your bank'));
  }
  const files = (await api.get(`${base()}/ach/files`).catch(() => ({ files: [] }))).files.filter((f) => f.runId === run.id && f.status !== 'cancelled');
  const have = files[0];
  if (have) return showFile(have);
  draw(h('p', { class: 'cap', style: { marginBottom: '12px' } }, `Employees are paid on ${longDate(run.checkDate)}. Your bank needs the file a banking day or two before.`), prepareButton());

  function prepareButton() {
    const b = Button({ size: 'sm', type: 'button' }, 'Prepare the payment file');
    b.addEventListener('click', async () => {
      setLoading(b, true);
      try { const r = await api.post(`${base()}/pay-runs/${run.id}/prepare-payment`, {}); if (r.file) showFile(r.file, r); else draw(Alert('info', 'Nothing to send yet.', r.waitingForBankAccount && r.waitingForBankAccount.length ? `${plural(r.waitingForBankAccount.length, 'person', 'people')} still need${r.waitingForBankAccount.length === 1 ? 's' : ''} direct deposit set up.` : undefined)); }
      catch (e) {
        setLoading(b, false);
        if (e.code === 'check_date_unreachable') return draw(Alert('warn', e.message), (() => { const late = Button({ size: 'sm', variant: 'ghost', type: 'button' }, 'Prepare it anyway, paying late'); late.addEventListener('click', async () => { try { const r = await api.post(`${base()}/pay-runs/${run.id}/prepare-payment`, { acceptLate: true }); showFile(r.file, r); } catch (e2) { toast('error', e2.message); } }); return late; })());
        draw(Alert('error', e.message), prepareButton());
      }
    });
    return b;
  }
  function showFile(f, prepared) {
    const released = f.status === 'released' || f.status === 'accepted' || f.status === 'settled' || f.releasedAt;
    const dl = Button({ variant: 'ghost', size: 'sm', type: 'button' }, 'Download the file');
    dl.addEventListener('click', async () => { try { await api.download(`${base()}/ach/files/${f.id}/content`, f.fileName || `payroll-${run.checkDate}.ach`); } catch (e) { toast('error', e.message); } });
    const done = Button({ size: 'sm', type: 'button', disabled: !!released }, released ? 'Released at your bank' : 'I’ve released it at my bank');
    done.addEventListener('click', async () => {
      setLoading(done, true);
      try { await api.post(`${base()}/ach/files/${f.id}/released`, { releasedBy: `${session.user.firstName} ${session.user.lastName}` }); toast('success', 'Noted. Totali will track it from here.'); payYourTeam(host, run); } catch (e) { toast('error', e.message); setLoading(done, false); }
    });
    const total = prepared && prepared.needsInYourAccountCents;
    draw(
      h('ol', { class: 'cap', style: { margin: '0 0 12px 18px', display: 'grid', gap: '4px' } }, h('li', {}, 'Download the file.'), h('li', {}, 'Upload it in your bank’s ACH portal.'), h('li', {}, 'Approve and release it there, then come back and tell us.')),
      h('dl', { class: 'kv', style: { gridTemplateColumns: '120px 1fr', fontSize: '13.5px', marginBottom: '12px' } }, h('dt', {}, 'Takes effect'), h('dd', {}, longDate(f.effectiveDate || run.checkDate)), h('dt', {}, 'People paid'), h('dd', {}, String((f.totals && f.totals.entryCount) || (prepared && prepared.paying.length) || '')), total ? [h('dt', {}, 'Have ready'), h('dd', {}, `${money(total)} in your account`)] : null),
      prepared && prepared.late ? Alert('warn', 'This lands after the pay date.') : null,
      h('div', { class: 'acts' }, dl, done));
  }
}

// ---------------------------------------------------------------- the pay stub
export function stubPage() {
  return async (ctx) => appPage(ctx, { active: 'payroll', title: 'Pay stub', render: async () => {
    await refreshData();
    const run = await api.get(`${base()}/pay-runs/${ctx.params.id}`);
    const pc = run.paychecks.find((p) => p.employeeId === ctx.params.eid);
    if (!pc) { navigate('/404', { replace: true }); return null; }
    const [emp, week] = await Promise.all([api.get(`${base()}/employees/${pc.employeeId}`), api.get(`${base()}/time/week?start=${run.periodStart}&end=${run.periodEnd}`).catch(() => ({ people: [] }))]);
    const first = pc.name.split(' ')[0];
    const company = app.data.company;
    const roleLabel = (week.people.find((p) => p.employeeId === pc.employeeId) || {}).role || '';
    const idx = run.paychecks.findIndex((p) => p.employeeId === pc.employeeId);
    const nextPc = run.paychecks[(idx + 1) % run.paychecks.length];
    const rl = (a, b, cls = '') => h('div', { class: `rl ${cls}` }, h('span', {}, a), h('span', {}, b));
    const employeeTaxes = pc.taxLines.filter((t) => t.payer === 'employee' && t.amount > 0);
    const wages = pc.earnings.filter((e) => e.code === 'REG' || e.code === 'OT' || e.code === 'SALARY' || !/^TIPS|^SVC/.test(e.code));
    const tipsTotal = pc.earnings.filter((e) => /^TIPS|^SVC/.test(e.code)).reduce((n, e) => n + e.amountCents, 0);
    const taxTotal = pc.employeeTaxCents;
    const fica = employeeTaxes.filter((t) => /^US_(SS|MED)_EE$/.test(t.id)).reduce((n, t) => n + t.amount, 0);
    const calr = (title, why, amount, extra = {}) => h('div', { class: 'calr', style: extra.style }, h('span', {}, h('b', {}, title), why ? h('i', {}, why) : null), amount === undefined ? h('span') : h('b', extra.accent ? { style: { color: 'var(--berry)' } } : {}, money(amount)));
    const receipt = h('div', { class: 'receipt' },
      h('div', { class: 'rh' }, h('b', {}, company.name), h('span', {}, `Pay stub · ${pc.name}${roleLabel ? ` · ${roleLabel}` : ''}${emp.location ? ` · ${emp.location}` : ''}`)),
      rl('Period', rangeLabel(run.periodStart, run.periodEnd)), rl('Pay date', `${longDate(run.checkDate)}, ${year(run.checkDate)}`), h('hr'),
      ...wages.map((e) => rl(e.detail || e.code, money(e.amountCents))),
      tipsTotal ? rl('Tips', money(tipsTotal), 'circle') : null, rl('Gross pay', money(pc.taxableWagesCents), 't'), h('hr'),
      ...employeeTaxes.map((t) => rl(t.name, money(t.amount))), rl('Total taxes', money(taxTotal), 't'),
      ...(pc.deductionLines.some((d) => d.amountCents > 0) ? [h('hr'), ...pc.deductionLines.filter((d) => d.amountCents > 0).map((d) => rl(d.code, money(d.amountCents)))] : []), h('hr'),
      rl('Net pay', money(pc.netPayCents), 'big'),
      pc.cashTipsCents ? rl('Less cash tips already received', `-${money(pc.cashTipsCents)}`) : null,
      h('div', { class: 'rf' }, 'Taxes calculated by the Omnia.tax engine.', run.status === 'draft' ? h('span', {}, h('br'), 'DRAFT: not approved yet.') : null));
    const hrs = Math.round(pc.hours * 100) / 100;
    const explain = h('div', { style: { position: 'relative' } }, h('h2', { class: 'st2' }, `How ${first}’s check was `, h('em', {}, 'worked out')),
      h('div', { class: 'cal' },
        calr(`Gross ${money(pc.taxableWagesCents)}`, `${hrs} hours${tipsTotal ? `, plus ${money(tipsTotal)} in tips. Tips count as pay for tax.` : '.'}`),
        ...employeeTaxes.filter((t) => t.id === 'US_FIT').map((t) => calr(t.name, 'Worked out from their W-4.', t.amount)),
        fica ? calr('Social Security and Medicare', '6.2% and 1.45% of gross.', fica) : null,
        ...employeeTaxes.filter((t) => !/^US_(FIT|SS_EE|MED_EE)$/.test(t.id)).map((t) => calr(t.name, t.jurisdiction === 'state' ? 'From the state’s rules and their state withholding form.' : 'From where they live and work.', t.amount)),
        calr('Net pay', 'What’s left after taxes.', pc.netPayCents, { accent: true, style: 'border-bottom:1px solid var(--line)' })),
      h('div', { class: 'acts', style: { marginTop: '18px' } }, Button({ variant: 'ghost', size: 'sm', type: 'button', onClick: () => window.print() }, 'Print or save as PDF'),
        run.paychecks.length > 1 ? Button({ variant: 'ghost', size: 'sm', href: `/app/payroll/runs/${run.id}/stub/${nextPc.employeeId}` }, 'Next stub') : null, link(`/app/people/${pc.employeeId}`, { class: 'link' }, `Back to ${first}`), link(`/app/payroll/runs/${run.id}`, { class: 'link' }, 'All stubs')));
    return h('div', {}, pageHead(['Pay ', h('em', {}, 'stub')], `${pc.name} · ${FREQ[company.schedule.frequency] || 'Pay'} · ${shortDate(run.periodStart)} to ${shortDate(run.periodEnd)}`), h('div', { class: 'stubwrap' }, h('div', { style: { position: 'relative' } }, receipt), explain), legal());
  } });
}
