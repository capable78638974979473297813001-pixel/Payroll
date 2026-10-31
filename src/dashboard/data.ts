import { addDays, daysBetween, workweekStart } from '../lib/dates.ts';
import { allocate } from '../lib/money.ts';
import { checklistFor, getNiche } from '../industries/index.ts';
import type { Store } from '../store/store.ts';
import type { Company, Employee, PayRun } from '../domain/types.ts';
import { nextPayday } from '../payroll/schedule.ts';
import { availabilityFor } from './defaults.ts';
import { stateFacts } from '../builder/facts.ts';
import { STATE_FORMS } from '../onboarding/forms.ts';

/** One employee's new-hire forms. A person added directly has nothing recorded, so only what is known counts as done. */
export function formsOf(e: Employee, wantsStateForm: boolean) {
  const o = e.onboarding;
  const w4 = !!o?.w4 || (!o && true); // an employee with no onboarding record was added with a W-4's values directly
  const i9 = o?.i9?.section2At ? 'done' : o?.i9?.section1At ? 'section1' : 'none';
  const deposit = !!o?.deposit || e.payoutAccounts.length > 0;
  const stateForm = wantsStateForm ? !!o?.stateForm : true;
  return { w4, i9, deposit, stateForm, done: w4 && i9 === 'done' && deposit && stateForm };
}

const monthsAgo = (iso: string, today: string) => daysBetween(iso, today);

function totalsOf(run: PayRun | undefined) {
  if (!run) return null;
  return { id: run.id, periodStart: run.periodStart, periodEnd: run.periodEnd, checkDate: run.checkDate, status: run.status, employees: run.paychecks.length, grossCents: run.totals.grossCents, netCents: run.totals.payableCents + run.totals.cashTipsCents, payableCents: run.totals.payableCents, employeeTaxCents: run.totals.employeeTaxCents, employerTaxCents: run.totals.employerTaxCents, deductionsCents: run.totals.deductionsCents, totalCostCents: run.totals.grossCents + run.totals.employerTaxCents };
}

