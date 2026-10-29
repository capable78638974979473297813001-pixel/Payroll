import { newId } from '../lib/ids.ts';
import { ApiError, badRequest, conflict, notFound } from '../lib/errors.ts';
import * as v from '../lib/validate.ts';
import type { Store } from '../store/store.ts';
import type { HouseDay, Shift } from './types.ts';
import { requireEmployee } from './employees.ts';

/**
 * A date inside a pay run that has been approved is closed: a shift added there
 * would never be paid, because no later run may cover those days.
 */
function assertPeriodOpen(store: Store, companyId: string, date: string): void {
  const closed = store.payRuns.where((r) => r.companyId === companyId && r.status !== 'draft' && r.status !== 'voided' && r.periodStart <= date && date <= r.periodEnd)[0];
  if (closed) throw conflict('period_closed', `${date} is inside pay run ${closed.id} (${closed.periodStart} to ${closed.periodEnd}), which is already ${closed.status}. Void that run to change this period.`);
}

/**
 * Record a shift: when someone worked, in what role, and the tips and sales
 * that belong to it. `minutes` can be given directly, or derived from
 * `clockIn` / `clockOut` timestamps less `unpaidBreakMinutes`. Sending a shift
 * again with the same `externalId` replaces it, so a POS sync cannot pay the
 * same shift twice; once a pay run has locked a shift it cannot change.
 */
export function recordShift(store: Store, companyId: string, body: unknown): Shift {
  const o = v.obj(body);
  const company = store.companies.require(companyId, 'Company');
  const employee = requireEmployee(store, companyId, v.str(o, 'employeeId'));
  const workDate = v.date(o, 'workDate');
  if (workDate < employee.hireDate || (employee.terminationDate && workDate > employee.terminationDate)) {
    throw badRequest(`${employee.firstName} was not employed on ${workDate}`);
  }

  assertPeriodOpen(store, companyId, workDate);

  const roleKey = o.roleKey === undefined ? employee.roleKey : v.str(o, 'roleKey');
  const role = company.settings.roles.find((r) => r.key === roleKey);
  if (!role) throw badRequest(`roleKey '${roleKey}' is not a role at this company`);

  let minutes: number;
  let clockIn: string | undefined;
  let clockOut: string | undefined;
  if (o.minutes !== undefined) {
    minutes = v.int(o, 'minutes', 1, 1440);
  } else {
    clockIn = v.str(o, 'clockIn');
    clockOut = v.str(o, 'clockOut');
    const a = Date.parse(clockIn);
    const b = Date.parse(clockOut);
    if (Number.isNaN(a) || Number.isNaN(b)) throw badRequest('clockIn and clockOut must be ISO timestamps');
    const unpaid = o.unpaidBreakMinutes === undefined ? 0 : v.int(o, 'unpaidBreakMinutes', 0, 600);
    minutes = Math.round((b - a) / 60_000) - unpaid;
    if (minutes < 1 || minutes > 1440) throw badRequest('clockOut must be after clockIn, within 24 paid hours');
  }

  const chargedTipsCents = o.chargedTipsCents === undefined ? 0 : v.cents(o, 'chargedTipsCents');
  const cashTipsCents = o.cashTipsCents === undefined ? 0 : v.cents(o, 'cashTipsCents');
  if (role.tipped === 'never' && (chargedTipsCents > 0 || cashTipsCents > 0)) {
    throw badRequest(`${role.label} is not a tipped role, so tips cannot be recorded against its shifts. Tips reach it through the pool or tip-outs.`);
  }

  const externalId = o.externalId === undefined ? undefined : v.str(o, 'externalId', { max: 100 });
  const existing = externalId ? store.shifts.where((s) => s.companyId === companyId && s.externalId === externalId)[0] : undefined;
  if (existing?.lockedByRunId) throw conflict('shift_locked', `That shift was paid in pay run ${existing.lockedByRunId} and can no longer change.`);

  const shift: Shift = {
    id: existing?.id ?? newId('shf'),
    companyId,
    employeeId: employee.id,
    workDate,
    roleKey,
    minutes,
    ...(clockIn ? { clockIn, clockOut } : {}),
    ...(externalId ? { externalId } : {}),
    ...(o.rateCentsPerHour !== undefined ? { rateCentsPerHour: v.cents(o, 'rateCentsPerHour', { min: 1, max: 100_000 }) } : {}),
    ...(o.scheduledMinutes !== undefined ? { scheduledMinutes: v.int(o, 'scheduledMinutes', 1, 1440) } : {}),
    chargedTipsCents,
    cashTipsCents,
    salesCents: o.salesCents === undefined ? 0 : v.cents(o, 'salesCents'),
    mealBreakViolation: v.bool(o, 'mealBreakViolation', false),
    restBreakViolation: v.bool(o, 'restBreakViolation', false),
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  };
  return store.tx(() => store.shifts.put(shift));
}

export function deleteShift(store: Store, companyId: string, shiftId: string): void {
  const s = store.shifts.get(shiftId);
  if (!s || s.companyId !== companyId) throw notFound('Shift');
  if (s.lockedByRunId) throw conflict('shift_locked', `That shift was paid in pay run ${s.lockedByRunId} and can no longer change.`);
  store.tx(() => store.shifts.delete(shiftId));
}

export function listShifts(store: Store, companyId: string, q: { from?: string; to?: string; employeeId?: string }): Shift[] {
  return store.shifts
    .where((s) => s.companyId === companyId && (!q.from || s.workDate >= q.from) && (!q.to || s.workDate <= q.to) && (!q.employeeId || s.employeeId === q.employeeId))
    .sort((a, b) => a.workDate.localeCompare(b.workDate) || a.createdAt.localeCompare(b.createdAt));
}

/** House-level tips (a counted tip jar) and mandatory service charges for one day. Replaces that day's figures. */
export function recordHouseDay(store: Store, companyId: string, body: unknown): HouseDay {
  const o = v.obj(body);
  store.companies.require(companyId, 'Company');
  const date = v.date(o, 'date');
  assertPeriodOpen(store, companyId, date);
  const id = `${companyId}:${date}`;
  const existing = store.houseDays.get(id);
  if (existing?.lockedByRunId) throw conflict('house_day_locked', `${date} was paid in pay run ${existing.lockedByRunId} and can no longer change.`);
  const day: HouseDay = {
    id,
    companyId,
    date,
    houseTipsCents: o.houseTipsCents === undefined ? 0 : v.cents(o, 'houseTipsCents'),
    serviceChargesCents: o.serviceChargesCents === undefined ? 0 : v.cents(o, 'serviceChargesCents'),
  };
  return store.tx(() => store.houseDays.put(day));
}

/**
 * Record many shifts at once (a POS export). All or nothing: if any one is
 * invalid, none is saved, and the error says which. Shifts that carry an
 * externalId replace the earlier copy, so re-sending a day is safe.
 */
export function recordShifts(store: Store, companyId: string, body: unknown): Shift[] {
  const o = v.obj(body);
  if (!Array.isArray(o.shifts) || o.shifts.length === 0) throw badRequest('shifts must be a non-empty list');
  if (o.shifts.length > 500) throw badRequest('At most 500 shifts per request');
  return store.tx(() =>
    (o.shifts as unknown[]).map((raw, i) => {
      try {
        return recordShift(store, companyId, raw);
      } catch (e) {
        if (e instanceof Error && 'status' in e) {
          const err = e as Error & { status: number; code: string; details?: unknown };
          throw new ApiError(err.status, err.code, `shifts[${i}]: ${err.message}`, err.details);
        }
        throw e;
      }
    }),
  );
}
