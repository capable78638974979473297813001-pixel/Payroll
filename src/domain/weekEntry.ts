import { badRequest, conflict } from '../lib/errors.ts';
import * as v from '../lib/validate.ts';
import { daysBetween, eachDay } from '../lib/dates.ts';
import type { Store } from '../store/store.ts';
import type { Company, Employee } from './types.ts';
import { recordShift } from './timekeeping.ts';
import { formsOf, tipPoolFor } from '../dashboard/data.ts';

/**
 * The run-payroll grid enters a whole pay period at once: regular hours, overtime hours and tips for each person.
 * Underneath, Totali keeps shifts, because that is what taxes, overtime and the tip rules are worked out from. A weekly
 * entry becomes a handful of shifts spread over the period's days, marked `week:` so they can be replaced when the
 * grid is saved again. Overtime is always worked out from the hours, never typed: 46 hours is 40 regular and 6 overtime
 * however the two boxes were filled in.
 */

const MAX_DAY_MINUTES = 720;
const WEEK_MINUTES = 2400;
const isWeekEntry = (externalId?: string) => !!externalId && externalId.startsWith('week:');
const employedInPeriod = (e: Employee, from: string, to: string) => e.hireDate <= to && (!e.terminationDate || e.terminationDate >= from);

function checkPeriod(from: string, to: string) {
  if (to < from) throw badRequest('The period ends before it starts.');
  if (daysBetween(from, to) > 30) throw badRequest('A pay period cannot be longer than 31 days.');
}

export function weekSummary(store: Store, company: Company, from: string, to: string) {
  checkPeriod(from, to);
  const roles = new Map(company.settings.roles.map((r) => [r.key, r]));
  const wantsStateForm = false;
  const weeks = Math.max(1, Math.ceil((daysBetween(from, to) + 1) / 7));
  const shifts = store.shifts.where((s) => s.companyId === company.id && s.workDate >= from && s.workDate <= to);
  const people = store.employees.where((e) => e.companyId === company.id && employedInPeriod(e, from, to)).sort((a, b) => a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName)).map((e) => {
    const mine = shifts.filter((s) => s.employeeId === e.id);
    const total = mine.reduce((n, s) => n + s.minutes, 0);
    const regular = Math.min(total, WEEK_MINUTES * weeks);
    return {
      employeeId: e.id,
      name: `${e.firstName} ${e.lastName}`,
      role: roles.get(e.roleKey)?.label ?? e.roleKey,
      tipped: roles.get(e.roleKey)?.tipped !== 'never',
      location: e.location ?? null,
      regularMinutes: regular,
      overtimeMinutes: total - regular,
      tipsCents: mine.reduce((n, s) => n + s.chargedTipsCents + s.cashTipsCents, 0),
      shiftByShift: mine.some((s) => !isWeekEntry(s.externalId)),
      locked: mine.some((s) => !!s.lockedByRunId),
      w4Missing: !formsOf(e, wantsStateForm).w4,
    };
  });
  return { periodStart: from, periodEnd: to, people };
}

/** Split `total` into `n` near-equal whole parts. */
const splitEven = (total: number, n: number) => Array.from({ length: n }, (_, i) => Math.floor(total / n) + (i < total % n ? 1 : 0));

export function saveWeek(store: Store, company: Company, body: unknown) {
  const o = v.obj(body);
  const from = v.date(o, 'periodStart');
  const to = v.date(o, 'periodEnd');
  checkPeriod(from, to);
  if (!Array.isArray(o.entries) || o.entries.length === 0) throw badRequest('Nothing to save.');
  if (o.entries.length > 500) throw badRequest('At most 500 people at a time.');

  store.tx(() => {
    for (const [i, raw] of (o.entries as unknown[]).entries()) {
      const e = v.obj(raw, `entries[${i}]`);
      const emp = store.employees.get(v.str(e, 'employeeId'));
      if (!emp || emp.companyId !== company.id) throw badRequest(`entries[${i}] is not someone at this company.`);
      const name = `${emp.firstName} ${emp.lastName}`;
      const regular = e.regularMinutes === undefined ? 0 : v.int(e, 'regularMinutes', 0, 44_640);
      const overtime = e.overtimeMinutes === undefined ? 0 : v.int(e, 'overtimeMinutes', 0, 44_640);
      const tips = e.tipsCents === undefined ? 0 : v.cents(e, 'tipsCents');
      const total = regular + overtime;

      const mine = store.shifts.where((s) => s.companyId === company.id && s.employeeId === emp.id && s.workDate >= from && s.workDate <= to);
      if (mine.some((s) => s.lockedByRunId)) throw conflict('period_closed', `${name}'s time in this period was already paid.`);
      if (mine.some((s) => !isWeekEntry(s.externalId))) {
        // Shift-by-shift time (a POS sync, or entered shift by shift) is never overwritten by a weekly box.
        const sum = mine.reduce((n, s) => n + s.minutes, 0);
        const tipSum = mine.reduce((n, s) => n + s.chargedTipsCents + s.cashTipsCents, 0);
        if (sum !== total || tipSum !== tips) throw conflict('detailed_time_exists', `${name} has shift-by-shift time in this period. Change it on the shifts, not here.`);
        continue;
      }
      for (const s of mine) store.shifts.delete(s.id);
      if (total === 0 && tips === 0) continue;

      const start = emp.hireDate > from ? emp.hireDate : from;
      const end = emp.terminationDate && emp.terminationDate < to ? emp.terminationDate : to;
      if (end < start) throw badRequest(`${name} was not employed in this period.`);
      const days = eachDay(start, end);
      const nWeeks = Math.max(1, Math.ceil(days.length / 7));
      const perWeek = splitEven(total, nWeeks);
      let n = 0;
      let tipsLeft = tips;
      for (let w = 0; w < nWeeks; w++) {
        let left = perWeek[w]!;
        const weekDays = days.slice(w * 7, w * 7 + 7);
        if (left > weekDays.length * MAX_DAY_MINUTES) throw badRequest(`${name}: ${(left / 60).toFixed(1)} hours in ${weekDays.length} days is more than a person can work.`);
        // Spread evenly, so a 40-hour week is not 12-hour days with two days off, and daily-overtime states are not tripped.
        const perDay = splitEven(left, weekDays.length);
        for (const [d, date] of weekDays.entries()) {
          const minutes = perDay[d]!;
          if (minutes <= 0) continue;
          left -= minutes;
          const first = tipsLeft > 0;
          recordShift(store, company.id, { employeeId: emp.id, workDate: date, minutes, externalId: `week:${emp.id}:${from}:${n++}`, ...(first ? { chargedTipsCents: tipsLeft } : {}) });
          if (first) tipsLeft = 0;
        }
      }
      if (tipsLeft > 0) {
        // Tips with no hours: they still belong to a day.
        recordShift(store, company.id, { employeeId: emp.id, workDate: start, minutes: 1, externalId: `week:${emp.id}:${from}:${n++}`, chargedTipsCents: tipsLeft });
      }
    }
  });
  return weekSummary(store, company, from, to);
}


