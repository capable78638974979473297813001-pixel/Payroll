import { type Cents } from '../lib/money.ts';
import { addDays, workweekStart } from '../lib/dates.ts';
import { blocking, info, review, type Issue } from '../lib/issues.ts';
import { dailyMealAndRestPremium } from '../../engine/payroll/mealRestBreaks.ts';
import { classifyWorkweek, overtimeRuleFor } from './overtime.ts';
import { wageFloors, type WageFloors } from './floors.ts';

/**
 * Hourly wages for one employee across one pay period, in whole minutes.
 *
 * Overtime is decided per FLSA workweek (see overtime.ts). The regular rate
 * for a week is its total straight-time value divided by its hours, where an
 * hour's value is the cash wage plus any tip credit claimed for it (29 CFR
 * 778.115 and 531.60). Premium pay is half that rate for overtime hours and
 * the full rate for double-time hours, on top of straight-time cash:
 *
 *   tipped overtime hour, cash wage r and credit c:  r + 0.5(r + c) = 1.5(r + c) − c
 *
 * which is exactly "time and a half of the full minimum wage, less the credit".
 *
 * A tip credit is only valid up to the tips the employee actually received
 * that workweek. When tips fall short of the credit claimed, the employer owes
 * the shortfall (29 U.S.C. § 203(m)(2)(A)). It is added to the pay run that
 * contains the workweek's last day.
 *
 * Fractional cents are carried through each week and rounded once per earning
 * code at the end, so a many-shift week never accumulates per-shift rounding.
 */

export interface WageShift {
  shiftId: string;
  workDate: string;
  /** Orders shifts within a day; the earliest shifts take the regular minutes first. */
  sortKey: string;
  roleKey: string;
  minutes: number;
  /** The cash wage actually paid for this shift. */
  rateCentsPerHour: Cents;
  /** The role customarily receives tips, so a tip credit may be taken for it. */
  tipCreditRole: boolean;
  mealBreakViolation: boolean;
  restBreakViolation: boolean;
  /** ISO timestamps, when known. New York's spread-of-hours rule needs them. */
  clockIn?: string;
  clockOut?: string;
  /** The length of the regularly scheduled shift this one replaces, when there is one. Caps New York call-in pay. */
  scheduledMinutes?: number;
}

export interface WageParams {
  employeeId: string;
  state: string;
  locality?: string;
  region?: string;
  weekStartDay: number;
  takesTipCredit: boolean;
  periodStart: string;
  periodEnd: string;
  /** Every shift in every workweek that touches the period, including days before or after it. */
  shifts: readonly WageShift[];
  /** Tips the employee actually received on each date (kept + tip-outs received + pool + cash). */
  tipsReceivedByDate: ReadonlyMap<string, Cents>;
}

export type WageCode = 'REG' | 'OT' | 'DT' | 'BREAK_PREMIUM' | 'TIP_MAKEUP' | 'SPREAD_HOURS' | 'CALL_IN_PAY';

export interface WageLine {
  code: WageCode;
  amountCents: Cents;
  minutes: number;
  detail: string;
}

export interface WeekSummary {
  weekStart: string;
  weekEnd: string;
  minutes: number;
  regularMinutes: number;
  overtimeMinutes: number;
  doubleTimeMinutes: number;
  regularRateCentsPerHour: Cents;
  creditClaimedCents: Cents;
  tipsReceivedCents: Cents;
  makeupCents: Cents;
  makeupDeferred: boolean;
}

export interface WageResult {
  lines: WageLine[];
  weeks: WeekSummary[];
  paidMinutes: number;
  issues: Issue[];
}

type Cat = 'reg' | 'ot' | 'dt';

