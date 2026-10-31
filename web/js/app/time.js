import { h, money, shortDate, hoursFromMinutes } from '../dom.js';
import { api } from '../api.js';
import { link } from '../router.js';
import { Button, Alert, Chip, toast } from '../ui.js';
import { who, hoursToMinutes } from './payroll.js';
import { base, refreshData } from './state.js';

// The two Time and tips cards share one week: moving it in one moves the other, and an edit in one refreshes the other.
const bus = new EventTarget();
const shared = { offset: 0 };
const addDays = (iso, n) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const range = (data) => { const start = addDays(data.hours.weekStart, shared.offset * 7); return [start, addDays(start, 6)]; };
const dayName = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
const hoursText = (m) => (m === 0 ? '' : hoursFromMinutes(m));

export const timeCards = {
  time_week({ settings, data }) {
    const body = h('div', {}, h('div', { class: 'empty' }, 'Loading…'));
    const cap = h('span', { class: 'cap' });
    const load = async () => {
      const [from, to] = range(data);
      try {
        const r = await api.get(`${base()}/time/days?start=${from}&end=${to}`);
        const locs = data.company.locations || [];
        cap.textContent = `${shortDate(from)} to ${shortDate(to)}${locs.length > 1 ? ' · All locations' : ''}`;
        const totals = r.days.map((_, i) => r.people.reduce((n, p) => n + p.perDay[i].minutes, 0));
        const cells = new Map();
        const rows = r.people.map((p) => {
          const totalCell = h('td', {}, h('b', {}, hoursText(p.totalMinutes) || '–'));
          const tds = p.perDay.map((d, i) => {
            const date = r.days[i];
            const off = date < p.hiredOn;
            const input = h('input', { value: hoursText(d.minutes), inputmode: 'decimal', 'aria-label': `${p.name}, ${dayName(date)} ${shortDate(date)}`, 'data-employee': p.employeeId, 'data-date': date, disabled: d.locked || d.shifts > 1 || off, title: d.locked ? 'Already paid' : d.shifts > 1 ? 'More than one shift this day' : off ? 'Before their start date' : '', style: { width: '54px' } });
            const prev = { m: d.minutes };
            input.addEventListener('change', async () => {
              const m = hoursToMinutes(input.value);
              if (m === null || m > 1440) { toast('error', 'Hours must be a number from 0 to 24.'); input.value = hoursText(prev.m); return; }
              if (m === prev.m) return;
              try {
                await api.put(`${base()}/time/day`, { employeeId: p.employeeId, date, minutes: m });
                p.totalMinutes += m - prev.m; prev.m = m;
                totalCell.firstChild.textContent = hoursText(p.totalMinutes) || '–';
                input.value = hoursText(m);
                bus.dispatchEvent(new Event('edited'));
                await refreshData();
              } catch (e) { toast('error', e.message); input.value = hoursText(prev.m); }
            });
            return h('td', {}, input);
          });
          return h('tr', { 'data-employee': p.employeeId }, h('td', {}, who(p.name, settings.showLocation === false ? p.role : `${p.role}${p.location ? `, ${p.location}` : ''}`)), ...tds, totalCell);
        });
        body.replaceChildren(r.people.length ? h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, h('th', {}, 'Employee'), ...r.days.map((d) => h('th', {}, dayName(d))), h('th', {}, 'Total'))),
          h('tbody', {}, ...rows, h('tr', { class: 'tot' }, h('td', {}, 'Total hours'), ...totals.map((m) => h('td', {}, hoursText(m) || '–')), h('td', {}, hoursFromMinutes(totals.reduce((a, b) => a + b, 0)) || '0')))) : h('div', { class: 'empty' }, 'Nobody was employed this week. ', link('/app/onboarding', { class: 'link' }, 'Invite your first person')),
          h('p', { class: 'cap', style: { marginTop: '10px' } }, 'Type hours in any day. Overtime is worked out when you run payroll.'));
      } catch (e) { body.replaceChildren(Alert('error', e.message)); }
    };
    const move = (n) => () => { shared.offset += n; bus.dispatchEvent(new Event('week')); };
    bus.addEventListener('week', load);
    load();
    return { title: null, head: h('div', { class: 'ch' }, h('h3', { class: 'ct' }, shared.offset === 0 ? 'Hours this week' : 'Hours'), h('span', { style: { display: 'flex', gap: '10px', alignItems: 'center' } }, cap, Button({ variant: 'ghost', size: 'sm', type: 'button', 'data-testid': 'prev-week', onClick: move(-1) }, 'Previous week'), Button({ variant: 'ghost', size: 'sm', type: 'button', 'data-testid': 'next-week', onClick: move(1) }, 'Next week'))), body };
  },

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
