import { h, plural, money, longDate } from '../dom.js';
import { api } from '../api.js';
import { navigate } from '../router.js';
import { Button, Alert, Field, modal, setLoading, toast } from '../ui.js';
import { base, refreshData } from './state.js';
import { rangeLabel, parseCsv } from './payroll.js';

const hours = (m) => `${Math.round((m / 60) * 10) / 10} hours`;

/** What a pull found, in plain words. */
function summaryView(s) {
  return h('div', { class: 'stack', style: { '--gap': '8px' }, 'data-testid': 'pos-summary' },
    h('p', { style: { margin: 0 } }, h('b', {}, `${plural(s.shifts, 'shift')} for ${plural(s.people, 'person', 'people')}`), `, ${hours(s.minutes)}${s.tipsCents ? `, ${money(s.tipsCents)} in tips` : ''}. ${rangeLabel(s.from, s.to)}.`),
    s.unmapped.length ? Alert('warn', `${plural(s.unmapped.length, 'person', 'people')} left out: not matched to your team.`, s.unmapped.slice(0, 6).map((u) => `${u.name} (${hours(u.minutes)})`).join(', ')) : null,
    s.problems.length ? Alert('warn', 'Some shifts couldn’t be saved.', s.problems.slice(0, 4).join(' · ')) : null,
    ...s.notes.map((n) => Alert('info', n)));
}

const COLUMNS = [['name', 'Employee name'], ['first', 'First name'], ['last', 'Last name'], ['email', 'Email'], ['date', 'Date'], ['clockIn', 'Clock in'], ['clockOut', 'Clock out'], ['hours', 'Paid hours'], ['breakMinutes', 'Unpaid break'], ['cardTips', 'Card tips'], ['cashTips', 'Cash tips'], ['tips', 'Total tips']];

/**
 * Hours from a report exported by any point of sale. The columns are found by their names and can be corrected, the
 * people are matched, and nothing is saved until the owner says so.
 */
