import type { Cents } from '../src/money.ts';
import { dollars } from '../src/money.ts';
import type { TerminationReason } from './termination.ts';

/**
 * COBRA continuation coverage (Consolidated Omnibus Budget
 * Reconciliation Act of 1985, 29 U.S.C. § 1161 et seq.) — the federal
 * requirement that a group health plan let someone who loses coverage
 * from a qualifying event keep it, at their own (marked-up) cost, for a
 * fixed continuation period. LIVE-VERIFIED against the U.S. Department
 * of Labor's own "An Employer's Guide to Group Health Continuation
 * Coverage Under COBRA" and its FAQ for workers, not assumed from
 * trained memory.
 *
 * SCOPE: this module answers the questions a real termination workflow
 * actually needs — does COBRA even apply here, how long is the
 * continuation period, when is the election notice/election/first
 * premium each due, and what's the maximum premium — as pure functions
 * over dates and a qualifying-event reason. It also answers the separate
 * GENERAL NOTICE question (due at first coverage, before any qualifying
 * event) and the civil/excise penalty exposure for a late notice under
 * either one — see the dedicated section near the bottom of this file.
 * It does NOT generate either notice document itself (a real, separate
 * compliance document with its own required content, the same
 * "disclosed, not built" boundary this project draws around e-filing and
 * carrier EDI elsewhere) and does not track a beneficiary's actual
 * election or premium payment history — those are a genuinely separate
 * persistence concern from the dates and dollar figures this module
 * computes.
 *
 * SMALL-EMPLOYER EXEMPTION: COBRA itself only binds an employer with 20
 * or more employees on a typical business day in the PRECEDING calendar
 * year (a "full-time equivalent" count, not distinct headcount — a
 * detail this module doesn't attempt, since this project already has a
 * more rigorous FTE calculation for a different purpose, ACA's own
 * Applicable Large Employer test in payroll/aca.ts; wiring COBRA's own
 * count to that one would conflate two different statutes' own
 * definitions of "employee count" without a source confirming they're
 * measured identically). isCobraApplicable() takes a plain headcount the
 * caller supplies, not a derived FTE figure.
 */

/** DOL: an employer with a headcount at or above this figure, on a typical business day in the prior calendar year, is subject to COBRA. Below it, exempt entirely. */
export const COBRA_SMALL_EMPLOYER_THRESHOLD = 20;

export function isCobraApplicable(typicalEmployeeCountPriorYear: number): boolean {
  return typicalEmployeeCountPriorYear >= COBRA_SMALL_EMPLOYER_THRESHOLD;
}

/**
 * The two continuation-period lengths COBRA sets, keyed by WHY coverage
 * would otherwise end. 'gross_misconduct' is deliberately excluded here,
 * not mapped to either duration — DOL's own guidance is that termination
 * for gross misconduct is NOT a qualifying event at all, so no COBRA
 * right arises; see qualifyingEventDurationMonths()'s own doc comment
 * for how that's surfaced rather than silently defaulted to a duration.
 */
export type CobraQualifyingEventReason =
  | 'termination'
  | 'reduced_hours'
  | 'divorce_or_legal_separation'
  | 'employee_medicare_entitlement'
  | 'dependent_aging_out'
  | 'employee_death';

const EIGHTEEN_MONTH_REASONS: readonly CobraQualifyingEventReason[] = ['termination', 'reduced_hours'];

/** 18 months for termination/reduced-hours events, 36 months for every other qualifying event DOL recognizes (divorce/separation, the employee's own Medicare entitlement, a dependent aging out, or the employee's death). */
export function qualifyingEventDurationMonths(reason: CobraQualifyingEventReason): 18 | 36 {
  return EIGHTEEN_MONTH_REASONS.includes(reason) ? 18 : 36;
}

/** Maps this project's own TerminationReason to whether an ordinary employment termination is a COBRA qualifying event at all — every reason IS one except 'gross_misconduct', which DOL's own guidance excludes entirely (no COBRA right arises, not even at $0 continuation). */
export function isQualifyingTermination(reason: TerminationReason): boolean {
  return reason !== 'gross_misconduct';
}

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function addMonths(iso: string, months: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1 + months, d));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

/** DOL: the plan has 44 days after the qualifying event (the combined 30-day employer-to-plan-administrator plus 14-day plan-administrator-to-beneficiary notice deadlines this project doesn't model as two separate steps, since it has no plan-administrator role distinct from the employer) to provide the election notice. */
export const ELECTION_NOTICE_DEADLINE_DAYS = 44;

export function electionNoticeDeadline(qualifyingEventDate: string): string {
  return addDays(qualifyingEventDate, ELECTION_NOTICE_DEADLINE_DAYS);
}

/** DOL: 60 days from the LATER of the coverage-loss date or the date the election notice was actually provided. */
export const ELECTION_PERIOD_DAYS = 60;

