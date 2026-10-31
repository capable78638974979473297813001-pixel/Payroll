import { badRequest, conflict, notFound } from '../lib/errors.ts';
import * as v from '../lib/validate.ts';
import { newId } from '../lib/ids.ts';
import { daysBetween } from '../lib/dates.ts';
import type { Store } from '../store/store.ts';
import type { Company, Employee, Job, Shift } from '../domain/types.ts';
import { recordShift } from '../domain/timekeeping.ts';

const CODE = /^[A-Za-z0-9 .\-/]{1,30}$/;
const NAME = (s: unknown, label: string) => {
  if (typeof s !== 'string' || s.trim() === '') throw badRequest(`Enter ${label}.`);
  const t = s.trim().replace(/\s+/g, ' ');
  if (t.length > 80 || /[\u0000-\u001f<>]/.test(t)) throw badRequest(`${label[0]!.toUpperCase()}${label.slice(1)} has characters we can’t accept.`);
  return t;
};

/** What an hour of this person's time costs: the shift's own rate, their rate for the role, their hourly rate, or a salary spread over 2,080 hours. Straight time: overtime premiums are not added. */
export function hourlyCostCents(e: Employee, s: Shift): number {
  if (s.rateCentsPerHour) return s.rateCentsPerHour;
  if (e.roleRates[s.roleKey]) return e.roleRates[s.roleKey]!;
  return e.payType.kind === 'hourly' ? e.payType.rateCents : Math.round(e.payType.annualCents / 2080);
}
const cost = (e: Employee | undefined, s: Shift) => (e ? Math.round((s.minutes / 60) * hourlyCostCents(e, s)) : 0);

export class JobService {
  private store: Store; private now: () => Date;
  constructor(store: Store, now: () => Date = () => new Date()) { this.store = store; this.now = now; }

  private mine(companyId: string, id: string): Job {
    const j = this.store.jobs.get(id);
    if (!j || j.companyId !== companyId) throw notFound('Job');
    return j;
  }

  private codes(raw: unknown): Job['costCodes'] {
    if (raw === undefined) return [];
    if (!Array.isArray(raw) || raw.length > 30) throw badRequest('Up to 30 cost codes per job.');
    const seen = new Set<string>();
    return raw.map((r, i) => {
      const o = v.obj(r, `costCodes[${i}]`);
      const code = v.str(o, 'code', { max: 30 }).trim();
      if (!CODE.test(code)) throw badRequest(`Cost code '${code}' can only have letters, numbers, spaces and dashes.`);
      if (seen.has(code.toLowerCase())) throw badRequest(`Cost code '${code}' is listed twice.`);
      seen.add(code.toLowerCase());
      return { code, label: NAME(o.label ?? code, 'the cost code name'), budgetCents: o.budgetCents === undefined ? 0 : v.cents(o, 'budgetCents', { max: 100_000_000_000 }) };
    });
  }

  list(companyId: string) { return this.store.jobs.where((j) => j.companyId === companyId && !j.archivedAt).sort((a, b) => a.name.localeCompare(b.name)); }

  add(companyId: string, body: unknown): Job {
    const o = v.obj(body);
    const name = NAME(o.name, 'the job name');
    if (this.list(companyId).some((j) => j.name.toLowerCase() === name.toLowerCase())) throw conflict('job_exists', `You already have a job called ${name}.`);
    const job: Job = { id: newId('job'), companyId, name, budgetCents: o.budgetCents === undefined ? 0 : v.cents(o, 'budgetCents', { max: 100_000_000_000 }), prevailingWage: v.bool(o, 'prevailingWage', false), costCodes: this.codes(o.costCodes), createdAt: this.now().toISOString() };
    this.store.tx(() => this.store.jobs.put(job));
    return job;
  }

  update(companyId: string, id: string, body: unknown): Job {
    const o = v.obj(body); const j = structuredClone(this.mine(companyId, id));
    if (o.name !== undefined) j.name = NAME(o.name, 'the job name');
    if (o.budgetCents !== undefined) j.budgetCents = v.cents(o, 'budgetCents', { max: 100_000_000_000 });
    if (o.prevailingWage !== undefined) j.prevailingWage = v.bool(o, 'prevailingWage', false);
    if (o.costCodes !== undefined) {
      const next = this.codes(o.costCodes);
      // A code with hours charged to it cannot disappear.
      const used = new Set(this.store.shifts.where((s) => s.jobId === id && !!s.costCode).map((s) => s.costCode!));
      const gone = [...used].filter((c) => !next.some((n) => n.code === c));
      if (gone.length) throw conflict('code_in_use', `Hours are charged to ${gone.join(', ')}. Keep those cost codes.`);
      j.costCodes = next;
    }
    this.store.tx(() => this.store.jobs.put(j));
    return j;
  }

