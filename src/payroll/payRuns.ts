import { newId } from '../lib/ids.ts';
import { badRequest, conflict, notFound } from '../lib/errors.ts';
import { addDays, daysBetween, workweekStart } from '../lib/dates.ts';
import { blocking, info, review, type Issue } from '../lib/issues.ts';
import { sum, type Cents } from '../lib/money.ts';
import * as v from '../lib/validate.ts';
import { calculatePaycheck } from '../../engine/src/calculate.ts';
import { PERIODS_PER_YEAR, type Deduction, type Earning, type PaycheckInput } from '../../engine/src/types.ts';
import { accumulateYtd, freshYearToDate } from '../../engine/payroll/ytd.ts';
import type { Store } from '../store/store.ts';
import { employerContextFor } from '../domain/companies.ts';
import { payoutReadiness } from '../banking/accounts.ts';
import { FLSA_STANDARD_SALARY_LEVEL_WEEKLY, meetsStandardSalaryLevelTest } from '../../engine/payroll/flsaExemption.ts';
import type { Adjustment, Company, Employee, EarningLine, Paycheck, PayRun } from '../domain/types.ts';
import { distributeTips, type ShiftTips, type TipShift } from '../restaurant/tips.ts';
import { computeHourlyWages, salaryForPeriod, type WageShift } from '../restaurant/wages.ts';
import { REGIONAL_STATES, wageFloors } from '../restaurant/floors.ts';

export interface DraftInput {
  periodStart: string;
  periodEnd: string;
  checkDate: string;
  adjustments: Adjustment[];
}

export function parseDraftInput(body: unknown, company: Company, store: Store): DraftInput {
  const o = v.obj(body);
  const periodStart = v.date(o, 'periodStart');
  const periodEnd = v.date(o, 'periodEnd');
  const checkDate = v.date(o, 'checkDate');
  if (periodEnd < periodStart) throw badRequest('periodEnd is before periodStart');
  if (daysBetween(periodStart, periodEnd) > 30) throw badRequest('A pay period cannot be longer than 31 days');
  if (checkDate < periodEnd) throw badRequest('checkDate cannot be before the end of the pay period');

  const adjustments: Adjustment[] = [];
  if (o.adjustments !== undefined) {
    if (!Array.isArray(o.adjustments)) throw badRequest('adjustments must be a list');
    for (const [i, raw] of o.adjustments.entries()) {
      const a = v.obj(raw, `adjustments[${i}]`);
      const employeeId = v.str(a, 'employeeId');
      const employee = store.employees.get(employeeId);
      if (!employee || employee.companyId !== company.id) throw badRequest(`adjustments[${i}] names an employee who is not at this company`);
      adjustments.push({
        employeeId,
        code: v.str(a, 'code', { max: 30 }).toUpperCase(),
        label: v.str(a, 'label', { max: 100 }),
        category: v.oneOf(a, 'category', ['supplemental', 'reimbursement', 'regular'] as const),
        amountCents: v.cents(a, 'amountCents', { min: 1 }),
      });
    }
  }
  return { periodStart, periodEnd, checkDate, adjustments };
}

const inRange = (d: string, from: string, to: string) => d >= from && d <= to;

/** Who is owed pay for this period: hired by its end, and not terminated before its start. */
export function activeInPeriod(employees: readonly Employee[], periodStart: string, periodEnd: string): Employee[] {
  return employees.filter((e) => e.hireDate <= periodEnd && (!e.terminationDate || e.terminationDate >= periodStart));
}