export function electionDeadline(coverageLossDate: string, noticeProvidedDate: string): string {
  const later = coverageLossDate > noticeProvidedDate ? coverageLossDate : noticeProvidedDate;
  return addDays(later, ELECTION_PERIOD_DAYS);
}

/** DOL: 45 days from the date COBRA was elected to make the first premium payment. */
export const INITIAL_PREMIUM_DEADLINE_DAYS = 45;

export function initialPremiumDeadline(electionDate: string): string {
  return addDays(electionDate, INITIAL_PREMIUM_DEADLINE_DAYS);
}

/** DOL: the maximum a plan may charge is 102% of the plan's own full cost of coverage (employee + employer share), the extra 2% being the allowed administrative load. */
export const PREMIUM_CAP_FRACTION = 1.02;

export function maximumMonthlyPremium(fullMonthlyCostOfCoverage: Cents): Cents {
  return Math.round(fullMonthlyCostOfCoverage * PREMIUM_CAP_FRACTION);
}

/** The last day continuation coverage may run, given when the qualifying event happened and which duration applies. */
export function continuationCoverageEndDate(qualifyingEventDate: string, reason: CobraQualifyingEventReason): string {
  return addMonths(qualifyingEventDate, qualifyingEventDurationMonths(reason));
}

/**
 * THE GENERAL NOTICE (distinct from everything above, which concerns the
 * ELECTION notice given at a QUALIFYING EVENT): the plan must tell a
 * newly-covered employee and spouse about their COBRA rights up front,
 * before any qualifying event has even happened — a separate DOL
 * requirement (29 C.F.R. § 2590.606-1) this module didn't previously
 * model. LIVE-VERIFIED against DOL's own final COBRA notice
 * regulations, corroborated across multiple independent benefits-
 * compliance sources for the exact figures, fetched 2026-09-14.
 */

/** DOL: the general notice is due within this many days of first becoming covered under the plan — UNLESS the election notice would already be due sooner (a new hire who has a qualifying event almost immediately doesn't get the full 90 days to receive general-notice information that's now moot). */
export const GENERAL_NOTICE_DEADLINE_DAYS = 90;

export function generalNoticeDeadline(firstCoverageDate: string): string {
  return addDays(firstCoverageDate, GENERAL_NOTICE_DEADLINE_DAYS);
}

/**
 * DOL's own rule is "the EARLIER of" the 90-day general-notice deadline
 * or the date an election notice is itself already required — so a
 * qualifying event happening almost immediately after coverage begins
 * pulls this deadline in, rather than leaving the full 90 days on the
 * clock for information that would already be moot.
 */
export function generalNoticeDeadlineGivenPossibleElectionNotice(firstCoverageDate: string, electionNoticeDeadlineIfApplicable: string | null): string {
  const standardDeadline = generalNoticeDeadline(firstCoverageDate);
  if (electionNoticeDeadlineIfApplicable === null) return standardDeadline;
  return electionNoticeDeadlineIfApplicable < standardDeadline ? electionNoticeDeadlineIfApplicable : standardDeadline;
}

/** ERISA § 502(c)(1): the maximum a COURT may assess, per day, per affected qualified beneficiary, for a COBRA notice failure — a fixed statutory maximum NOT subject to the annual inflation adjustment DOL applies to its own administratively-assessed penalties elsewhere, confirmed unchanged for 2026. */
export const ERISA_NOTICE_PENALTY_PER_DAY: Cents = dollars(110);

/** IRC § 4980B: the excise tax for a COBRA continuation-coverage failure — per affected qualified beneficiary per day, UNLESS more than one family member is affected, in which case the higher per-day figure applies instead (not additively on top of the per-beneficiary figure). */
export const EXCISE_TAX_PER_DAY_SINGLE_BENEFICIARY: Cents = dollars(100);
export const EXCISE_TAX_PER_DAY_MULTIPLE_BENEFICIARIES: Cents = dollars(200);

/** Total ERISA §502(c)(1) exposure — the per-day maximum times the number of days late, times the number of affected qualified beneficiaries (each beneficiary's own notice failure is counted separately, unlike the IRS excise tax's per-family-unit structure below). */
export function erisaNoticePenaltyExposure(daysLate: number, affectedBeneficiaryCount: number): Cents {
  return ERISA_NOTICE_PENALTY_PER_DAY * Math.max(0, daysLate) * Math.max(0, affectedBeneficiaryCount);
}

/** Total IRC §4980B excise tax exposure — the per-day rate (the higher, family-wide rate if more than one family member was affected, not the per-beneficiary rate multiplied out) times the number of days the failure continued. */
export function exciseTaxExposure(daysLate: number, moreThanOneFamilyMemberAffected: boolean): Cents {
  const perDayRate = moreThanOneFamilyMemberAffected ? EXCISE_TAX_PER_DAY_MULTIPLE_BENEFICIARIES : EXCISE_TAX_PER_DAY_SINGLE_BENEFICIARY;
  return perDayRate * Math.max(0, daysLate);
}