// ---------------------------------------------------------------- the Time and tips page: hours by day

/** A workweek, day by day: each person's minutes, the tips, and the tip pool's split. */
export function daySummary(store: Store, company: Company, from: string, to: string) {
  checkPeriod(from, to);
  const days = eachDay(from, to);
  const roles = new Map(company.settings.roles.map((r) => [r.key, r]));
  const shifts = store.shifts.where((s) => s.companyId === company.id && s.workDate >= from && s.workDate <= to);
  const people = store.employees.where((e) => e.companyId === company.id && employedInPeriod(e, from, to)).sort((a, b) => a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName)).map((e) => {
    const mine = shifts.filter((s) => s.employeeId === e.id);
    const perDay = days.map((d) => { const day = mine.filter((s) => s.workDate === d); return { minutes: day.reduce((n, s) => n + s.minutes, 0), shifts: day.length, locked: day.some((s) => !!s.lockedByRunId) }; });
    return { employeeId: e.id, name: `${e.firstName} ${e.lastName}`, role: roles.get(e.roleKey)?.label ?? e.roleKey, location: e.location ?? null, hiredOn: e.hireDate, perDay, totalMinutes: perDay.reduce((n, d) => n + d.minutes, 0) };
  }).filter((p) => p.totalMinutes > 0 || p.perDay.length > 0);
  const charged = shifts.reduce((n, s) => n + s.chargedTipsCents, 0);
  const cash = shifts.reduce((n, s) => n + s.cashTipsCents, 0);
  return { periodStart: from, periodEnd: to, days, people, tips: { chargedCents: charged, cashCents: cash, totalCents: charged + cash, pool: tipPoolFor(store, company, from, to), poolOn: company.settings.policy.pool.enabled, basis: company.settings.policy.pool.basis } };
}

/** Set one person's hours for one day. A day with one shift changes that shift; a day with none gets one. */
export function saveDay(store: Store, company: Company, body: unknown) {
  const o = v.obj(body);
  const emp = store.employees.get(v.str(o, 'employeeId'));
  if (!emp || emp.companyId !== company.id) throw badRequest('That person isn’t on your team.');
  const date = v.date(o, 'date');
  const minutes = v.int(o, 'minutes', 0, 1440);
  const name = `${emp.firstName} ${emp.lastName}`;
  if (!employedInPeriod(emp, date, date)) throw badRequest(`${name} wasn’t employed on ${date}.`);
  const day = store.shifts.where((s) => s.companyId === company.id && s.employeeId === emp.id && s.workDate === date);
  if (day.some((s) => s.lockedByRunId)) throw conflict('period_closed', `${name}’s time on ${date} was already paid.`);
  if (day.length > 1) throw conflict('detailed_time_exists', `${name} has more than one shift on ${date}. Change them one by one.`);
  const closed = store.payRuns.where((r) => r.companyId === company.id && r.status !== 'draft' && r.status !== 'voided' && r.periodStart <= date && date <= r.periodEnd)[0];
  if (closed) throw conflict('period_closed', `${date} is inside an approved pay run. Void it to change this day.`);
  const [existing] = day;
  store.tx(() => {
    if (!existing) { if (minutes > 0) recordShift(store, company.id, { employeeId: emp.id, workDate: date, minutes, externalId: `day:${emp.id}:${date}` }); return; }
    if (minutes === 0) {
      if (existing.chargedTipsCents + existing.cashTipsCents > 0) throw conflict('has_tips', `${name} has tips on ${date}. Take those off first.`);
      store.shifts.delete(existing.id); return;
    }
    store.shifts.put({ ...existing, minutes });
  });
  return { ok: true };
}
