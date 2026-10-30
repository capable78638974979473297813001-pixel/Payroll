import { addDays, daysBetween, workweekStart } from '../lib/dates.ts';
import { onOrBeforeBankingDay } from '../lib/bizdays.ts';
import type { Company, PayRun } from '../domain/types.ts';

/**
 * Pay periods for a company's schedule: which dates a pay run covers and when its check date is. Weekly periods are
 * workweeks. Every other week counts 14-day blocks from an anchor (the start of the first run, or the company's first
 * workweek). Twice a month is the 1st to the 15th and the 16th to month end. Monthly is the calendar month. The check
 * date is the period's end plus the company's lag, moved back to a banking day so employees are paid on time.
 */

export interface Period {
  periodStart: string;
  periodEnd: string;
  checkDate: string;
}

const lastOfMonth = (iso: string) => {
  const [y, m] = iso.split('-').map(Number) as [number, number];
  return `${y}-${String(m).padStart(2, '0')}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
};

function checkDateFor(company: Company, periodEnd: string): string {
  return onOrBeforeBankingDay(addDays(periodEnd, company.paySchedule.checkDateLagDays));
}

function anchorFor(company: Company, runs: PayRun[]): string {
  const first = runs.filter((r) => r.status !== 'voided').sort((a, b) => a.periodStart.localeCompare(b.periodStart))[0];
  return first ? first.periodStart : workweekStart(company.createdAt.slice(0, 10), company.settings.workweekStartDay);
}

/** The pay period that contains `date`. */
export function periodContaining(company: Company, date: string, runs: PayRun[] = []): Period {
  const f = company.paySchedule.frequency;
  let start: string;
  let end: string;
  if (f === 'weekly') {
    start = workweekStart(date, company.settings.workweekStartDay);
    end = addDays(start, 6);
  } else if (f === 'biweekly') {
    const anchor = anchorFor(company, runs);
    const blocks = Math.floor(daysBetween(anchor, date) / 14);
    start = addDays(anchor, blocks * 14);
    end = addDays(start, 13);
  } else if (f === 'semimonthly') {
    const day = Number(date.slice(8, 10));
    start = day <= 15 ? `${date.slice(0, 8)}01` : `${date.slice(0, 8)}16`;
    end = day <= 15 ? `${date.slice(0, 8)}15` : lastOfMonth(date);
  } else {
    start = `${date.slice(0, 8)}01`;
    end = lastOfMonth(date);
  }
  return { periodStart: start, periodEnd: end, checkDate: checkDateFor(company, end) };
}

export function previousPeriod(company: Company, p: Period, runs: PayRun[] = []): Period {
  return periodContaining(company, addDays(p.periodStart, -1), runs);
}

export type PeriodState = 'open' | 'paid' | 'in_progress';

export interface SuggestedPeriod extends Period {
  /** open: nothing drafted for it. in_progress: a run is drafted or approved. paid: a run is complete. */
  state: PeriodState;
  runId?: string;
  /** The period has not finished yet. */
  current: boolean;
}

/** The current period and the few before it, with what has been done for each. Newest first. */
export function suggestPeriods(company: Company, today: string, runs: PayRun[], n = 5, notBefore?: string): SuggestedPeriod[] {
  const live = runs.filter((r) => r.status !== 'voided');
  const out: SuggestedPeriod[] = [];
  let p = periodContaining(company, today, runs);
  for (let i = 0; i < n; i++) {
    if (notBefore && p.periodEnd < notBefore) break;
    const run = live.find((r) => r.periodStart === p.periodStart && r.periodEnd === p.periodEnd) ?? live.find((r) => r.periodStart <= p.periodEnd && r.periodEnd >= p.periodStart);
    out.push({ ...p, state: run ? (run.status === 'completed' ? 'paid' : 'in_progress') : 'open', ...(run ? { runId: run.id } : {}), current: p.periodEnd >= today });
    p = previousPeriod(company, p, runs);
  }
  return out;
}

export interface NextPayday {
  period: Period;
  state: PeriodState;
  runId?: string;
  /** Days from today to the check date (negative when it has passed). */
  daysUntil: number;
  /** True when the period has ended, so hours can be entered and the run reviewed. */
  ready: boolean;
}

/**
 * The next pay run that needs attention: the most recent finished period nobody has paid, else the current one.
 * Periods that ended before the company joined are not owed (a business that switches providers paid those
 * elsewhere), and older unpaid periods are still there in the period picker.
 */
export function nextPayday(company: Company, today: string, runs: PayRun[]): NextPayday {
  const since = company.createdAt.slice(0, 10);
  const periods = suggestPeriods(company, today, runs, 120, since);
  const owed = periods.filter((p) => !p.current && p.state !== 'paid' && p.periodEnd >= since);
  const pick = owed[0] ?? periods.find((p) => p.current) ?? periods[0]!;
  return { period: { periodStart: pick.periodStart, periodEnd: pick.periodEnd, checkDate: pick.checkDate }, state: pick.state, ...(pick.runId ? { runId: pick.runId } : {}), daysUntil: daysBetween(today, pick.checkDate), ready: !pick.current };
}