export function reportModal(onDone) {
  const file = h('input', { type: 'file', accept: '.csv,text/csv', 'aria-label': 'Time clock report', 'data-testid': 'report-file' });
  const body = h('div', { class: 'stack', style: { '--gap': '14px' } });
  const go = Button({ disabled: true, type: 'button', 'data-testid': 'report-import' }, 'Import');
  const m = modal({ title: 'Import a time clock report', body, actions: [Button({ variant: 'ghost', onClick: () => m.close() }, 'Cancel'), go] });
  let headers = []; let rows = []; let mapping = null; const links = {};
  const intro = () => body.replaceChildren(h('p', { class: 'cap', style: { margin: 0 } }, 'Every point of sale can export hours. In yours, find the labor, time clock or timesheet report for a pay period and export it as CSV. Then choose the file here. Totali finds the columns, and you check them before anything is saved.'), file);
  intro();
  async function look() {
    try {
      const a = await api.post(`${base()}/pos/report`, { headers, rows, ...(mapping ? { mapping } : {}) });
      mapping = a.mapping;
      draw(a);
    } catch (e) { body.replaceChildren(Alert('error', e.message), file); go.disabled = true; }
  }
  function draw(a) {
    const opts = (cur) => [h('option', { value: '' }, 'Not in this report'), ...headers.map((x, i) => h('option', { value: String(i), selected: cur === i }, x || `Column ${i + 1}`))];
    const sels = COLUMNS.map(([f, label]) => {
      const sel = h('select', { class: 'in', 'aria-label': label, 'data-col': f, style: { minHeight: '34px', padding: '4px 8px', fontSize: '14px' } }, ...opts(a.mapping[f]));
      sel.addEventListener('change', () => { const next = { ...mapping }; if (sel.value === '') delete next[f]; else next[f] = Number(sel.value); mapping = next; look(); });
      return h('tr', {}, h('td', {}, label), h('td', {}, sel));
    });
    const peopleRows = a.people.map((p) => {
      const sel = h('select', { class: 'in', 'aria-label': `Who is ${p.name}`, 'data-report-person': p.key, style: { minHeight: '34px', padding: '4px 8px', fontSize: '14px' } },
        h('option', { value: '' }, 'Not matched'), h('option', { value: '__none' }, 'Not on my payroll'), ...a.team.map((e) => h('option', { value: e.id }, e.name)));
      sel.value = p.status === 'ignored' ? '__none' : p.employeeId || '';
      if (links[p.key] !== undefined) sel.value = links[p.key] === null ? '__none' : links[p.key];
      sel.addEventListener('change', () => { links[p.key] = sel.value === '__none' ? null : sel.value === '' ? '' : sel.value; });
      return h('tr', {}, h('td', {}, h('b', {}, p.name), h('div', { class: 'cap' }, `${plural(p.rows, 'shift')}, ${hours(p.minutes)}`)), h('td', {}, sel));
    });
    go.disabled = a.missing.length > 0 || a.rows === 0;
    body.replaceChildren(...[
      a.missing.length ? Alert('error', `I can’t find ${a.missing.join(' or ')}.`, 'Pick the right column below.') : h('p', { style: { margin: 0 }, 'data-testid': 'report-found' }, h('b', {}, `${plural(a.rows, 'row')}`), `, ${hours(a.minutes)}, ${a.from ? rangeLabel(a.from, a.to) : ''}`),
      h('details', { open: a.missing.length > 0 }, h('summary', {}, 'Columns I found'), h('table', { class: 'tbl' }, h('tbody', {}, ...sels))),
      a.people.length ? h('div', {}, h('div', { class: 'sec2' }, 'Who is who'), h('table', { class: 'tbl' }, h('tbody', {}, ...peopleRows))) : null,
      a.problems.length ? Alert('warn', `${plural(a.problems.length, 'row')} skipped`, a.problems.slice(0, 4).join(' · ')) : null,
      h('button', { class: 'link as-button', type: 'button', onClick: () => { headers = []; rows = []; mapping = null; file.value = ''; go.disabled = true; intro(); } }, 'Choose a different file')].filter(Boolean));
  }
  file.addEventListener('change', async () => {
    const f = file.files[0]; if (!f) return;
    const all = parseCsv(await f.text()).filter((r) => r.some((c) => c.trim()));
    if (all.length < 2) return body.replaceChildren(Alert('error', 'That file has no rows.'), file);
    if (all.length > 3001) return body.replaceChildren(Alert('error', 'That is more than 3,000 rows. Export one pay period at a time.'), file);
    headers = all[0]; rows = all.slice(1); mapping = null;
    await look();
  });
  go.addEventListener('click', async () => {
    setLoading(go, true);
    try {
      const out = await api.post(`${base()}/pos/report`, { headers, rows, mapping, links, apply: true });
      m.close(); await refreshData();
      const s = out.applied;
      toast(s.unmapped.length || s.problems.length ? 'warn' : 'success', `Imported ${plural(s.shifts, 'shift')} for ${plural(s.people, 'person', 'people')}.${s.unmapped.length ? ` ${s.unmapped.length} left out, not matched.` : ''}${s.problems.length ? ` ${s.problems.length} problems.` : ''}`, 9000);
      onDone(s);
    } catch (e) { body.prepend(Alert('error', e.message)); setLoading(go, false); }
  });
}

/** Pull the hours and tips for a period, and say what happened. */
export async function pull(from, to) {
  const s = await api.post(`${base()}/pos/sync`, { from, to });
  await refreshData();
  return s;
}

function connectForm(cat, after) {
  let pick = cat.providers[0].id;
  const host = h('div', { class: 'stack', style: { '--gap': '14px' } });
  const draw = () => {
    const info = cat.providers.find((p) => p.id === pick);
    const fields = info.fields.map((f) => ({ f, el: Field({ label: f.label, name: f.name, type: f.secret ? 'password' : 'text', autocomplete: 'off', hint: f.hint, ...(f.options ? { select: true, options: f.options, value: f.options[0].value } : {}) }) }));
    const err = h('div', {}); const go = Button({ type: 'submit', 'data-testid': 'pos-connect' }, `Connect ${info.name}`);
    host.replaceChildren(
      h('div', { class: 'opts', role: 'radiogroup', 'aria-label': 'Your system' }, ...cat.providers.map((p) => h('button', { type: 'button', class: `opt ${p.id === pick ? 'on' : ''}`, role: 'radio', 'aria-checked': String(p.id === pick), 'data-provider': p.id, onClick: () => { pick = p.id; draw(); } }, h('span', { class: 'rd' }), h('span', {}, p.name, h('small', {}, p.brings.join(', ')))))),
      h('p', { class: 'cap', style: { margin: 0 } }, info.where),
      h('form', { class: 'f', novalidate: true, onSubmit: async (e) => {
        e.preventDefault(); err.replaceChildren();
        const body = { provider: pick };
        for (const { f, el } of fields) body[f.name] = el.value;
        setLoading(go, true);
        try { await api.post(`${base()}/pos/connect`, body); toast('success', `${info.name} is connected.`); await refreshData(); after(); return; }
        catch (e2) { const t = fields.find(({ f }) => f.name === (e2.details && e2.details.field)); if (t) t.el.setError(e2.message); else err.replaceChildren(Alert('error', e2.message)); }
        setLoading(go, false);
      } }, ...fields.map((x) => x.el.el), err, go));
  };
  draw();
  return host;
}

