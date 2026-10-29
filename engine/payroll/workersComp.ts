import type { Cents } from '../src/money.ts';

/**
 * Workers' compensation classification and premium calculation — a
 * STATE-regulated coverage (unlike the federal payroll taxes this
 * project otherwise computes), administered through NCCI (the National
 * Council on Compensation Insurance) in most states, with a handful of
 * states running their own independent rating bureau instead (California
 * via the WCIRB, for one). LIVE-SOURCED formula and rules, corroborated
 * across multiple independent industry sources (NCCI's own Basic Manual
 * text itself sits behind a login this session couldn't reach directly —
 * see the note on that below) rather than assumed from trained memory.
 *
 * The standard premium formula: (subject payroll ÷ 100) × classification
 * rate × experience modification factor. Every piece on the right of
 * that formula — the classification code and its rate, and the
 * employer's own experience mod — is a fact only an insurer or a state
 * rating bureau assigns, never something this project derives; the same
 * "caller-supplied, never guessed" discipline `src/types.ts`'s own
 * EmployerContext uses for the tax engine's own per-state SUI rate.
 *
 * SCOPE: this module computes a premium ESTIMATE from figures the
 * caller already has (a class code's own rate, the experience mod, and
 * subject payroll) — it does not maintain the actual NCCI class-code
 * rate table (thousands of codes, state-specific, insurer-specific —
 * a legal/rate-research project of the same size and shape as this
 * project's own minimum-wage database), assign a class code to a job
 * duty, or track an employer's own claims history to compute an
 * experience mod. None of that is guessed here — it's named as a real,
 * separate piece of infrastructure not built, the same "disclosed, not
 * built" choice this project makes for e-filing and carrier EDI
 * elsewhere.
 *
 * DISCLOSED SOURCING CAVEAT: the overtime-premium exclusion rule below
 * (and its Pennsylvania/Delaware exception) is corroborated across
 * several independent workers'-comp-industry secondary sources that
 * agree with each other, not confirmed against NCCI's own Basic Manual
 * text directly (it sits behind a login this session could not reach) —
 * the same category of caveat this project's own payroll/aca.ts header
 * carries for its two Federal Poverty Line figures. Re-verify against
 * NCCI's own Basic Manual, Rule 2, before relying on this for a real
 * premium calculation or audit.
 */

export interface WorkersCompClassCode {
  code: string;
  description: string;
  /** The rate an insurer/rating bureau charges per $100 of subject payroll for this classification. */
  ratePerHundredOfPayroll: Cents;
}

/**
 * States confirmed (via the sourcing above) to NOT allow the overtime
 * premium portion to be excluded from subject payroll — every other
 * state follows the standard NCCI exclusion rule.
 */
export const STATES_NOT_EXCLUDING_OVERTIME_PREMIUM: ReadonlySet<string> = new Set(['PA', 'DE']);

/**
 * The standard NCCI rule: only the "premium" PORTION of overtime pay is
 * excluded from subject payroll — the extra half (or full extra amount,
 * for double time) paid ABOVE the straight-time-equivalent rate, not the
 * entire overtime payment. The straight-time-equivalent portion of
 * overtime hours still counts as subject payroll same as regular hours.
 * `overtimePremiumPortion` is caller-supplied (computed already by
 * `payroll/timeAndAttendance.ts` and `payroll/engine.ts` for the pay
 * period itself) rather than re-derived here, since this module has no
 * independent view of hours/rates split by regular vs. overtime vs.
 * double time.
 */
export function workersCompSubjectWages(grossWages: Cents, overtimePremiumPortion: Cents, workStateCode: string): Cents {
  if (STATES_NOT_EXCLUDING_OVERTIME_PREMIUM.has(workStateCode)) return grossWages;
  return grossWages - overtimePremiumPortion;
}

/** (subject payroll ÷ 100) × classification rate × experience modification factor — the standard formula, applied to whatever subject-payroll figure the caller supplies (see workersCompSubjectWages() for getting that figure right). */
export function workersCompPremium(subjectWages: Cents, ratePerHundredOfPayroll: Cents, experienceModificationFactor: number): Cents {
  return Math.round((subjectWages / 10_000) * ratePerHundredOfPayroll * experienceModificationFactor);
}