/** Build a pay run's numbers from stored shifts. Pure with respect to the store: nothing is written. */
export function buildPayRun(store: Store, company: Company, input: DraftInput, keep?: { id: string; createdAt: string }): PayRun {
  const { periodStart, periodEnd, checkDate } = input;
  const issues: Issue[] = [];
  const { settings } = company;
  const frequency = company.paySchedule.frequency;

  for (const other of store.payRuns.where((r) => r.companyId === company.id && r.status !== 'voided' && r.id !== keep?.id)) {
    if (periodStart <= other.periodEnd && other.periodStart <= periodEnd) {
      throw conflict('period_overlap', `This period overlaps pay run ${other.id} (${other.periodStart} to ${other.periodEnd}, ${other.status}). Void it first, or choose a period that does not overlap.`);
    }
  }

  const spanStart = workweekStart(periodStart, settings.workweekStartDay);
  const spanEnd = addDays(workweekStart(periodEnd, settings.workweekStartDay), 6);
  if (spanStart !== periodStart || spanEnd !== periodEnd) {
    const make = frequency === 'weekly' || frequency === 'biweekly' ? review : info;
    issues.push(make('period_not_week_aligned', `This period (${periodStart} to ${periodEnd}) does not start and end on the company's workweek (${spanStart} to ${spanEnd}). Overtime and tip-credit make-up are decided by workweek; the make-up for a split week is paid in the run that contains its last day.`));
  }

  const employees = activeInPeriod(store.employees.where((e) => e.companyId === company.id), periodStart, periodEnd);
  const activeIds = new Set(employees.map((e) => e.id));
  const allShifts = store.shifts.where((s) => s.companyId === company.id && inRange(s.workDate, spanStart, spanEnd));
  for (const s of allShifts) {
    if (inRange(s.workDate, periodStart, periodEnd) && !activeIds.has(s.employeeId)) {
      issues.push(blocking('shift_for_inactive_employee', `A shift on ${s.workDate} belongs to an employee who is not active in this period.`, { employeeId: s.employeeId, date: s.workDate }));
    }
  }
  const shifts = allShifts.filter((s) => activeIds.has(s.employeeId));
  const houseDays = store.houseDays.where((h) => h.companyId === company.id && inRange(h.date, spanStart, spanEnd));
  for (const s of shifts) {
    if (s.lockedByRunId && inRange(s.workDate, periodStart, periodEnd)) {
      issues.push(blocking('shift_already_paid', `A shift on ${s.workDate} was already paid in pay run ${s.lockedByRunId}.`, { employeeId: s.employeeId, date: s.workDate }));
    }
  }

  // Is a tip credit really in effect where this establishment is?
  let tipCreditInEffect = false;
  if (settings.policy.takesTipCredit) {
    try {
      tipCreditInEffect = wageFloors(periodEnd, company.homeState, settings.locality, settings.region).tipCreditAllowed;
    } catch {
      tipCreditInEffect = false; // the wage module raises the blocking issue per employee
    }
  }
  if (REGIONAL_STATES.includes(company.homeState) && !settings.region) {
    issues.push(review('region_not_set', `${company.homeState} has regional minimum wages. No region is set in the company settings, so the statewide baseline was used, which can be lower than the local rate. Set settings.region (for example 'downstate' in New York or 'portland_metro' in Oregon).`));
  }

  // Tips and service charges, across the whole span so workweek tests see every day.
  const tipShifts: TipShift[] = shifts.map((s) => ({
    shiftId: s.id,
    employeeId: s.employeeId,
    workDate: s.workDate,
    roleKey: s.roleKey,
    minutes: s.minutes,
    chargedTipsCents: s.chargedTipsCents,
    cashTipsCents: s.cashTipsCents,
    salesCents: s.salesCents,
  }));
  const distribution = distributeTips(
    tipShifts,
    houseDays.map((h) => ({ date: h.date, houseTipsCents: h.houseTipsCents, serviceChargesCents: h.serviceChargesCents })),
    { settings, tipCreditInEffect },
  );
  issues.push(...distribution.issues.filter((i) => !i.date || inRange(i.date, periodStart, periodEnd)));
  const tipsByShift = new Map<string, ShiftTips>(distribution.shifts.map((t) => [t.shiftId, t]));

  const periodsPerYear = PERIODS_PER_YEAR[frequency];
  const checkYear = Number(checkDate.slice(0, 4));
  const paychecks: Paycheck[] = [];

  for (const employee of employees.sort((a, b) => a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName))) {
    const mine = shifts.filter((s) => s.employeeId === employee.id);
    const earnings: EarningLine[] = [];
    const name = `${employee.firstName} ${employee.lastName}`;
    const flag = (i: Issue) => issues.push({ ...i, employeeId: employee.id });

    if (!employee.ssnEncrypted) flag(review('ssn_missing', `${name} has no SSN on file. It is needed for the W-2 and MasteryTax filings.`, {}));
    const ready = payoutReadiness(store, employee);
    if (!ready.ready) flag(review('payout_account_not_ready', `${name} is not set up for direct deposit (${ready.reason}), so their pay cannot be sent until they are.`, {}));

    // Hourly wages
    let paidMinutes = 0;
    let weeks: Paycheck['weeks'] = [];
    if (employee.payType.kind === 'hourly') {
      const noticeOk = (date: string) => Boolean(employee.tipCreditNoticeDate && employee.tipCreditNoticeDate <= date);
      let warnedNotice = false;
      const wageShifts: WageShift[] = [];
      for (const s of mine) {
        const role = settings.roles.find((r) => r.key === s.roleKey);
        const rate = s.rateCentsPerHour ?? employee.roleRates[s.roleKey] ?? employee.payType.rateCents;
        let creditRole = role?.tipped === 'customarily';
        if (creditRole && tipCreditInEffect && !noticeOk(s.workDate)) {
          creditRole = false;
          if (!warnedNotice) {
            warnedNotice = true;
            flag(blocking('tip_credit_notice_missing', `${name} has no tip-credit notice on file dated on or before ${s.workDate}. Without it the tip credit cannot be taken, so the full minimum wage applies. Record the date they were given the notice.`, { date: s.workDate }));
          }
        }
        wageShifts.push({
          shiftId: s.id,
          workDate: s.workDate,
          sortKey: s.clockIn ?? s.createdAt,
          roleKey: s.roleKey,
          minutes: s.minutes,
          rateCentsPerHour: rate,
          tipCreditRole: creditRole,
          mealBreakViolation: s.mealBreakViolation,
          restBreakViolation: s.restBreakViolation,
          ...(s.clockIn ? { clockIn: s.clockIn } : {}),
          ...(s.clockOut ? { clockOut: s.clockOut } : {}),
          ...(s.scheduledMinutes !== undefined ? { scheduledMinutes: s.scheduledMinutes } : {}),
        });
      }
      const tipsReceivedByDate = new Map<string, Cents>();
      for (const s of mine) {
        const t = tipsByShift.get(s.id)!;
        tipsReceivedByDate.set(s.workDate, (tipsReceivedByDate.get(s.workDate) ?? 0) + t.keptCents + t.tipOutReceivedCents + t.poolShareCents + t.cashTipsCents);
      }
      const wages = computeHourlyWages({
        employeeId: employee.id,
        state: employee.workState.code,
        locality: settings.locality,
        region: settings.region,
        weekStartDay: settings.workweekStartDay,
        takesTipCredit: settings.policy.takesTipCredit,
        periodStart,
        periodEnd,
        shifts: wageShifts,
        tipsReceivedByDate,
      });
      issues.push(...wages.issues);
      paidMinutes = wages.paidMinutes;
      weeks = wages.weeks.map((w) => ({ weekStart: w.weekStart, weekEnd: w.weekEnd, minutes: w.minutes, overtimeMinutes: w.overtimeMinutes, doubleTimeMinutes: w.doubleTimeMinutes, regularRateCentsPerHour: w.regularRateCentsPerHour, creditClaimedCents: w.creditClaimedCents, tipsReceivedCents: w.tipsReceivedCents, makeupCents: w.makeupCents }));
      for (const l of wages.lines) earnings.push({ code: l.code, category: 'regular', amountCents: l.amountCents, minutes: l.minutes, detail: l.detail, paidByPayroll: true });
    } else {
      earnings.push({ code: 'SALARY', category: 'regular', amountCents: salaryForPeriod(employee.payType.annualCents, periodsPerYear), detail: `${frequency} salary`, paidByPayroll: true });
      // Salaried staff are not owed overtime only if they are exempt. The federal salary-level test is checked; the duties test, and states with a higher salary level, are not.
      const weeklySalary = Math.round(employee.payType.annualCents / 52);
      if (!meetsStandardSalaryLevelTest(weeklySalary)) {
        flag(blocking('salary_below_exempt_threshold', `${name}'s salary (${weeklySalary}¢ a week) is below the federal exemption salary level (${FLSA_STANDARD_SALARY_LEVEL_WEEKLY}¢ a week), so they cannot be treated as exempt. Pay them hourly with overtime, or raise the salary.`, {}));
      } else {
        flag(info('exemption_duties_not_tested', `${name} is salaried and meets the federal salary level. Whether their duties qualify for an exemption, and whether a higher state salary level applies, is not tested.`, {}));
      }
      if (employee.hireDate > periodStart || (employee.terminationDate && employee.terminationDate < periodEnd)) {
        flag(review('salary_not_prorated', `${name} was hired or terminated inside this period. Salary is paid in full; proration is not modelled.`, {}));
      }
      if (mine.length > 0) flag(review('salaried_with_shifts', `${name} is salaried and has shifts. Overtime is not computed for salaried staff; confirm they meet an FLSA exemption (duties and salary level).`, {}));
    }

    // Tips and service charges for shifts inside the period
    const inPeriod = mine.filter((s) => inRange(s.workDate, periodStart, periodEnd));
    const t = { kept: 0, received: 0, paid: 0, pool: 0, cash: 0, svc: 0, fee: 0 };
    for (const s of inPeriod) {
      const x = tipsByShift.get(s.id)!;
      t.kept += x.keptCents;
      t.received += x.tipOutReceivedCents;
      t.paid += x.tipOutPaidCents;
      t.pool += x.poolShareCents;
      t.cash += x.cashTipsCents;
      t.svc += x.serviceChargeShareCents;
      t.fee += x.cardFeeCents;
    }
    const tipLine = (code: string, amountCents: number, detail: string, paidByPayroll = true) => {
      if (amountCents > 0) earnings.push({ code, category: 'regular', amountCents, detail, paidByPayroll });
    };
    tipLine('TIPS_CHARGED', t.kept, 'Card tips and counted cash tips, after tip-outs and pool', true);
    tipLine('TIPS_TIPOUT', t.received, 'Tip-outs received from other roles', true);
    tipLine('TIPS_POOL', t.pool, 'Share of the tip pool', true);
    tipLine('TIPS_CASH', t.cash, 'Cash tips the employee kept and declared (taxed, not paid by payroll)', false);
    tipLine('SVC_CHG', t.svc, 'Share of mandatory service charges (wages, not tips)', true);

    for (const a of input.adjustments.filter((x) => x.employeeId === employee.id)) {
      earnings.push({ code: a.code, category: a.category, amountCents: a.amountCents, detail: a.label, paidByPayroll: true });
    }

    if (earnings.length === 0) {
      issues.push(info('no_earnings', `${name} has no earnings in this period and was left off the run.`, { employeeId: employee.id }));
      continue;
    }

    // Tax engine
    const engineEarnings: Earning[] = earnings.map((e) => ({ code: e.code, category: e.category, amount: e.amountCents }));
    const cashGross = sum(earnings.filter((e) => e.category !== 'imputed' && e.category !== 'reimbursement').map((e) => e.amountCents));
    const deductions: Deduction[] = employee.deductionPlans
      .filter((p) => p.active)
      .map((p) => ({ code: p.code, category: p.category, amount: p.amount.kind === 'flat' ? p.amount.cents : Math.round(cashGross * (p.amount.percent / 100)) }));
    const pc: PaycheckInput = {
      checkDate,
      payFrequency: frequency,
      earnings: engineEarnings,
      deductions,
      federalW4: employee.federalW4,
      ytd: employee.ytdYear === checkYear ? employee.ytd : freshYearToDate(),
      employer: employerContextFor(company),
      employmentCategory: 'standard',
      workState: employee.workState,
      residenceState: employee.residenceState,
      hoursWorked: paidMinutes / 60,
      ...(employee.ageAtYearEnd !== undefined ? { employee: { ageAtYearEnd: employee.ageAtYearEnd } } : {}),
    };
    let result;
    try {
      result = calculatePaycheck(pc);
    } catch (e) {
      issues.push(blocking('tax_engine_refused', `The tax engine could not compute ${name}'s paycheck: ${(e as Error).message}`, { employeeId: employee.id }));
      continue;
    }
    for (const n of result.notices ?? []) issues.push(review('tax_data_quality', `${name}: ${n.taxId} (${n.tier}) ${n.note}`, { employeeId: employee.id }));
    for (const w of result.warnings ?? []) issues.push(blocking('negative_net_pay', `${name}: ${w}`, { employeeId: employee.id }));

    const reimbursementCents = sum(earnings.filter((e) => e.category === 'reimbursement').map((e) => e.amountCents));
    const cashTipsCents = t.cash;
    let payable = result.netPay - cashTipsCents;
    let uncollected = 0;
    if (payable < 0 && result.netPay >= 0) {
      uncollected = -payable;
      payable = 0;
      issues.push(review('tip_tax_uncollected', `${name}'s tax on cash tips (${uncollected}¢) is larger than the cash pay left to collect it from. It was not collected. Uncollected Social Security and Medicare tax on tips goes on the W-2 (box 12, codes A and B).`, { employeeId: employee.id }));
    }
    payable = Math.max(0, payable);

    paychecks.push({
      employeeId: employee.id,
      name,
      earnings,
      hours: Math.round((paidMinutes / 60) * 100) / 100,
      taxableWagesCents: cashGross,
      reimbursementCents,
      cashTipsCents,
      netPayCents: result.netPay,
      payableCents: payable,
      employeeTaxCents: result.employeeTaxTotal,
      employerTaxCents: result.employerTaxTotal,
      deductionsCents: result.pretaxDeductions + result.posttaxDeductions,
      deductionLines: deductions.map((d) => ({ code: d.code, category: d.category, amountCents: d.amount })),
      uncollectedCents: uncollected,
      taxLines: result.taxes,
      ...(result.electiveDeferrals ? { electiveDeferrals: result.electiveDeferrals } : {}),
      tips: { chargedKeptCents: t.kept, tipOutReceivedCents: t.received, tipOutPaidCents: t.paid, poolShareCents: t.pool, cashCents: t.cash, serviceChargeCents: t.svc, cardFeeCents: t.fee },
      weeks,
    });
  }

  const totals = totalsOf(paychecks);
  return {
    id: keep?.id ?? newId('run'),
    companyId: company.id,
    periodStart,
    periodEnd,
    checkDate,
    status: 'draft',
    adjustments: input.adjustments,
    paychecks,
    issues,
    totals,
    createdAt: keep?.createdAt ?? new Date().toISOString(),
  };
}