async function matching(conn) {
  const d = await api.get(`${base()}/pos/people`);
  const rows = d.people.map((p) => {
    const sel = h('select', { class: 'in', 'aria-label': `Match ${p.name}`, 'data-person': p.externalId, style: { minHeight: '36px', padding: '6px 10px', fontSize: '14px' } },
      h('option', { value: '__new' }, p.status === 'new' ? (p.suggestion ? 'Match…' : 'Not matched yet') : ''),
      h('option', { value: '__none' }, 'Not on my payroll'),
      ...d.team.map((e) => h('option', { value: e.id }, e.id === p.suggestion && p.status === 'new' ? `${e.name} (suggested)` : e.name)));
    sel.value = p.status === 'linked' ? p.linkedTo : p.status === 'ignored' ? '__none' : p.suggestion ? p.suggestion : '__new';
    sel.addEventListener('change', async () => {
      try { await api.put(`${base()}/pos/links`, { externalId: p.externalId, employeeId: sel.value === '__new' ? '' : sel.value === '__none' ? null : sel.value }); toast('success', 'Saved.'); }
      catch (e) { toast('error', e.message); }
    });
    return h('tr', { 'data-pos-person': p.externalId }, h('td', {}, h('b', {}, p.name), p.email ? h('div', { class: 'cap' }, p.email) : null), h('td', {}, sel));
  });
  return h('div', {}, h('p', { class: 'cap', style: { marginTop: 0 } }, 'People with the same email as someone on your team are matched for you. For the rest, pick who they are. Someone you leave unmatched is left out of payroll.'),
    rows.length ? h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, h('th', { class: 'l' }, conn.label), h('th', { class: 'l' }, 'On your team'))), h('tbody', {}, ...rows)) : h('div', { class: 'empty' }, 'No staff found there.'));
}