  /** Closed, not deleted: its hours and cost stay in the reports. */
  archive(companyId: string, id: string) {
    const j = structuredClone(this.mine(companyId, id)); j.archivedAt = this.now().toISOString();
    this.store.tx(() => this.store.jobs.put(j));
    return { archived: true };
  }

  /** Charge a day's hours to a job. Saying it again for the same person, day, job and code replaces the earlier entry. */
  logHours(companyId: string, body: unknown) {
    const o = v.obj(body);
    const minutes = v.int(o, 'minutes', 0, 1440);
    const emp = this.store.employees.get(v.str(o, 'employeeId'));
    if (!emp || emp.companyId !== companyId) throw badRequest('That person isn’t on your team.');
    const date = v.date(o, 'date'); const jobId = v.str(o, 'jobId');
    const costCode = typeof o.costCode === 'string' ? o.costCode : '';
    const externalId = `job:${emp.id}:${date}:${jobId}:${costCode}`;
    if (minutes === 0) {
      const ex = this.store.shifts.where((s) => s.companyId === companyId && s.externalId === externalId)[0];
      if (ex) { if (ex.lockedByRunId) throw conflict('shift_locked', 'That time was already paid.'); this.store.tx(() => this.store.shifts.delete(ex.id)); }
      return { ok: true };
    }
    recordShift(this.store, companyId, { employeeId: emp.id, workDate: date, minutes, jobId, ...(costCode ? { costCode } : {}), externalId });
    return { ok: true };
  }

  /** Labor against budget, for a period and for the life of each job. */
  report(companyId: string, from: string, to: string) {
    if (to < from || daysBetween(from, to) > 366) throw badRequest('Check the dates.');
    const emps = new Map(this.store.employees.where((e) => e.companyId === companyId).map((e) => [e.id, e]));
    const shifts = this.store.shifts.where((s) => s.companyId === companyId);
    const jobs = this.list(companyId).map((j) => {
      const mine = shifts.filter((s) => s.jobId === j.id);
      const period = mine.filter((s) => s.workDate >= from && s.workDate <= to);
      const spent = mine.reduce((n, s) => n + cost(emps.get(s.employeeId), s), 0);
      const codes = j.costCodes.map((c) => { const cs = mine.filter((s) => s.costCode === c.code); const spentC = cs.reduce((n, s) => n + cost(emps.get(s.employeeId), s), 0); return { code: c.code, label: c.label, minutes: cs.reduce((n, s) => n + s.minutes, 0), costCents: spentC, budgetCents: c.budgetCents, over: c.budgetCents > 0 && spentC > c.budgetCents }; });
      const uncoded = mine.filter((s) => !s.costCode || !j.costCodes.some((c) => c.code === s.costCode));
      if (uncoded.length) codes.push({ code: '—', label: 'No cost code', minutes: uncoded.reduce((n, s) => n + s.minutes, 0), costCents: uncoded.reduce((n, s) => n + cost(emps.get(s.employeeId), s), 0), budgetCents: 0, over: false });
      return { id: j.id, name: j.name, budgetCents: j.budgetCents, prevailingWage: j.prevailingWage, spentCents: spent, minutes: mine.reduce((n, s) => n + s.minutes, 0), periodMinutes: period.reduce((n, s) => n + s.minutes, 0), periodCostCents: period.reduce((n, s) => n + cost(emps.get(s.employeeId), s), 0), pct: j.budgetCents > 0 ? Math.round((spent / j.budgetCents) * 100) : null, over: j.budgetCents > 0 && spent > j.budgetCents, costCodes: codes, rawCodes: j.costCodes };
    });
    const periodLabor = shifts.filter((s) => s.workDate >= from && s.workDate <= to).reduce((n, s) => n + cost(emps.get(s.employeeId), s), 0);
    return { periodStart: from, periodEnd: to, jobs, stats: { activeJobs: jobs.length, periodLaborCents: periodLabor, overBudget: jobs.filter((j) => j.over).length, prevailingWage: jobs.filter((j) => j.prevailingWage).length }, note: 'Labor cost is straight time: each hour at the person’s rate, with no overtime premium, taxes or benefits added.' };
  }