export function totalsOf(paychecks: readonly Paycheck[]): PayRun['totals'] {
  const payableCents = sum(paychecks.map((p) => p.payableCents));
  const employeeTaxCollected = sum(paychecks.map((p) => p.employeeTaxCents - p.uncollectedCents));
  const employerTaxCents = sum(paychecks.map((p) => p.employerTaxCents));
  const deductionsCents = sum(paychecks.map((p) => p.deductionsCents));
  return {
    grossCents: sum(paychecks.map((p) => p.taxableWagesCents + p.reimbursementCents)),
    payableCents,
    employeeTaxCents: employeeTaxCollected,
    employerTaxCents,
    deductionsCents,
    cashTipsCents: sum(paychecks.map((p) => p.cashTipsCents)),
    fundingRequiredCents: payableCents + employeeTaxCollected + deductionsCents + employerTaxCents,
  };
}

export function draftPayRun(store: Store, companyId: string, body: unknown): PayRun {
  const company = store.companies.require(companyId, 'Company');
  const input = parseDraftInput(body, company, store);
  const run = buildPayRun(store, company, input);
  return store.tx(() => store.payRuns.put(run));
}

export function getRun(store: Store, companyId: string, runId: string): PayRun {
  const run = store.payRuns.get(runId);
  if (!run || run.companyId !== companyId) throw notFound('Pay run');
  return run;
}

