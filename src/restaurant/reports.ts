import { badRequest } from '../lib/errors.ts';
import { sum } from '../lib/money.ts';
import type { Store } from '../store/store.ts';
import { ficaTipCredit, form8027Applies, mustReportCashTips, MONTHLY_CASH_TIP_REPORTING_THRESHOLD } from './tipReporting.ts';

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

  const byMonth = new Map<string, number>();
  for (const s of store.shifts.where((x) => x.companyId === companyId && x.workDate >= from && x.workDate <= to && x.cashTipsCents > 0)) {
    const k = `${s.employeeId}|${s.workDate.slice(0, 7)}`;
    byMonth.set(k, (byMonth.get(k) ?? 0) + s.cashTipsCents);
  }
  const cashTipReporting = [...byMonth.entries()]
    .map(([k, cashTipsCents]) => {
      const [employeeId, month] = k.split('|');
      return { employeeId, name: names.get(employeeId) ?? employeeId, month, cashTipsCents, mustReport: mustReportCashTips(cashTipsCents), reportDueBy: nextMonthTenth(month) };
    })
    .sort((a, b) => a.month.localeCompare(b.month) || a.name.localeCompare(b.name));

  const runs = store.payRuns.where((r) => r.companyId === companyId && ['approved', 'funding', 'funded', 'disbursing', 'completed'].includes(r.status) && r.checkDate >= from && r.checkDate <= to);
  const perEmployee = new Map<string, { hours: number; nonTipWagesCents: number; tipsCents: number }>();
  for (const run of runs) {
    for (const pc of run.paychecks) {
      const cur = perEmployee.get(pc.employeeId) ?? { hours: 0, nonTipWagesCents: 0, tipsCents: 0 };
      cur.hours += pc.hours;
      cur.tipsCents += sum(pc.earnings.filter((e) => TIP_CODES.has(e.code)).map((e) => e.amountCents));
      cur.nonTipWagesCents += sum(pc.earnings.filter((e) => !TIP_CODES.has(e.code) && e.category !== 'reimbursement').map((e) => e.amountCents));
      perEmployee.set(pc.employeeId, cur);
    }
  }
  const credit = ficaTipCredit([...perEmployee.entries()].filter(([, v]) => v.tipsCents > 0).map(([employeeId, v]) => ({ employeeId, ...v })));

  const tippingCustomary = company.settings.roles.some((r) => r.tipped === 'customarily');
  return {
    from,
    to,
    cashTipReporting,
    cashTipReportingThresholdCents: MONTHLY_CASH_TIP_REPORTING_THRESHOLD,
    ficaTipCredit: { ...credit, payRuns: runs.length },
    form8027: {
      tippingCustomary,
      typicalDailyEmployees: company.typicalDailyEmployees ?? null,
      applies: company.typicalDailyEmployees === undefined ? null : form8027Applies(company.typicalDailyEmployees, tippingCustomary),
      note: company.typicalDailyEmployees === undefined ? 'Set typicalDailyEmployees on the company to test whether Form 8027 applies.' : 'Totali flags the headcount test only. It does not prepare or file Form 8027.',
    },
  };
}

function nextMonthTenth(month: string): string {
  const [y, m] = month.split('-').map(Number);
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return `${ny}-${String(nm).padStart(2, '0')}-10`;
}
