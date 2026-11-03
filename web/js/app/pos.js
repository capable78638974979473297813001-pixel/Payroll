import { h, plural, money, longDate } from '../dom.js';
import { api } from '../api.js';
import { link, navigate } from '../router.js';
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

/** Provider-owned approval. No merchant token fields in the restaurant flow. */
export async function beginProvider(provider, onDone = () => navigate('/app')) {
  if (!provider.signIn) {
    const setup = provider.setup;
    const m = modal({ title: `Set up ${provider.name}`, body: h('div', { class: 'stack' },
      h('p', {}, `Totali’s ${provider.name} app has not been configured on this server. Restaurant sign-in becomes available after the Totali administrator completes provider setup.`),
      setup ? h('div', {}, h('p', {}, setup.requirement), h('a', { href: setup.setupUrl, target: '_blank', rel: 'noopener noreferrer', class: 'link' }, `Open ${provider.name} app setup`),
        h('details', {}, h('summary', {}, 'For the Totali administrator'), h('p', {}, 'Add these provider-issued values in Render → Environment, then redeploy. Do not enter restaurant passwords here.'), h('ul', {}, ...setup.environmentKeys.map(key => h('li', {}, h('code', {}, key)))),
          setup.callbackPath ? h('p', {}, 'Register this HTTPS callback on the provider app: ', h('code', {}, setup.redirectUrl || (location.origin + setup.callbackPath))) : h('p', {}, 'Toast must approve Totali’s partner integration before restaurants can add it.'))) : null),
      actions: [Button({ onClick: () => m.close() }, 'Close')] });
    return;
  }
  if (provider.id !== 'toast') {
    const result = await api.get(`${base()}/pos/${provider.id}/start`);
    location.assign(result.url);
    return;
  }
  const request = await api.post(`${base()}/pos/toast/start`);
  const reference = h('input', { class: 'in', readonly: true, value: request.reference, 'aria-label': 'Toast location reference' });
  const error = h('div', {});
  const verify = Button({}, 'Check Toast approval');
  const m = modal({ title: 'Connect Toast', body: h('div', { class: 'f' },
    h('p', {}, 'Toast approves access through its integration marketplace. Add Totali, then match this restaurant using the location reference below.'),
    h('label', { class: 'lab' }, 'Location reference'), reference,
    h('p', { class: 'cap' }, 'In Toast, add Totali and enter this reference in the integration’s Location ID field. Approval may take 15 minutes or longer to become available.'),
    h('a', { class: 'btn', href: request.url, target: '_blank', rel: 'noopener noreferrer' }, 'Open Toast to approve access'), error),
    actions: [Button({ variant: 'ghost', onClick: () => m.close() }, 'Close'), verify] });
  verify.addEventListener('click', async () => { setLoading(verify, true); try { await api.post(`${base()}/pos/toast/complete`); m.close(); await refreshData(); onDone(); } catch (e) { error.replaceChildren(Alert('error', e.message)); setLoading(verify, false); } });
}

export function providerButtons(cat, onDone) {
  return h('div', { class: 'pos-provider-list' }, ...['square','clover','toast','sevenshifts'].map(id => {
    const provider = cat.providers.find(p => p.id === id);
    if (!provider) return null;
    const error = h('div', {});
    const label = id === 'square' ? (provider.signIn ? 'Connect Square' : 'Set up Square') : (provider.signIn ? `Connect ${provider.name}` : `Set up ${provider.name}`);
    const connect = Button({ variant: 'secondary', type: 'button', 'data-provider': id, ...(id === 'square' ? { 'data-testid': 'connect-square' } : {}) }, label);
    connect.addEventListener('click', async () => { setLoading(connect, true); try { await beginProvider(provider, onDone); } catch (e) { error.replaceChildren(Alert('error', e.message)); } finally { setLoading(connect, false); } });
    const hint = provider.signIn ? (id === 'square' ? 'Sandbox only. One click approves read access at Square.' : id === 'toast' ? 'Approve in Toast’s marketplace' : `Approve access at ${provider.name}`) : 'Provider app setup required';
    return h('section', { class: 'pos-provider-option' }, h('div', {}, h('strong', {}, provider.name), h('small', {}, hint)), connect, error);
  }));
}