  exportCsv(companyId: string, from: string, to: string) {
    const q = (s: unknown) => `"${String(s ?? '').replace(/"/g, '""')}"`;
    const r = this.report(companyId, from, to);
    const lines = [['Job', 'Cost code', 'Hours (all time)', 'Labor cost (all time)', 'Budget', 'Over budget'].map(q).join(',')];
    for (const j of r.jobs) { lines.push([j.name, '', (j.minutes / 60).toFixed(2), (j.spentCents / 100).toFixed(2), (j.budgetCents / 100).toFixed(2), j.over ? 'Yes' : 'No'].map(q).join(',')); for (const c of j.costCodes) lines.push([j.name, c.code, (c.minutes / 60).toFixed(2), (c.costCents / 100).toFixed(2), (c.budgetCents / 100).toFixed(2), c.over ? 'Yes' : 'No'].map(q).join(',')); }
    return { fileName: `job-costing-${from}-to-${to}.csv`, content: lines.join('\n') + '\n' };
  }
}

/** Hours this week by the tag a business uses to group people: a department, a crew, a workers' comp class. */
export function hoursByTag(store: Store, company: Company, from: string, to: string, tag: 'department' | 'crew' | 'wcClass') {
  const emps = new Map(store.employees.where((e) => e.companyId === company.id).map((e) => [e.id, e]));
  const m = new Map<string, { label: string; minutes: number; people: Set<string> }>();
  for (const e of emps.values()) if (!e.terminationDate && e.tags?.[tag]) { const k = e.tags[tag]!; const g = m.get(k) ?? { label: k, minutes: 0, people: new Set() }; g.people.add(e.id); m.set(k, g); }
  for (const s of store.shifts.where((x) => x.companyId === company.id && x.workDate >= from && x.workDate <= to)) { const k = emps.get(s.employeeId)?.tags?.[tag]; if (k) { const g = m.get(k) ?? { label: k, minutes: 0, people: new Set() }; g.minutes += s.minutes; g.people.add(s.employeeId); m.set(k, g); } }
  return [...m.values()].map((g) => ({ label: g.label, minutes: g.minutes, count: g.people.size })).sort((a, b) => b.minutes - a.minutes || a.label.localeCompare(b.label));
}

/** Payroll by workers' comp class for a calendar year, from approved pay runs: what an insurer's audit asks for. */
export function wcReport(store: Store, company: Company, year: number) {
  const emps = new Map(store.employees.where((e) => e.companyId === company.id).map((e) => [e.id, e]));
  const rows = new Map<string, { wcClass: string; grossCents: number; minutes: number; people: Set<string> }>();
  for (const run of store.payRuns.where((r) => r.companyId === company.id && r.status !== 'draft' && r.status !== 'voided' && r.checkDate.startsWith(String(year)))) {
    for (const pc of run.paychecks) {
      const k = emps.get(pc.employeeId)?.tags?.wcClass ?? 'No class set';
      const g = rows.get(k) ?? { wcClass: k, grossCents: 0, minutes: 0, people: new Set() };
      g.grossCents += pc.taxableWagesCents; g.minutes += Math.round(pc.hours * 60); g.people.add(pc.employeeId); rows.set(k, g);
    }
  }
  const list = [...rows.values()].map((g) => ({ wcClass: g.wcClass, grossCents: g.grossCents, hours: Math.round(g.minutes) / 60, people: g.people.size })).sort((a, b) => a.wcClass.localeCompare(b.wcClass));
  const q = (s: unknown) => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const csv = [['Class', 'People', 'Hours', 'Gross payroll'].map(q).join(','), ...list.map((r) => [r.wcClass, r.people, r.hours.toFixed(2), (r.grossCents / 100).toFixed(2)].map(q).join(','))].join('\n') + '\n';
  return { year, rows: list, fileName: `payroll-by-class-${year}.csv`, csv, note: 'Gross pay includes tips taxed as wages. Your insurer decides which pay counts as payroll for each class.' };
}
