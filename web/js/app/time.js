import { h, money } from '../dom.js';
import { api } from '../api.js';
import { Alert, Chip, toast } from '../ui.js';
import { base } from './state.js';

// The tips card shows this week.
const bus = new EventTarget();
const shared = { offset: 0 };
const addDays = (iso, n) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const range = (data) => { const start = addDays(data.hours.weekStart, shared.offset * 7); return [start, addDays(start, 6)]; };

export const timeCards = {
  tips_panel({ data }) {
    const body = h('div', {}, h('div', { class: 'empty' }, 'Loading…'));
    const badge = h('span', {});
    const load = async () => {
      const [from, to] = range(data);
      try {
        const r = await api.get(`${base()}/time/days?start=${from}&end=${to}`);
        const t = r.tips;
        badge.replaceChildren(t.poolOn ? Chip('Tip pool on', 'ok') : Chip('No tip pool', 'line'));
        const stat = (l, v) => h('div', {}, h('i', {}, l), h('b', {}, v));
        const toggle = async () => {
          try {
            const co = await api.get(base());
            const basis = t.basis === 'hours' ? 'points' : 'hours';
            await api.patch(base(), { settings: { ...co.settings, policy: { ...co.settings.policy, pool: { ...co.settings.policy.pool, basis } } } });
            toast('success', `Tips now split ${basis === 'hours' ? 'by hours worked' : 'by role'}.`); bus.dispatchEvent(new Event('edited')); load();
          } catch (e) { toast('error', e.message); }
        };
        body.replaceChildren(
          h('div', { class: 'stats s3', style: { marginBottom: '12px' } }, stat('Card tips', money(t.chargedCents)), stat('Cash tips', money(t.cashCents)), stat('Total', money(t.totalCents))),
          t.pool ? h('div', {}, h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, h('th', {}, 'Who shares'), h('th', {}, 'Hours'), h('th', {}, 'Their share'))), h('tbody', {}, ...t.pool.rows.map((p) => h('tr', {}, h('td', {}, p.name), h('td', {}, `${p.hours} hrs`), h('td', {}, h('b', {}, money(p.shareCents))))))),
            h('p', { class: 'cap', style: { marginTop: '10px' } }, `Split ${t.basis === 'points' ? 'by role' : 'by hours worked'}. `, h('button', { class: 'link as-button', type: 'button', 'data-testid': 'toggle-split', onClick: toggle }, `Change to ${t.basis === 'points' ? 'by hours' : 'by role'}`)))
            : h('p', { class: 'cap' }, t.totalCents ? (t.poolOn ? 'No one in the pool has hours this week yet.' : 'Tips go to the person who earned them. Turn on a tip pool in Settings.') : 'No tips entered this week. Enter them when you ', t.totalCents ? null : link('/app/payroll/run', { class: 'link' }, 'run payroll'), t.totalCents ? null : '.'));
      } catch (e) { body.replaceChildren(Alert('error', e.message)); }
    };
    bus.addEventListener('week', load); bus.addEventListener('edited', load);
    load();
    return { title: null, head: h('div', { class: 'ch' }, h('h3', { class: 'ct' }, 'Tips'), badge), body };
  },
};