function connectForm(cat, after) { return providerButtons(cat, after); }

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
  const q = new URLSearchParams(location.search);
  const flash = q.get('pos_error') ? Alert('error', q.get('pos_error')) : q.get('pos') === 'connected' ? Alert('success', 'Connected.') : null;
  const redraw = () => navigate(location.pathname + location.search);
  if (!cat.connection) {
    return h('div', { class: 'stack', style: { '--gap': '16px', maxWidth: '640px' } }, flash,
      h('div', { class: 'card' }, h('div', { class: 'ch' }, h('h3', { class: 'ct' }, 'Connect your point of sale')),
        h('p', { class: 'cap', style: { marginTop: 0 } }, 'Totali doesn’t ring up sales. It reads your staff, their hours and their tips from the system you already use, so nobody types them twice. Connect a supported source before running payroll.'),
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

const ago = (iso) => {
  const d = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  return d <= 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`;
};

/** The dashboard card that says where hours and tips come from, and whether that is up to date. */
export const posCards = {
  pos_status({ data }) {
    const p = data.pos;
    if (!p.connected) {
      return { title: 'Hours and tips', body: h('div', { class: 'stack', style: { '--gap': '10px' }, 'data-testid': 'pos-none' },
        h('p', { class: 'cap', style: { margin: 0 } }, 'Hours and tips are entered by hand. If you use Toast, Square, Clover or 7shifts, Totali can pull them for you. Any other system can export a report.'),
        h('div', { class: 'acts' }, link('/app/settings/pos', { class: 'btn sm' }, 'Connect your point of sale'), link('/app/settings/pos', { class: 'link' }, 'Import a report'))) };
    }
    const s = p.summary;
    const file = p.provider === 'file';
    return { title: 'Hours and tips', body: h('div', { class: 'stack', style: { '--gap': '10px' }, 'data-testid': 'pos-live' },
      h('p', { style: { margin: 0 } }, h('b', {}, p.label), p.lastSyncAt ? ` · ${file ? 'last imported' : 'last pulled'} ${ago(p.lastSyncAt)}` : ' · nothing pulled yet'),
      s ? h('p', { class: 'cap', style: { margin: 0 } }, `${plural(s.shifts, 'shift')} for ${plural(s.people, 'person', 'people')}, ${hours(s.minutes)}${s.tipsCents ? `, ${money(s.tipsCents)} in tips` : ''}. ${rangeLabel(s.from, s.to)}.`) : null,
      p.lastError ? Alert('error', p.lastError) : null,
      s && s.unmapped ? Alert('warn', `${plural(s.unmapped, 'person', 'people')} left out: not matched to your team.`, 'Match them so their hours count.') : null,
      s && s.problems ? Alert('warn', `${plural(s.problems, 'shift')} couldn’t be saved.`) : null,
      h('div', { class: 'acts' }, link('/app/payroll/run', { class: 'btn sm' }, file ? 'Import for this pay run' : 'Pull for this pay run'), link('/app/settings/pos', { class: 'link' }, 'Point of sale settings'))) };
  },
};

/** The guided setup: what is done, what is next, how long it takes. It disappears when the last step is done. */
export const guideCards = {
  setup_guide({ data }) {
    const g = data.guide;
    if (g.done === g.total) return { title: null, className: 'hidden-card', body: h('span', { 'data-testid': 'setup-done', hidden: true }) };
    const next = g.steps.find((x) => !x.done);
    return { title: null, className: 'setupguide', head: h('div', { class: 'ch' }, h('h3', { class: 'ct' }, 'Get set up'), h('span', { class: 'cap', 'data-testid': 'setup-progress' }, `${g.done} of ${g.total} done · about ${g.minutes} minutes left`)),
      body: h('div', { class: 'stack', style: { '--gap': '4px' }, 'data-testid': 'setup-guide' },
        h('div', { class: 'prg' }, h('span', { style: { width: `${(g.done / g.total) * 100}%` } })),
        ...g.steps.map((x) => h('div', { class: `row setup-row ${x.done ? 'is-done' : x === next ? 'is-next' : ''}`, 'data-step': x.id },
          h('span', { class: 'setup-mark', 'aria-hidden': 'true' }, x.done ? '✓' : ''),
          h('span', { class: 'l1' }, h('b', {}, x.title), h('i', {}, x.done ? 'Done' : x.detail)),
          x.done ? null : h('span', {}, link(x.to, { class: x === next ? 'btn sm' : 'link' }, x === next ? 'Start' : 'Open'))))) };
  },
};
