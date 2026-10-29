import { badRequest } from '../lib/errors.ts';
import { sum } from '../lib/money.ts';
import type { Store } from '../store/store.ts';
import { onOrAfterBankingDay } from '../lib/bizdays.ts';
import { ficaTipCredit, form8027Applies, mustReportTips, MONTHLY_TIP_REPORTING_THRESHOLD } from './tipReporting.ts';

const TIP_CODES = new Set(['TIPS_CHARGED', 'TIPS_TIPOUT', 'TIPS_POOL', 'TIPS_CASH']);

/**
 * Tip reporting for a date range: who has to report cash tips this month, what
 * the FICA tip credit is worth for the pay runs in the range, and whether
 * Form 8027 applies. Cash tips come from the shifts, by the day worked; the
 * credit comes from the approved pay runs, by check date.
 */
export function tipReport(store: Store, companyId: string, from: string, to: string) {
  if (to < from) throw badRequest('to is before from');
  const company = store.companies.require(companyId, 'Company');
  const names = new Map(store.employees.where((e) => e.companyId === companyId).map((e) => [e.id, `${e.firstName} ${e.lastName}`]));

  // What each person's own shifts recorded, by month. Tip-outs received and pool shares are on pay stubs.
  const byMonth = new Map<string, { cash: number; card: number }>();
  for (const s of store.shifts.where((x) => x.companyId === companyId && x.workDate >= from && x.workDate <= to && (x.cashTipsCents > 0 || x.chargedTipsCents > 0))) {
    const k = `${s.employeeId}|${s.workDate.slice(0, 7)}`;
    const cur = byMonth.get(k) ?? { cash: 0, card: 0 };
    cur.cash += s.cashTipsCents;
    cur.card += s.chargedTipsCents;
    byMonth.set(k, cur);
  }
  const tipReporting = [...byMonth.entries()]
    .map(([k, t]) => {
      const [employeeId, month] = k.split('|');
      return { employeeId, name: names.get(employeeId) ?? employeeId, month, cashTipsCents: t.cash, cardTipsCents: t.card, totalTipsCents: t.cash + t.card, mustReport: mustReportTips(t.cash + t.card), reportDueBy: onOrAfterBankingDay(nextMonthTenth(month)) };
    })
    .sort((a, b) => a.month.localeCompare(b.month) || a.name.localeCompare(b.name));

  // FICA tip credit, one employee-month at a time, by the month of the check date.
  const runs = store.payRuns.where((r) => r.companyId === companyId && ['approved', 'funding', 'funded', 'disbursing', 'completed'].includes(r.status) && r.checkDate >= from && r.checkDate <= to);
  const perEmployeeMonth = new Map<string, { employeeId: string; month: string; hours: number; nonTipWagesCents: number; tipsCents: number }>();
  for (const run of runs) {
    for (const pc of run.paychecks) {
      const month = run.checkDate.slice(0, 7);
      const k = `${pc.employeeId}|${month}`;
      const cur = perEmployeeMonth.get(k) ?? { employeeId: pc.employeeId, month, hours: 0, nonTipWagesCents: 0, tipsCents: 0 };
      cur.hours += pc.hours;
      cur.tipsCents += sum(pc.earnings.filter((e) => TIP_CODES.has(e.code)).map((e) => e.amountCents));
      cur.nonTipWagesCents += sum(pc.earnings.filter((e) => !TIP_CODES.has(e.code) && e.category !== 'reimbursement').map((e) => e.amountCents));
      perEmployeeMonth.set(k, cur);
    }
  }
  const months = [...new Set([...perEmployeeMonth.values()].map((r) => r.month))].sort();
  const creditByMonth = months.map((month) => {
    const c = ficaTipCredit([...perEmployeeMonth.values()].filter((r) => r.month === month && r.tipsCents > 0));
    return { month, creditableTipsCents: c.creditableTipsCents, creditCents: c.creditCents };
  });
  const totalCredit = ficaTipCredit([...perEmployeeMonth.values()].filter((r) => r.tipsCents > 0));

  const tippingCustomary = company.settings.roles.some((r) => r.tipped === 'customarily');
  return {
    from,
    to,
    tipReporting,
    tipReportingThresholdCents: MONTHLY_TIP_REPORTING_THRESHOLD,
    tipReportingNote: 'Employees report cash, check and card tips of $20 or more a month to the employer by the 10th of the next month (next business day if that is a weekend or holiday). Totals here come from the tips recorded on each person\'s own shifts.',
    ficaTipCredit: { byMonth: creditByMonth, creditCents: creditByMonth.reduce((a, m) => a + m.creditCents, 0), creditableTipsCents: totalCredit.creditableTipsCents, payRuns: runs.length, note: totalCredit.note },
    form8027: {
      tippingCustomary,
      typicalDailyEmployees: company.typicalDailyEmployees ?? null,
      applies: company.typicalDailyEmployees === undefined ? null : form8027Applies(company.typicalDailyEmployees, tippingCustomary),
      note: company.typicalDailyEmployees === undefined ? 'Set typicalDailyEmployees on the company to test whether Form 8027 applies.' : 'Totali flags the headcount test only. It does not prepare or file Form 8027, and it does not test the 95% service-charge exception.',
    },
  };
}

function nextMonthTenth(month: string): string {
  const [y, m] = month.split('-').map(Number);
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return `${ny}-${String(nm).padStart(2, '0')}-10`;
}
