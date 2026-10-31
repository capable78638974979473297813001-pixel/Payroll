import { h, money, shortDate, longDate, hoursFromMinutes, plural } from '../dom.js';
import { link, navigate } from '../router.js';
import { Button, Alert, setLoading } from '../ui.js';
import { api } from '../api.js';
import { base, refreshData } from './state.js';
import { providerButtons } from './pos.js';

/** Payroll is organized around its source and selected period, not unrelated dashboard metrics. */
export async function restaurantOverview(data, { customize, periodStart } = {}) {
  const [catalog, periods] = await Promise.all([api.get(`${base()}/pos`), api.get(`${base()}/payroll/periods`)]);
  const period = periods.periods.find(p => p.periodStart === periodStart) || periods.periods.find(p => p.periodStart === data.nextPayroll.period.periodStart) || periods.periods[0];
  if (!period) return h('section', { class: 'empty' }, h('h1', {}, 'Payroll'), h('p', {}, 'Set up a pay schedule to get started.'), Button({ href: '/app/settings' }, 'Pay settings'));
  const source = await api.get(`${base()}/pos/workspace?start=${period.periodStart}&end=${period.periodEnd}`);
  const readiness = source.readiness;
  const draft = data.runs.find(r => r.periodStart === period.periodStart && r.periodEnd === period.periodEnd && r.status !== 'voided');
  const approved = draft && draft.status !== 'draft';
  const selector = h('select', { class: 'in', 'aria-label': 'Payroll period', onChange: e => navigate(`/app?period=${e.target.value}`) }, ...periods.periods.map(p => h('option', { value: p.periodStart, selected: p.periodStart === period.periodStart }, `${shortDate(p.periodStart)} – ${shortDate(p.periodEnd)}`)));
  const content = h('div', { class: 'ops-workspace', 'data-testid': 'restaurant-overview' });
  const error = h('div', { role: 'status' });
  const action = approved ? Button({ href: `/app/payroll/runs/${draft.id}` }, 'Open payroll') : Button({ href: readiness.ready ? (draft ? `/app/payroll/runs/${draft.id}` : `/app/payroll/run?start=${period.periodStart}&end=${period.periodEnd}&check=${period.checkDate}`) : undefined, disabled: !readiness.ready, 'data-testid': 'run-payroll' }, draft ? 'Continue payroll' : 'Run payroll');
  const sync = Button({ variant: 'secondary', disabled: !readiness.connected, 'data-testid': 'sync-pos' }, 'Sync from POS');
  sync.addEventListener('click', async () => { setLoading(sync,true); try { await api.post(`${base()}/pos/sync`,{from:period.periodStart,to:period.periodEnd}); await refreshData(); navigate(`/app?period=${period.periodStart}`); } catch(e) { error.replaceChildren(Alert('error',e.message)); setLoading(sync,false); } });
  content.append(h('div', { class: 'ops-page-heading' }, h('div', {}, h('h1', {}, 'Payroll'), h('p', {}, data.company.name)), h('div', { class: 'acts' }, Button({ variant:'ghost',size:'sm',onClick:customize,'data-testid':'customize'}, 'Customize'), action)),
    h('div', { class: 'ops-period-toolbar' }, h('label', {}, 'Pay period', selector), h('div', {}, h('small', {}, 'Pay date'), h('b', {}, longDate(period.checkDate))), h('div', {}, h('small', {}, 'Source'), h('b', {}, readiness.connected ? readiness.label : 'Not connected')), sync),
    h('div', { class: `ops-source-line ${readiness.ready ? 'is-ready' : 'needs-attention'}` }, h('span', { class:'ops-status-dot','aria-hidden':'true' }), h('strong', {}, approved ? 'Payroll approved' : readiness.ready ? 'POS data ready for payroll' : readiness.connected ? 'POS connected — review required' : 'Connect a POS to run payroll'), h('span', {}, readiness.lastSyncAt ? `Last synced ${new Date(readiness.lastSyncAt).toLocaleString()}` : 'No import yet'), link('/app/settings/pos', {}, 'Manage connection')), error);
  if (!readiness.connected) {
    content.append(h('section', { class: 'ops-connect' }, h('div', {}, h('h2', {}, 'Where do your hours come from?'), h('p', {}, 'Connect the system your restaurant uses. Approve access there, match your employees, then import this pay period. Payroll stays locked until the source is ready.')), providerButtons(catalog)));
    return content;
  }
  if (readiness.reasons.length) content.append(h('section', { class: 'ops-exceptions' }, h('h2', {}, 'Before you run payroll'), ...readiness.reasons.map(reason => h('div', {}, h('span', {}, reason.message), link(reason.to, {}, reason.code === 'pos_period_missing' || reason.code === 'pos_sync_failed' ? 'Import this period' : 'Resolve')))));
  const summary = source.summary;
  content.append(h('div', { class:'ops-totals' }, ...[['Imported shifts', String(source.totals.shifts)],['Employees',String(source.totals.people)],['Hours',hoursFromMinutes(source.totals.minutes)],['Card tips',money(source.totals.cardTipsCents)],['Cash tips',money(source.totals.cashTipsCents)]].map(([label,value])=>h('div',{},h('small',{},label),h('b',{},value)))),
    h('div',{class:'ops-table-heading'},h('div',{},h('h2',{},'Imported timecards'),h('p',{},`${readiness.label} · ${shortDate(period.periodStart)} – ${shortDate(period.periodEnd)} · Restaurant local dates`)),link('/app/settings/pos',{},'Employee matching')));
  const search = h('input',{type:'search',class:'in',placeholder:'Find an employee','aria-label':'Find an employee'});
  const body = h('tbody',{});
  let page = 0;
  const pageLabel = h('span',{}),prev = Button({variant:'ghost',size:'sm'},'Previous'),next = Button({variant:'ghost',size:'sm'},'Next');
  function draw() {
    const query=search.value.trim().toLowerCase();const rows=source.rows.filter(r=>(r.name+' '+r.role+' '+(r.location||'')).toLowerCase().includes(query));
    const slice=rows.slice(page*25,page*25+25);
    body.replaceChildren(...slice.map(r=>h('tr',{},h('td',{},h('b',{},r.name),h('small',{},r.role)),h('td',{},shortDate(r.workDate)),h('td',{},r.location||'—'),h('td',{class:'numeric'},hoursFromMinutes(r.minutes)),h('td',{class:'numeric'},money(r.cardTipsCents)),h('td',{class:'numeric'},money(r.cashTipsCents)),h('td',{},h('details',{},h('summary',{},'Details'),h('dl',{},h('dt',{},'Source record'),h('dd',{},r.sourceId),h('dt',{},'Clock in'),h('dd',{},r.clockIn?new Date(r.clockIn).toLocaleString():'Not provided'),h('dt',{},'Clock out'),h('dd',{},r.clockOut?new Date(r.clockOut).toLocaleString():'Not provided'),h('dt',{},'Payroll state'),h('dd',{},r.locked?'Locked by payroll':'Open')))))));
    if(!rows.length)body.append(h('tr',{},h('td',{colspan:7},'No imported timecards for this selection.')));
    pageLabel.textContent=`${rows.length ? page*25+1 : 0}–${Math.min((page+1)*25,rows.length)} of ${rows.length}`;prev.disabled=page===0;next.disabled=(page+1)*25>=rows.length;
  }
  search.addEventListener('input',()=>{page=0;draw()});prev.addEventListener('click',()=>{page--;draw()});next.addEventListener('click',()=>{page++;draw()});draw();
  content.append(h('div',{class:'ops-table-tools'},search,h('span',{},'Labor data only. Sales and orders are not imported.')),
    h('div',{class:'ops-table-scroll'},h('table',{class:'ops-table'},h('thead',{},h('tr',{},...['Employee','Date','Location','Hours','Card tips','Cash tips','Source'].map(t=>h('th',{},t)))),body)),
    h('div',{class:'ops-table-footer'},pageLabel,h('div',{class:'acts'},prev,next)));
  if(summary?.unmapped.length) content.append(h('section',{class:'ops-exceptions'},h('h2',{},'Not included in payroll'),...summary.unmapped.map(p=>h('div',{},h('span',{},`${p.name} · ${hoursFromMinutes(p.minutes)} hours · not matched`),link('/app/settings/pos',{},'Match employee')))));
  if(summary?.notes.length) content.append(h('details',{class:'ops-import-notes'},h('summary',{},'Import notes'),...summary.notes.map(n=>h('p',{},n))));
  return content;
}
