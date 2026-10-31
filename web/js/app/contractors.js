import { h, money, longDate, plural } from '../dom.js';
import { api } from '../api.js';
import { navigate } from '../router.js';
import { Button, Alert, Chip, Field, modal, setLoading, toast } from '../ui.js';
import { who, dollarsToCents } from './payroll.js';
import { appPage } from './shell.js';
import { base, refreshData } from './state.js';

function copyModal(name, url, why) {
  const input = h('input', { class: 'in', readonly: true, value: url, 'aria-label': 'Private link', onFocus: (e) => e.target.select() });
  const copy = Button({ size: 'sm', type: 'button' }, 'Copy link');
  copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(url); copy.firstChild.textContent = 'Copied'; } catch { input.select(); } });
  const m = modal({ title: `Send ${name} their W-9 link`, body: h('div', { class: 'f' }, why ? Alert('warn', why) : null, h('p', { class: 'fine', style: { margin: 0 } }, 'It’s only for them and works for 30 days.'), h('div', { style: { display: 'flex', gap: '8px' } }, input, copy)), actions: [Button({ onClick: () => m.close() }, 'Done')] });
}

export function contractorsPage() {
  return async (ctx) => appPage(ctx, { active: 'people', title: 'Contractors', render: async () => {
    await refreshData();
    const year = Number(ctx.query.get('year')) || new Date().getFullYear();
    const r = await api.get(`${base()}/contractors?year=${year}`);
    const redraw = () => navigate(location.pathname + location.search);
    const stat = (l, v, small) => h('div', {}, h('i', {}, l), h('b', {}, v), small ? h('small', {}, small) : null);

    function add() {
      const name = Field({ label: 'Name', name: 'name', autofocus: true });
      const biz = Field({ label: 'Business name', name: 'businessName', optional: true });
      const email = Field({ label: 'Email', name: 'email', type: 'email', optional: true, hint: 'We’ll send them a link for their W-9.' });
      const err = h('div', {}); const go = Button({}, 'Add contractor');
      const m = modal({ title: 'Add a contractor', body: h('div', { class: 'f' }, name.el, biz.el, email.el, err), actions: [Button({ variant: 'ghost', onClick: () => m.close() }, 'Cancel'), go] });
      go.addEventListener('click', async () => { setLoading(go, true); try { await api.post(`${base()}/contractors`, { name: name.value, businessName: biz.value, email: email.value }); m.close(); toast('success', 'Added.'); redraw(); } catch (e) { const t = { name, email }[e.details && e.details.field]; if (t) t.setError(e.message); else err.replaceChildren(Alert('error', e.message)); setLoading(go, false); } });
    }

    function payments(c) {
      const date = Field({ label: 'Date paid', name: 'date', type: 'date', value: new Date().toISOString().slice(0, 10) });
      const amount = Field({ label: 'Amount', name: 'amount', placeholder: '1,250.00', inputmode: 'decimal' });
      const note = Field({ label: 'For', name: 'note', optional: true, placeholder: 'Water heater, Oct 12' });
      const err = h('div', {}); const go = Button({ size: 'sm' }, 'Add payment');
      const list = h('div', {}, ...(c.payments.length ? c.payments.map((p) => h('div', { class: 'row' }, h('span', { class: 'l1' }, h('b', {}, money(p.amountCents)), h('i', {}, `${longDate(p.date)}${p.note ? ` · ${p.note}` : ''}`)), h('button', { class: 'link as-button', type: 'button', onClick: async () => { try { await api.del(`${base()}/contractors/${c.id}/payments/${p.id}`); m.close(); redraw(); } catch (e) { toast('error', e.message); } } }, 'Remove'))) : [h('p', { class: 'cap' }, `Nothing recorded for ${year}.`)]));
      const m = modal({ title: `${c.name}, ${year}`, body: h('div', { class: 'f' }, h('p', { class: 'fine', style: { margin: 0 } }, 'Record what you paid them outside payroll, by check, card or transfer. Totali doesn’t send this money.'), list, h('hr', { class: 'sep' }), h('div', { class: 'r2' }, date.el, amount.el), note.el, err), actions: [Button({ variant: 'ghost', onClick: () => m.close() }, 'Close'), go] });
      go.addEventListener('click', async () => {
        const cents = dollarsToCents(amount.value);
        if (!cents) return amount.setError('Enter an amount, like 1250.00.');
        setLoading(go, true);
        try { await api.post(`${base()}/contractors/${c.id}/payments`, { date: date.value, amountCents: cents, note: note.value }); m.close(); toast('success', 'Recorded.'); redraw(); } catch (e) { err.replaceChildren(Alert('error', e.message)); setLoading(go, false); }
      });
    }

    async function w9(c, btn) {
      setLoading(btn, true);
      try { const res = await api.post(`${base()}/contractors/${c.id}/w9-request`); if (res.emailed) toast('success', `W-9 request sent to ${c.name}.`); else copyModal(c.name, res.link, c.email ? 'Email isn’t set up on this server, so nothing was sent.' : 'They have no email on file.'); redraw(); } catch (e) { toast('error', e.message); setLoading(btn, false); }
    }

    const years = [year + 1 <= new Date().getFullYear() ? null : null, new Date().getFullYear(), new Date().getFullYear() - 1, new Date().getFullYear() - 2].filter(Boolean);
    const rows = r.contractors.map((c) => {
      const w9b = c.w9 ? null : (() => { const b = h('button', { class: 'link as-button', type: 'button', 'data-w9': c.id }, c.linkOpen ? 'Resend W-9 link' : 'Request W-9'); b.addEventListener('click', () => w9(c, b)); return b; })();
      return h('tr', { 'data-contractor': c.id }, h('td', {}, who(c.name, c.businessName || c.email || '')), h('td', { class: 'l' }, h('span', { class: `dt ${c.w9 ? 'ok' : 'no'}` }, c.w9 ? `W-9${c.tinLast4 ? ` ···${c.tinLast4}` : ''}` : 'W-9')), h('td', {}, money(c.paidCents)), h('td', { class: 'l' }, c.needs1099 ? Chip('1099 needed', 'warn') : Chip('Under the line', 'line')), h('td', { class: 'l' }, h('button', { class: 'link as-button', type: 'button', 'data-payments': c.id, onClick: () => payments(c) }, 'Payments'), w9b ? ' · ' : null, w9b));
    });
    return h('div', {}, h('div', { class: 'ph2' }, h('div', {}, h('h1', { class: 'pt' }, h('em', {}, 'Contractors')), h('p', {}, 'Paid by invoice, kept apart from payroll')),
      h('div', { class: 'acts' }, Button({ variant: 'ghost', size: 'sm', type: 'button', onClick: async () => { try { await api.download(`${base()}/contractors/export?year=${year}`, `contractors-${year}.csv`); } catch (e) { toast('error', e.message); } } }, `Export ${year} for your accountant`), Button({ size: 'sm', type: 'button', 'data-testid': 'add-contractor', onClick: add }, 'Add contractor'))),
      h('div', { style: { margin: '0 0 18px' } }, h('div', { class: 'stats' }, stat('Contractors', String(r.count)), stat('W-9s collected', `${r.w9} of ${r.count}`), stat(`Paid in ${year}`, money(r.paidCents)), stat('Over the 1099-NEC line', String(r.needs1099), `${money(r.thresholdCents)} or more in ${year}`))),
      h('div', { class: 'card' }, h('div', { class: 'ch' }, h('div', { class: 'chips2' }, ...years.map((y) => h('button', { type: 'button', class: `pill ${y === year ? 'on' : ''}`, onClick: () => navigate(`/app/contractors?year=${y}`) }, String(y)))), h('span', { class: 'cap' }, '1099-NEC is filed for contractors paid at least the line in a year.')),
        r.contractors.length ? h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, h('th', {}, 'Contractor'), h('th', { class: 'l' }, 'W-9'), h('th', {}, `Paid in ${year}`), h('th', { class: 'l' }, '1099'), h('th', { class: 'l' }))), h('tbody', {}, ...rows)) : h('div', { class: 'empty' }, 'No contractors yet. Add one to track what you pay them and collect their W-9.')),
      h('p', { class: 'cap', style: { marginTop: '14px', maxWidth: '70ch' } }, 'Totali keeps the records and flags who crossed the line. It doesn’t file your 1099s: hand the export to your accountant or your filing service.'));
  } });
}