export function computeHourlyWages(p: WageParams): WageResult {
  const issues: Issue[] = [];
  const rule = overtimeRuleFor(p.state);

  const floorsCache = new Map<string, WageFloors | null>();
  let floorsFailed = false;
  const floorsFor = (date: string): WageFloors | null => {
    if (floorsCache.has(date)) return floorsCache.get(date)!;
    let f: WageFloors | null = null;
    try {
      f = wageFloors(date, p.state, p.locality, p.region);
    } catch (e) {
      if (!floorsFailed) {
        issues.push(blocking('minimum_wage_unavailable', `Could not look up the minimum wage for ${p.state}${p.locality ? ` / ${p.locality}` : ''} on ${date}: ${(e as Error).message}`, { employeeId: p.employeeId, date }));
        floorsFailed = true;
      }
    }
    floorsCache.set(date, f);
    return f;
  };

  const flagged = new Set<string>();
  const flagOnce = (key: string, issue: Issue) => {
    if (!flagged.has(key)) {
      flagged.add(key);
      issues.push(issue);
    }
  };

  /** Tip credit per hour for one shift, with the floor checks that guard it. */
  const creditPerHour = (s: WageShift): number => {
    const f = floorsFor(s.workDate);
    if (!f) return 0;
    if (s.tipCreditRole && p.takesTipCredit && f.tipCreditAllowed) {
      if (s.rateCentsPerHour < f.cashFloorCentsPerHour) {
        flagOnce(`cash-floor:${s.roleKey}:${f.cashFloorCentsPerHour}`, blocking('below_tipped_cash_floor', `A ${s.roleKey} is paid ${s.rateCentsPerHour}¢/hour in cash; the lowest tipped cash wage here is ${f.cashFloorCentsPerHour}¢.`, { employeeId: p.employeeId, date: s.workDate }));
        return f.maxCreditCentsPerHour;
      }
      return Math.max(0, f.standardFloorCentsPerHour - s.rateCentsPerHour);
    }
    if (s.rateCentsPerHour < f.standardFloorCentsPerHour) {
      flagOnce(`min-wage:${s.roleKey}:${f.standardFloorCentsPerHour}`, blocking('below_minimum_wage', `A ${s.roleKey} is paid ${s.rateCentsPerHour}¢/hour; the minimum wage here is ${f.standardFloorCentsPerHour}¢${p.takesTipCredit && s.tipCreditRole && !f.tipCreditAllowed ? ' (no tip credit is allowed in this jurisdiction)' : ''}.`, { employeeId: p.employeeId, date: s.workDate }));
    }
    return 0;
  };

  // Group the shifts into workweeks.
  const byWeek = new Map<string, WageShift[]>();
  for (const s of p.shifts) {
    const wk = workweekStart(s.workDate, p.weekStartDay);
    (byWeek.get(wk) ?? byWeek.set(wk, []).get(wk)!).push(s);
  }

  const inPeriod = (d: string) => d >= p.periodStart && d <= p.periodEnd;
  const paid = { reg: 0, ot: 0, dt: 0 };
  const cash = { reg: 0, ot: 0, dt: 0 };
  const premiumTotal = { ot: 0, dt: 0 };
  let breakPremium = 0;
  let breakDays = 0;
  let spreadPay = 0;
  let spreadDays = 0;
  let callInPay = 0;
  let callInDays = 0;
  let makeupTotal = 0;
  const weeks: WeekSummary[] = [];

  for (const weekStart of [...byWeek.keys()].sort()) {
    const shifts = byWeek.get(weekStart)!;
    const weekEnd = addDays(weekStart, 6);
    const minutesByDate = new Map<string, number>();
    for (const s of shifts) minutesByDate.set(s.workDate, (minutesByDate.get(s.workDate) ?? 0) + s.minutes);
    // Per-shift credit and straight-time value for the whole week.
    const totalMinutes = shifts.reduce((a, s) => a + s.minutes, 0);
    let straightValue = 0; // cents
    let creditClaimed = 0; // cents
    for (const s of shifts) {
      const c = creditPerHour(s);
      straightValue += ((s.rateCentsPerHour + c) * s.minutes) / 60;
      creditClaimed += (c * s.minutes) / 60;
    }
    const regularRate = totalMinutes > 0 ? Math.round((straightValue * 60) / totalMinutes) : 0;

    // Nevada's daily rule applies only to an employee paid under 1.5 times the minimum wage.
    let nevadaDailyApplies = false;
    if (rule === 'nevada') {
      const f = floorsFor(weekEnd);
      nevadaDailyApplies = f ? regularRate < 1.5 * f.standardFloorCentsPerHour : true;
    }
    const classes = classifyWorkweek(weekStart, minutesByDate, rule, { nevadaDailyApplies });

    // Walk each day's shifts in order, handing out regular, then overtime, then double-time minutes.
    let weekReg = 0;
    let weekOt = 0;
    let weekDt = 0;
    let periodOtMinutes = 0;
    let periodDtMinutes = 0;
    for (const day of classes) {
      const left: Record<Cat, number> = { reg: day.regular, ot: day.overtime, dt: day.doubleTime };
      weekReg += day.regular;
      weekOt += day.overtime;
      weekDt += day.doubleTime;
      const dayShifts = shifts.filter((s) => s.workDate === day.date).sort((a, b) => a.sortKey.localeCompare(b.sortKey) || a.shiftId.localeCompare(b.shiftId));
      for (const s of dayShifts) {
        let remaining = s.minutes;
        for (const cat of ['reg', 'ot', 'dt'] as const) {
          const take = Math.min(remaining, left[cat]);
          if (take === 0) continue;
          left[cat] -= take;
          remaining -= take;
          if (inPeriod(day.date)) {
            paid[cat] += take;
            cash[cat] += (s.rateCentsPerHour * take) / 60;
            if (cat === 'ot') periodOtMinutes += take;
            if (cat === 'dt') periodDtMinutes += take;
          }
        }
      }
    }
    if (totalMinutes > 0) {
      premiumTotal.ot += (0.5 * straightValue * periodOtMinutes) / totalMinutes;
      premiumTotal.dt += (1.0 * straightValue * periodDtMinutes) / totalMinutes;
    }
    // California meal and rest premiums, once per category per day.
    for (const date of [...minutesByDate.keys()].filter(inPeriod)) {
      const dayShifts = shifts.filter((s) => s.workDate === date);
      const meal = dayShifts.some((s) => s.mealBreakViolation);
      const rest = dayShifts.some((s) => s.restBreakViolation);
      if (!meal && !rest) continue;
      if (p.state !== 'CA') {
        issues.push(review('break_premium_not_modelled', `A missed meal or rest break was marked on ${date}, but break premiums are only modelled for California. Nothing was added.`, { employeeId: p.employeeId, date }));
        continue;
      }
      breakPremium += dailyMealAndRestPremium(meal, rest, regularRate);
      breakDays += 1;
    }

    // New York Hospitality Wage Order (12 NYCRR 146-1.5, 146-1.6): spread-of-hours pay and call-in pay.
    if (p.state === 'NY') {
      for (const date of [...minutesByDate.keys()].filter(inPeriod).sort()) {
        const dayShifts = shifts.filter((s) => s.workDate === date);
        const worked = dayShifts.reduce((a, s) => a + s.minutes, 0);
        const f = floorsFor(date);
        if (!f) continue;
        const basic = f.standardFloorCentsPerHour;

        // Spread of hours: first start to last finish, meals and gaps included. More than 10 hours earns one extra hour at the basic minimum rate.
        const known = dayShifts.every((s) => s.clockIn && s.clockOut);
        let spread: number | undefined;
        if (known) {
          const starts = dayShifts.map((s) => Date.parse(s.clockIn!));
          const ends = dayShifts.map((s) => Date.parse(s.clockOut!));
          if ([...starts, ...ends].every((t) => !Number.isNaN(t))) spread = Math.round((Math.max(...ends) - Math.min(...starts)) / 60_000);
        }
        // Without clock times the spread is at least the time worked, which is enough to prove it over 10 hours but not to prove it under.
        const owed = spread !== undefined ? spread > 600 : worked > 600;
        if (owed) {
          spreadPay += basic;
          spreadDays += 1;
        } else if (spread === undefined && dayShifts.length > 1) {
          issues.push(review('spread_of_hours_unknown', `${date} has several shifts without clock times, so New York's spread-of-hours rule (more than 10 hours from first start to last finish) cannot be checked. Enter clockIn and clockOut.`, { employeeId: p.employeeId, date }));
        }

        // Call-in pay: at least 3 hours for one shift, 6 for two shifts totalling 6 or less, 8 for three totalling 8 or less, or the regularly scheduled shift if that is shorter.
        // Time worked is paid at the regular rate; the balance at the basic minimum rate with no tip credit.
        const n = dayShifts.length;
        const floorMinutes = n === 1 ? 180 : n === 2 ? (worked <= 360 ? 360 : 0) : worked <= 480 ? 480 : 0;
        const scheduled = dayShifts.every((s) => s.scheduledMinutes !== undefined) ? dayShifts.reduce((a, s) => a + (s.scheduledMinutes ?? 0), 0) : undefined;
        const required = scheduled !== undefined ? Math.min(floorMinutes, scheduled) : floorMinutes;
        if (worked < required) {
          callInPay += ((required - worked) * basic) / 60;
          callInDays += 1;
        }
      }
    }

    // Tip credit make-up, in the run that contains the workweek's last day.
    const weekTips = Array.from({ length: 7 }, (_, i) => p.tipsReceivedByDate.get(addDays(weekStart, i)) ?? 0).reduce((a, b) => a + b, 0);
    const creditRounded = Math.round(creditClaimed);
    const endsInPeriod = inPeriod(weekEnd);
    const touchesPeriod = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)).some(inPeriod);
    let makeup = 0;
    let deferred = false;
    if (creditRounded > 0 && endsInPeriod) {
      makeup = Math.max(0, creditRounded - weekTips);
      makeupTotal += makeup;
    } else if (creditRounded > 0 && touchesPeriod) {
      deferred = true;
      issues.push(info('tip_makeup_deferred', `The workweek starting ${weekStart} runs past this pay period, so any tip-credit make-up for it is computed in the run that contains ${weekEnd}.`, { employeeId: p.employeeId }));
    }

    if (touchesPeriod) {
      weeks.push({
        weekStart,
        weekEnd,
        minutes: totalMinutes,
        regularMinutes: weekReg,
        overtimeMinutes: weekOt,
        doubleTimeMinutes: weekDt,
        regularRateCentsPerHour: regularRate,
        creditClaimedCents: creditRounded,
        tipsReceivedCents: weekTips,
        makeupCents: makeup,
        makeupDeferred: deferred,
      });
    }
  }

  const lines: WageLine[] = [];
  const push = (code: WageCode, amountCents: number, minutes: number, detail: string) => {
    if (amountCents !== 0 || minutes !== 0) lines.push({ code, amountCents, minutes, detail });
  };
  push('REG', Math.round(cash.reg), paid.reg, `${(paid.reg / 60).toFixed(2)} regular hours`);
  push('OT', Math.round(cash.ot + premiumTotal.ot), paid.ot, `${(paid.ot / 60).toFixed(2)} overtime hours at time and a half of the regular rate`);
  push('DT', Math.round(cash.dt + premiumTotal.dt), paid.dt, `${(paid.dt / 60).toFixed(2)} double-time hours at twice the regular rate`);
  push('BREAK_PREMIUM', breakPremium, 0, `${breakDays} day(s) with a missed meal or rest break, one hour's pay per category (CA Labor Code § 226.7)`);
  push('SPREAD_HOURS', spreadPay, 0, `${spreadDays} day(s) with more than 10 hours from first start to last finish: one extra hour at the basic minimum wage (12 NYCRR 146-1.6)`);
  push('CALL_IN_PAY', Math.round(callInPay), 0, `${callInDays} day(s) worked less than the call-in minimum: the balance at the basic minimum wage, no tip credit (12 NYCRR 146-1.5)`);
  push('TIP_MAKEUP', makeupTotal, 0, 'Tips fell short of the tip credit claimed; employer pays the difference (29 U.S.C. § 203(m)(2)(A))');

  return { lines, weeks, paidMinutes: paid.reg + paid.ot + paid.dt, issues };
}

/** Pay for salaried staff for one period. Exempt status is a duties question Totali does not decide. */
export function salaryForPeriod(annualCents: Cents, periodsPerYear: number): Cents {
  return Math.round(annualCents / periodsPerYear);
}

