import { h, money, plural } from '../dom.js';
import { link } from '../router.js';
import { Alert } from '../ui.js';

const hrs = (m) => `${Math.round((m / 60) * 10) / 10}`;
const stat = (l, v, s) => h('div', {}, h('i', {}, l), h('b', {}, v), s ? h('small', {}, s) : null);

/** Cards that only make sense for a restaurant: what the week is costing, by position, with the overtime watch restaurants use. */
export const restaurantCards = {
  week_snapshot({ data }) {
    const hw = data.hours; const w = data.week; const t = data.tips;
    const tips = t.chargedCents + t.cashCents;
    const empty = hw.totalMinutes === 0;
    const ot = w.overtimeShare;
    return { title: `This week at ${data.company.name}`, body: h('div', { class: 'stack', style: { '--gap': '12px' }, 'data-testid': 'week-snapshot' },
      empty ? h('p', { class: 'cap', style: { margin: 0 } }, 'No hours in yet this week. Pull them from your point of sale and they show here.') : h('div', { class: 'stats' },
        stat('Hours worked', hrs(hw.totalMinutes), `${plural(w.workers, 'person', 'people')} on the clock`),
        stat('Estimated wages', money(w.wagesCents), 'Before taxes and benefits'),
        stat('Tips', money(tips), tips ? `${money(t.chargedCents)} card, ${money(t.cashCents)} cash` : 'None yet'),
        stat('Overtime', `${ot}%`, ot > 5 ? 'Above the 5% restaurants usually aim for' : 'Of hours worked')),
      !empty && ot > 5 ? Alert('warn', `Overtime is ${ot}% of this week’s hours.`, hw.people.slice(0, 3).filter((p) => p.minutes > 2400).map((p) => `${p.name} ${hrs(p.minutes)} h`).join(', ') || undefined) : null,
      !empty && w.byPlace.length > 1 ? h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, h('th', {}, 'Location'), h('th', {}, 'Hours'), h('th', {}, 'Est. wages'))),
        h('tbody', {}, ...w.byPlace.map((p) => h('tr', {}, h('td', {}, p.name), h('td', {}, hrs(p.minutes)), h('td', {}, money(p.wagesCents)))))) : null,
      h('p', { class: 'cap', style: { margin: 0 } }, `${data.company.nicheLabel ? `${data.company.nicheLabel}. ` : ''}Wages are an estimate from each person’s rate, with overtime at time and a half. `, link('/app/payroll/run', { class: 'link' }, 'Run payroll for the exact figures'))) };
  },

  labor_by_role({ data }) {
    const rows = data.week.byRole;
    const anyTips = rows.some((r) => r.tipsCents > 0);
    return { title: 'Labor by position', body: rows.length ? h('table', { class: 'tbl', 'data-testid': 'labor-by-role' }, h('thead', {}, h('tr', {}, h('th', {}, 'Position'), h('th', {}, 'People'), h('th', {}, 'Hours'), h('th', {}, 'Est. wages'), anyTips ? h('th', {}, 'Tips') : null)),
      h('tbody', {}, ...rows.map((r) => h('tr', { 'data-role': r.role }, h('td', {}, r.label), h('td', {}, String(r.people)), h('td', {}, hrs(r.minutes)), h('td', {}, money(r.wagesCents)), anyTips ? h('td', {}, r.tipsCents ? money(r.tipsCents) : '') : null))))
      : h('div', { class: 'empty' }, 'Hours by position show here once this week’s hours come in. ', link('/app/settings/pos', { class: 'link' }, 'Connect your POS')) };
  },
};