/** Recompute a draft from the shifts as they stand now (a time entry was fixed). Approved runs never recompute. */
export function recalculatePayRun(store: Store, companyId: string, runId: string): PayRun {
  const run = getRun(store, companyId, runId);
  if (run.status !== 'draft') throw conflict('not_a_draft', `Only a draft can be recalculated; this run is ${run.status}.`);
  const company = store.companies.require(companyId, 'Company');
  const fresh = buildPayRun(store, company, { periodStart: run.periodStart, periodEnd: run.periodEnd, checkDate: run.checkDate, adjustments: run.adjustments }, { id: run.id, createdAt: run.createdAt });
  return store.tx(() => store.payRuns.put(fresh));
}

/**
 * Lock a draft: no blocking issue may remain and every review issue must be
 * acknowledged. Locks the period's shifts, and rolls each paycheck into the
 * employee's year-to-date, which is what makes the next run's wage-base caps
 * correct. This is the one moment a pay run changes durable state.
 */
export function approvePayRun(store: Store, companyId: string, runId: string, body: unknown): PayRun {
  const o = v.obj(body ?? {});
  const run = getRun(store, companyId, runId);
  if (run.status !== 'draft') throw conflict('not_a_draft', `Only a draft can be approved; this run is ${run.status}.`);
  const blockers = run.issues.filter((i) => i.severity === 'blocking');
  if (blockers.length > 0) throw conflict('blocking_issues', `${blockers.length} blocking issue(s) must be fixed first. Recalculate after fixing.`, { issues: blockers });
  const reviews = run.issues.filter((i) => i.severity === 'review');
  const acknowledged = o.acknowledgeReviewIssues === true;
  if (reviews.length > 0 && !acknowledged) {
    throw conflict('review_not_acknowledged', `${reviews.length} issue(s) need an operator's review. Read them, then approve with acknowledgeReviewIssues: true.`, { issues: reviews });
  }
  if (run.paychecks.length === 0) throw conflict('empty_run', 'There is nothing to pay in this run.');

  // Re-derive to make sure nothing changed since the draft was read.
  const company = store.companies.require(companyId, 'Company');
  const current = buildPayRun(store, company, { periodStart: run.periodStart, periodEnd: run.periodEnd, checkDate: run.checkDate, adjustments: run.adjustments }, { id: run.id, createdAt: run.createdAt });
  if (JSON.stringify(current.paychecks) !== JSON.stringify(run.paychecks)) {
    throw conflict('run_is_stale', 'Shifts or employee records changed after this draft was calculated. Recalculate it and review the new numbers.');
  }

  const checkYear = Number(run.checkDate.slice(0, 4));
  return store.tx(() => {
    const ytdBefore: NonNullable<PayRun['ytdBefore']> = {};
    const ytdAfter: NonNullable<PayRun['ytdAfter']> = {};
    for (const pc of run.paychecks) {
      const employee = store.employees.require(pc.employeeId, 'Employee');
      const start = employee.ytdYear === checkYear ? employee.ytd : freshYearToDate();
      ytdBefore[employee.id] = { ytd: structuredClone(employee.ytd), ytdYear: employee.ytdYear };
      const next = accumulateYtd(start, { checkDate: run.checkDate, employmentCategory: 'standard', grossPay: pc.taxableWagesCents + pc.reimbursementCents, taxLines: pc.taxLines, electiveDeferrals: pc.electiveDeferrals });
      store.employees.put({ ...employee, ytd: next, ytdYear: checkYear });
      ytdAfter[employee.id] = { ytd: structuredClone(next), ytdYear: checkYear };
    }
    for (const s of store.shifts.where((x) => x.companyId === companyId && inRange(x.workDate, run.periodStart, run.periodEnd))) {
      store.shifts.put({ ...s, lockedByRunId: run.id });
    }
    for (const h of store.houseDays.where((x) => x.companyId === companyId && inRange(x.date, run.periodStart, run.periodEnd))) {
      store.houseDays.put({ ...h, lockedByRunId: run.id });
    }
    return store.payRuns.put({ ...run, status: 'approved', reviewAcknowledgedAt: reviews.length > 0 ? new Date().toISOString() : undefined, approvedAt: new Date().toISOString(), ytdBefore, ytdAfter });
  });
}