const TEAM_WORDS: Record<string, string> = { '1-10': '1 to 10 people', '11-25': '11 to 25 people', '26-50': '26 to 50 people', '51-100': '51 to 100 people', '100+': 'More than 100 people' };
const FREQ_WORDS: Record<string, string> = { weekly: 'Weekly', biweekly: 'Every other week', semimonthly: 'Twice a month', monthly: 'Monthly' };
const list = (xs: string[]) => (xs.length <= 2 ? xs.join(' and ') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

/** The setup answers as short phrases, for the "Built from your answers" strip. Only what was actually answered. */
function answerChips(company: Company, a: Record<string, unknown>): string[] {
  const out: string[] = [];
  const state = typeof a.state === 'string' ? a.state : company.homeState;
  try { out.push(stateFacts(state, new Date().toISOString().slice(0, 10)).name); } catch { out.push(state); }
  const locs = Array.isArray(a.locations) ? (a.locations as Array<{ name?: string }>).map((l) => l.name).filter((x): x is string => !!x) : [];
  if (locs.length) out.push(list(locs));
  if (typeof a.team === 'string') out.push(TEAM_WORDS[a.team] ?? a.team);
  const tips = a.tips as { on?: boolean } | undefined;
  if (tips?.on) out.push('Tipped staff');
  const f = a.frequency as { value?: string } | undefined;
  if (f?.value) out.push(FREQ_WORDS[f.value] ?? f.value);
  const c = a.contractors as { on?: boolean } | undefined;
  if (c?.on) out.push('Contractors');
  return out;
}

/** An estimate of one workweek's tip pool, shared by hours or by role points among the roles in the pool. Null when there is no pool or no card tips. */
export function tipPoolFor(store: Store, company: Company, start: string, end: string): { basis: string; totalCents: number; rows: Array<{ employeeId: string; name: string; hours: number; shareCents: number }> } | null {
  const policy = company.settings.policy;
  const shifts = store.shifts.where((s) => s.companyId === company.id && s.workDate >= start && s.workDate <= end);
  const charged = shifts.reduce((n, s) => n + s.chargedTipsCents, 0);
  if (!policy.pool.enabled || charged <= 0) return null;
  const roles = new Map(company.settings.roles.map((r) => [r.key, r]));
  const weights = new Map<string, number>(); const minutes = new Map<string, number>();
  for (const sh of shifts) {
    if (!policy.pool.roles.includes(sh.roleKey)) continue;
    const pts = policy.pool.basis === 'points' ? (roles.get(sh.roleKey)?.poolPoints ?? 1) : 1;
    weights.set(sh.employeeId, (weights.get(sh.employeeId) ?? 0) + sh.minutes * pts);
    minutes.set(sh.employeeId, (minutes.get(sh.employeeId) ?? 0) + sh.minutes);
  }
  const ids = [...weights.keys()];
  if (ids.length === 0) return null;
  const shares = allocate(charged, ids.map((id) => weights.get(id)!));
  const nameOf = (id: string) => { const e = store.employees.get(id); return e ? `${e.firstName} ${e.lastName}` : id; };
  return { basis: policy.pool.basis, totalCents: charged, rows: ids.map((id, i) => ({ employeeId: id, name: nameOf(id), hours: Math.round(((minutes.get(id) ?? 0) / 60) * 100) / 100, shareCents: shares[i]! })).sort((x, y) => y.shareCents - x.shareCents) };
}

/** Everything the dashboard's cards show, in one read. Empty where there is nothing yet. */
export function dashboardData(store: Store, company: Company, today: string) {
  const a = availabilityFor(company, today);
  const employees = store.employees.where((e) => e.companyId === company.id);
  const active = employees.filter((e) => !e.terminationDate || e.terminationDate > today);
  const runs = store.payRuns.where((r) => r.companyId === company.id && r.status !== 'voided').sort((x, y) => y.periodStart.localeCompare(x.periodStart));
  const latest = runs.find((r) => r.paychecks.length > 0);
  const roles = new Map(company.settings.roles.map((r) => [r.key, r]));
  const wantsStateForm = a.has(`state_${company.homeState.toLowerCase()}_form`);

  // ---- team
  const count = <T,>(items: T[], key: (x: T) => string) => {
    const m = new Map<string, number>();
    for (const x of items) m.set(key(x), (m.get(key(x)) ?? 0) + 1);
    return [...m].map(([label, n]) => ({ label, count: n })).sort((p, q) => q.count - p.count || p.label.localeCompare(q.label));
  };
  const team = {
    active: active.length,
    newThisMonth: active.filter((e) => monthsAgo(e.hireDate, today) <= 30 && monthsAgo(e.hireDate, today) >= 0).length,
    byRole: count(active, (e) => roles.get(e.roleKey)?.label ?? e.roleKey),
    byPay: count(active, (e) => (e.payType.kind === 'hourly' ? 'Hourly' : 'Salaried')),
    byLocation: count(active, (e) => e.location ?? (company.locations?.[0]?.name ?? 'Main')),
    byDepartment: count(active.filter((e) => e.tags?.department), (e) => e.tags!.department!),
    byCrew: count(active.filter((e) => e.tags?.crew), (e) => e.tags!.crew!),
  };

  // ---- this workweek
  const start = workweekStart(today, company.settings.workweekStartDay);
  const end = addDays(start, 6);
  const shifts = store.shifts.where((s) => s.companyId === company.id && s.workDate >= start && s.workDate <= end);
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const byDay = days.map((d) => {
    const ds = shifts.filter((s) => s.workDate === d);
    return { date: d, minutes: ds.reduce((n, s) => n + s.minutes, 0), chargedTipsCents: ds.reduce((n, s) => n + s.chargedTipsCents, 0), cashTipsCents: ds.reduce((n, s) => n + s.cashTipsCents, 0) };
  });
  const perPerson = new Map<string, number>();
  for (const s of shifts) perPerson.set(s.employeeId, (perPerson.get(s.employeeId) ?? 0) + s.minutes);
  // Federal weekly overtime is over 40 hours. States with daily overtime pay more; this is the weekly view only.
  let regular = 0; let overtime = 0;
  for (const m of perPerson.values()) { regular += Math.min(m, 2400); overtime += Math.max(0, m - 2400); }
  const nameOf = (id: string) => { const e = store.employees.get(id); return e ? `${e.firstName} ${e.lastName}` : id; };
  const hours = {
    weekStart: start, weekEnd: end, totalMinutes: regular + overtime, regularMinutes: regular, overtimeMinutes: overtime, byDay: byDay.map((d) => ({ date: d.date, minutes: d.minutes })),
    people: [...perPerson].map(([id, minutes]) => ({ employeeId: id, name: nameOf(id), minutes })).sort((p, q) => q.minutes - p.minutes).slice(0, 25),
  };
  const tips = {
    chargedCents: byDay.reduce((n, d) => n + d.chargedTipsCents, 0),
    cashCents: byDay.reduce((n, d) => n + d.cashTipsCents, 0),
    byDay: byDay.map((d) => ({ date: d.date, chargedTipsCents: d.chargedTipsCents, cashTipsCents: d.cashTipsCents })),
  };

  const tipPool = tipPoolFor(store, company, start, end);

  // ---- forms
  const forms = active.map((e) => ({ id: e.id, name: `${e.firstName} ${e.lastName}`, ...formsOf(e, wantsStateForm) }));
  const onboarding = {
    total: forms.length,
    complete: forms.filter((f) => f.done).length,
    w4: forms.filter((f) => f.w4).length,
    i9: forms.filter((f) => f.i9 === 'done').length,
    deposit: forms.filter((f) => f.deposit).length,
    stateForm: wantsStateForm ? forms.filter((f) => f.stateForm).length : null,
    behind: forms.filter((f) => !f.done).slice(0, 20),
  };

  // ---- taxes, from the latest run
  const lines = new Map<string, { id: string; name: string; payer: string; jurisdiction: string; amountCents: number }>();
  for (const pc of latest?.paychecks ?? []) for (const l of pc.taxLines) {
    const cur = lines.get(l.id) ?? { id: l.id, name: l.name, payer: l.payer, jurisdiction: l.jurisdiction, amountCents: 0 };
    cur.amountCents += l.amount;
    lines.set(l.id, cur);
  }
  const taxLines = [...lines.values()].filter((l) => l.amountCents !== 0).sort((p, q) => q.amountCents - p.amountCents);

  // ---- state cards
  const stateCards = a.build.modules.filter((m) => m.id.startsWith('state_')).map((m) => ({ code: m.id.slice(6).toUpperCase(), name: m.label, items: m.items }));

  // ---- what the setup built: its sections, and the answers behind them, in words
  const answers = company.setup?.answers ?? {};
  const modules = a.build.modules.map((m) => ({ id: m.id, label: m.label, items: m.items }));
  const built = {
    modules,
    counts: a.build.counts,
    leftOut: a.build.leftOut,
    answers: answerChips(company, answers),
    answersRaw: answers,
  };

  // ---- the niche's reminders for this state
  let checklist: Array<{ id: string; title: string; detail: string; when: string; notModelled: boolean; verified: boolean }> = [];
  try {
    checklist = checklistFor(getNiche(company.industry, company.niche), company.homeState).map((c) => ({ id: c.id, title: c.title, detail: c.detail, when: c.when, notModelled: !!c.notModelled, verified: !!c.verified }));
  } catch { /* an industry with no checklist */ }

  return {
    asOf: today,
    company: { name: company.legalName, state: company.homeState, schedule: { frequency: company.paySchedule.frequency, payWeekday: company.paySchedule.payWeekday ?? null }, workweekStartDay: company.settings.workweekStartDay, industry: company.industry, niche: company.niche, hasEin: !!company.ein, stateForm: STATE_FORMS[company.homeState] ?? null, roles: company.settings.roles.map((r) => ({ key: r.key, label: r.label, pay: r.pay, tipped: r.tipped })), paymentSetUp: !!company.payment.employerBank, locations: company.locations ?? [] },
    nextPayday: nextPayday(company, today, runs),
    runs: runs.slice(0, 10).map((r) => totalsOf(r)),
    latest: totalsOf(latest),
    taxLines,
    team,
    hours,
    tips,
    tipPool,
    onboarding,
    stateCards,
    built,
    checklist,
    people: active.slice(0, 200).map((e) => ({ id: e.id, name: `${e.firstName} ${e.lastName}`, role: roles.get(e.roleKey)?.label ?? e.roleKey, pay: e.payType.kind === 'hourly' ? { kind: 'hourly', cents: e.payType.rateCents } : { kind: 'salary', cents: e.payType.annualCents }, location: e.location ?? null, done: formsOf(e, wantsStateForm).done })),
    contractors: (() => { const rows = store.contractors.where((x) => x.companyId === company.id && !x.archivedAt); const y = today.slice(0, 4); return { count: rows.length, w9: rows.filter((x) => x.w9At).length, ytdCents: rows.reduce((n, x) => n + x.payments.filter((p) => p.date.startsWith(y)).reduce((m, p) => m + p.amountCents, 0), 0) }; })(),
    setup: [
      { id: 'ein', label: 'Add your EIN', done: !!company.ein, to: '/app/settings/company' },
      { id: 'bank', label: 'Choose the bank you pay from', done: !!company.payment.employerBank, to: '/app/settings/payments' },
      { id: 'team', label: 'Add your first person', done: employees.length > 0, to: '/app/onboarding' },
      { id: 'run', label: 'Run your first payroll', done: runs.some((r) => r.status === 'completed' || r.status === 'approved'), to: '/app/payroll/run' },
    ],
  };
}
