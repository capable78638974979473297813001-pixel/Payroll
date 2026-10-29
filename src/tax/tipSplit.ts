import { quarterOf } from '../lib/dates.ts';
import { sum } from '../lib/money.ts';
import type { Paycheck, PayRun } from '../domain/types.ts';

/**
 * Form 941 and W-2 treat reported tips separately from wages: 941 line 5a is
 * Social Security wages and line 5b is Social Security tips (same 12.4% rate),
 * and W-2 box 7 is Social Security tips. MasteryTax reports them together
 * inside wages, so the total tax is right but the split is not. This computes
 * the split from the approved pay runs.
 *
 * The Social Security wage base is used up by wages first and tips last, so
 * when the base binds it truncates the tips. An employee's tips that count are
 *
 *     clamp(socialSecurityWages - nonTipWages, 0, tips)
 *
 * where non-tip wages are reduced first by any pre-tax deductions that lower
 * Social Security wages (cafeteria plan, HSA, FSA, dependent care, commuter;
 * 401(k)-type deferrals do not).
 *
 * Box 8 (allocated tips) is only for employers that file Form 8027 and
 * allocate under its rules. Totali does not allocate, so it reports 0.
 */

const TIP_CODES = new Set(['TIPS_CHARGED', 'TIPS_TIPOUT', 'TIPS_POOL', 'TIPS_CASH']);
const REDUCES_SS = new Set(['section125', 'hsa', 'fsa', 'dependent_care', 'commuter']);
const SS_RATE_BPS = 1240;

export function socialSecurityTips(pc: Paycheck): { ssWagesCents: number; ssTipsCents: number } {
  const ssTaxable = pc.taxLines.find((t) => t.id === 'US_SS_EE')?.taxableWages ?? 0;
  const tips = sum(pc.earnings.filter((e) => TIP_CODES.has(e.code)).map((e) => e.amountCents));
  const nonTip = pc.taxableWagesCents - tips;
  const pretaxReduction = sum(pc.deductionLines.filter((d) => d.category && REDUCES_SS.has(d.category)).map((d) => d.amountCents));
  const nonTipSs = Math.max(0, nonTip - pretaxReduction);
  const ssTips = Math.min(tips, Math.max(0, ssTaxable - nonTipSs));
  return { ssWagesCents: ssTaxable - ssTips, ssTipsCents: ssTips };
}

export function tipSplit(runs: readonly PayRun[], opts: { year: number; quarter?: 1 | 2 | 3 | 4 }) {
  const inYear = runs.filter((r) => r.checkDate.startsWith(String(opts.year)));
  const inQuarter = opts.quarter ? inYear.filter((r) => quarterOf(r.checkDate).quarter === opts.quarter) : [];
  const roll = (rs: readonly PayRun[]) => {
    let wages = 0;
    let tips = 0;
    for (const r of rs) for (const pc of r.paychecks) {
      const s = socialSecurityTips(pc);
      wages += s.ssWagesCents;
      tips += s.ssTipsCents;
    }
    return { line5a1_socialSecurityWagesCents: wages, line5a2_taxCents: Math.round((wages * SS_RATE_BPS) / 10_000), line5b1_socialSecurityTipsCents: tips, line5b2_taxCents: Math.round((tips * SS_RATE_BPS) / 10_000) };
  };

  const perEmployee = new Map<string, { name: string; box7: number; uncollected: number }>();
  for (const r of inYear) for (const pc of r.paychecks) {
    const cur = perEmployee.get(pc.employeeId) ?? { name: pc.name, box7: 0, uncollected: 0 };
    cur.box7 += socialSecurityTips(pc).ssTipsCents;
    cur.uncollected += pc.uncollectedCents;
    perEmployee.set(pc.employeeId, cur);
  }
  return {
    year: opts.year,
    ...(opts.quarter ? { quarter: opts.quarter, form941: roll(inQuarter) } : {}),
    w2: [...perEmployee.entries()].map(([employeeId, v]) => ({ employeeId, name: v.name, box7_socialSecurityTipsCents: v.box7, box8_allocatedTipsCents: 0, uncollectedTaxOnTipsCents: v.uncollected })),
    notes: [
      'MasteryTax puts tips inside wages on 941 line 5a; use these figures for the 5a/5b split. Total Social Security tax is the same either way.',
      'Box 8 (allocated tips) is 0: Totali does not allocate tips under Form 8027.',
      'Uncollected tax on tips is reported on the W-2 in box 12 (codes A for Social Security and B for Medicare). Totali records the combined amount; splitting it between the two taxes needs the order the employer collected them in.',
    ],
  };
}