/** Cancel a run that has not moved money. An approved run is unwound exactly: its shifts unlock and each employee's year-to-date is restored. */
export function voidPayRun(store: Store, companyId: string, runId: string): PayRun {
  const run = getRun(store, companyId, runId);
  if (run.status === 'voided') return run;
  if (run.status !== 'draft' && run.status !== 'approved') {
    throw conflict('money_in_motion', `This run is ${run.status}; money has started moving, so it cannot be voided. Reverse payments through Stripe instead.`);
  }
  if (store.legs.where((l) => l.runId === run.id).length > 0) {
    throw conflict('money_in_motion', 'Funding has been started for this run, so it cannot be voided.');
  }
  return store.tx(() => {
    if (run.status === 'approved') {
      for (const [employeeId, after] of Object.entries(run.ytdAfter ?? {})) {
        const e = store.employees.require(employeeId, 'Employee');
        if (JSON.stringify(e.ytd) !== JSON.stringify(after.ytd) || e.ytdYear !== after.ytdYear) {
          throw conflict('later_run_exists', `${e.firstName} ${e.lastName}'s year-to-date has changed since this run was approved (a later run exists). Void the later run first.`);
        }
        const before = run.ytdBefore![employeeId];
        store.employees.put({ ...e, ytd: before.ytd, ytdYear: before.ytdYear });
      }
      for (const s of store.shifts.where((x) => x.lockedByRunId === run.id)) {
        const { lockedByRunId: _l, ...rest } = s;
        store.shifts.put(rest);
      }
      for (const h of store.houseDays.where((x) => x.lockedByRunId === run.id)) {
        const { lockedByRunId: _l, ...rest } = h;
        store.houseDays.put(rest);
      }
    }
    return store.payRuns.put({ ...run, status: 'voided', voidedAt: new Date().toISOString() });
  });
}