export async function posSection() {
  const cat = await api.get(`${base()}/pos`);
  const redraw = () => navigate(location.pathname + location.search);
  if (!cat.connection) {
    return h('div', { class: 'stack', style: { '--gap': '16px', maxWidth: '640px' } },
      h('div', { class: 'card' }, h('div', { class: 'ch' }, h('h3', { class: 'ct' }, 'Connect your point of sale')),
        h('p', { class: 'cap', style: { marginTop: 0 } }, 'Totali doesn’t ring up sales. It reads your staff, their hours and their tips from the system you already use, so nobody types them twice. You can still enter hours by hand.'),
        connectForm(cat, redraw)),
      h('div', { class: 'card' }, h('div', { class: 'ch' }, h('h3', { class: 'ct' }, 'Using something else?')),
        h('p', { class: 'cap', style: { marginTop: 0 } }, 'Clover, Revel, Lightspeed, Aloha, TouchBistro, SpotOn, Heartland and the rest can all export hours. Choose their report here and Totali reads it, whatever the columns are called.'),
        h('div', { class: 'acts' }, Button({ type: 'button', 'data-testid': 'open-report', onClick: () => reportModal(redraw) }, 'Import a time clock report'))));
  }
  const c = cat.connection;
  if (c.provider === 'file') {
    return h('div', { class: 'stack', style: { '--gap': '16px', maxWidth: '720px' } },
      h('div', { class: 'card' }, h('div', { class: 'ch' }, h('h3', { class: 'ct' }, 'Spreadsheet imports'), h('span', { class: 'cap' }, c.lastSyncAt ? `Last imported ${longDate(c.lastSyncAt.slice(0, 10))}` : '')),
        h('p', { class: 'cap', style: { marginTop: 0 } }, 'Import a report each pay period. Importing the same report again changes nothing, and a corrected report replaces the rows it corrects. Hours that were already paid never change.'),
        h('div', { class: 'acts' }, Button({ type: 'button', 'data-testid': 'open-report', onClick: () => reportModal(redraw) }, 'Import a report'), h('button', { class: 'link as-button', type: 'button', 'data-testid': 'pos-disconnect', onClick: async () => { try { await api.del(`${base()}/pos`); toast('success', 'Done. You can connect a system now.'); redraw(); } catch (e) { toast('error', e.message); } } }, 'Stop using spreadsheets')),
        c.lastSummary ? summaryView(c.lastSummary) : null));
  }
  const periods = (await api.get(`${base()}/payroll/periods`)).periods.filter((p) => p.state !== 'paid').slice(0, 4);
  const periodSel = h('select', { class: 'in', 'aria-label': 'Which pay period', 'data-testid': 'pos-period', style: { minHeight: '38px', padding: '6px 10px' } }, ...periods.map((p) => h('option', { value: `${p.periodStart}|${p.periodEnd}` }, rangeLabel(p.periodStart, p.periodEnd))));
  const last = h('span', { class: 'cap' }, c.lastSyncAt ? `Last pulled ${longDate(c.lastSyncAt.slice(0, 10))}` : 'Not pulled yet');
  const result = h('div', {}, c.lastSummary ? summaryView(c.lastSummary) : null, c.lastError ? Alert('error', c.lastError) : null);
  const go = Button({ type: 'button', 'data-testid': 'pos-pull' }, 'Pull hours and tips');
  go.addEventListener('click', async () => {
    const [from, to] = periodSel.value.split('|');
    setLoading(go, true);
    try { const s = await pull(from, to); result.replaceChildren(summaryView(s)); last.textContent = `Last pulled ${longDate(s.at.slice(0, 10))}`; toast('success', 'Pulled.'); } catch (e) { result.replaceChildren(Alert('error', e.message)); }
    setLoading(go, false);
  });
  const matchHost = h('div', {}, h('div', { class: 'empty' }, 'Loading…'));
  matching(c).then((el) => matchHost.replaceChildren(el)).catch((e) => matchHost.replaceChildren(Alert('error', e.message)));
  const off = h('button', { class: 'link as-button', type: 'button', 'data-testid': 'pos-disconnect', onClick: () => {
    const ok = Button({ type: 'button' }, 'Disconnect');
    const m = modal({ title: `Disconnect ${c.label}?`, body: h('p', { style: { margin: 0 } }, 'Hours already pulled stay where they are. Totali stops reading from it.'), actions: [Button({ variant: 'ghost', onClick: () => m.close() }, 'Keep it'), ok] });
    ok.addEventListener('click', async () => { try { await api.del(`${base()}/pos`); m.close(); toast('success', 'Disconnected.'); await refreshData(); redraw(); } catch (e) { toast('error', e.message); } });
  } }, 'Disconnect');
  return h('div', { class: 'stack', style: { '--gap': '16px', maxWidth: '720px' } },
    h('div', { class: 'card' }, h('div', { class: 'ch' }, h('h3', { class: 'ct' }, c.label), last),
      h('p', { class: 'cap', style: { marginTop: 0 } }, 'Pull before you run payroll. Pulling again replaces what was pulled for those days, and shifts that were already paid never change.'),
      h('div', { class: 'acts' }, periods.length ? periodSel : null, go, off), result),
    h('div', { class: 'card' }, h('div', { class: 'ch' }, h('h3', { class: 'ct' }, 'Who is who')), matchHost));
}

/** On the Run payroll page: one button that pulls this period, then reloads the hours. */
export function pullCard(conn, period) {
  if (!conn || conn.provider === 'file') {
    return h('div', { class: 'card' }, h('div', { class: 'ch' }, h('h3', { class: 'ct' }, 'Time clock report')), h('p', { class: 'cap', style: { marginTop: 0 } }, 'Bring in this period’s hours and tips from a report your point of sale exports.'),
      h('div', { class: 'acts' }, Button({ size: 'sm', type: 'button', 'data-testid': 'pull-hours', onClick: () => reportModal(() => navigate(location.pathname + location.search)) }, 'Import a report')));
  }
  const result = h('div', {});
  const go = Button({ size: 'sm', type: 'button', 'data-testid': 'pull-hours' }, 'Pull hours and tips');
  go.addEventListener('click', async () => {
    setLoading(go, true);
    try {
      const s = await pull(period.periodStart, period.periodEnd);
      if (s.unmapped.length || s.problems.length) { result.replaceChildren(summaryView(s)); setLoading(go, false); toast('warn', 'Pulled, with some people left out.'); return; }
      toast('success', `Pulled ${plural(s.shifts, 'shift')}.`);
      navigate(location.pathname + location.search);
    } catch (e) { result.replaceChildren(Alert('error', e.message)); setLoading(go, false); }
  });
  return h('div', { class: 'card' }, h('div', { class: 'ch' }, h('h3', { class: 'ct' }, conn.label)), h('p', { class: 'cap', style: { marginTop: 0 } }, 'Read this period’s hours and tips from your point of sale.'), h('div', { class: 'acts' }, go), result);
}
