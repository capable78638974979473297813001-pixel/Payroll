import { randomUUID } from 'node:crypto';
import type { Cents } from '../src/money.ts';
import type { PretaxCategory } from '../src/types.ts';
import { csvField } from './reports.ts';
import type { DeductionPlan, Employee } from './types.ts';

/**
 * Benefits administration: define a plan once, let every employee's own
 * election and coverage tier drive their payroll deduction automatically —
 * the piece isolved's own materials describe as "set up your benefit
 * plans once, driving enrollment and deductions throughout the system."
 *
 * SCOPE: this is plan definition, election, and the arithmetic that turns
 * an election into a payroll deduction. It does NOT speak a carrier's own
 * EDI 834 enrollment-transaction format or do real-time eligibility
 * verification against a carrier's system — those are real, separate
 * integrations a full benefits subsystem needs, not modelled here, the
 * same "disclosed, not built" choice this project makes for e-filing and
 * bank-linking elsewhere (see payroll/directDeposit.ts and
 * payroll/filings.ts's own header comments). `renderCarrierEligibilityRoster()`
 * is the realistic middle ground many actual small-to-mid employers use
 * instead of EDI 834 when their carrier or broker doesn't support it: a
 * plain roster file a human at the carrier keys in or reconciles by hand.
 */

export type CoverageTier = 'employee_only' | 'employee_spouse' | 'employee_children' | 'family';

export interface BenefitPlan {
  id: string;
  companyId: string;
  name: string;
  /** null = a post-tax benefit (e.g. supplemental life insurance the employee pays for with after-tax dollars) — same convention as DeductionPlan.category. */
  category: PretaxCategory | null;
  /**
   * The FULL monthly premium for each tier this plan offers — set directly
   * by the plan/carrier, never derived from a generic multiplier: real
   * benefit plans price employee+spouse, employee+children and family
   * tiers independently, not as a fixed ratio of the employee-only rate.
   */
  monthlyPremiumByTier: Partial<Record<CoverageTier, Cents>>;
  /** What fraction of the tier's own premium the EMPLOYER covers, 0-1. The rest is the employee's own payroll deduction. */
  employerContributionFraction: number;
}

export interface BenefitElection {
  id: string;
  employeeId: string;
  planId: string;
  coverageTier: CoverageTier;
  effectiveDate: string;
  /** Set once a later election supersedes this one, or coverage otherwise ends (termination, dropping the plan). Open-ended (undefined) means currently active. */
  endDate?: string;
}

/** The employee's own MONTHLY cost for the tier they elected — the plan's full premium for that tier, less the employer's contribution. */
export function employeeMonthlyPremium(plan: BenefitPlan, tier: CoverageTier): Cents {
  const fullPremium = plan.monthlyPremiumByTier[tier];
  if (fullPremium === undefined) {
    throw new Error(`Plan ${plan.id} ("${plan.name}") has no premium defined for coverage tier "${tier}"`);
  }
  return Math.round(fullPremium * (1 - plan.employerContributionFraction));
}

/**
 * Converts a MONTHLY employee cost into a PER-PAYCHECK deduction: annualize
 * first (x12), then divide by this schedule's own periods per year — never
 * a shortcut like "divide by 2" for semimonthly, which would only
 * coincidentally match monthly x 12 / 24. This is the same
 * annual-figure-to-period-slice approach a salaried employee's own pay
 * already uses (payroll/engine.ts's baseEarnings()).
 */
export function perPeriodDeductionAmount(monthlyEmployeeCost: Cents, periodsPerYear: number): Cents {
  return Math.round((monthlyEmployeeCost * 12) / periodsPerYear);
}

/** Turns one active election into the DeductionPlan payroll/engine.ts actually reads — the point where "an employee is enrolled in a plan" becomes "a payroll deduction happens every period." */
export function deductionPlanFromElection(plan: BenefitPlan, election: BenefitElection, periodsPerYear: number): DeductionPlan {
  const monthlyEmployeeCost = employeeMonthlyPremium(plan, election.coverageTier);
  return {
    id: `benefit-${election.id}`,
    code: plan.name,
    category: plan.category,
    amount: { kind: 'flat', cents: perPeriodDeductionAmount(monthlyEmployeeCost, periodsPerYear) },
    active: election.endDate === undefined,
  };
}

export interface ApplyElectionResult {
  employee: Employee;
  election: BenefitElection;
  /** Any prior election(s) this one superseded, now with endDate set — the caller persists these too, so a later report of "when was this plan actually active" is accurate. */
  endedElections: BenefitElection[];
}

/**
 * The full "employee elects a benefit" operation, in one place so this
 * logic is unit-tested rather than living inline in a request handler:
 * ends any PRIOR active election for the SAME plan (a tier change, or a
 * genuine re-election) so its deduction never keeps running alongside the
 * new one, creates the new election, and returns the employee with
 * `deductionPlans` updated to match.
 *
 * Electing a DIFFERENT plan — adding dental on top of an existing medical
 * election, say — is deliberately NOT treated as superseding anything.
 * This module has no concept of mutually-exclusive plan CATEGORIES (real
 * benefits administration usually enforces that via a plan "type" —
 * medical/dental/vision/life — so electing a new medical plan replaces
 * the old one but a new dental plan doesn't touch it); modelling that
 * grouping is real, unbuilt scope, not a bug in what's here. Two
 * unrelated plans running concurrently is the correct, intended outcome
 * today.
 */
export function applyElection(
  employee: Employee,
  existingElections: readonly BenefitElection[],
  plan: BenefitPlan,
  coverageTier: CoverageTier,
  effectiveDate: string,
  periodsPerYear: number,
): ApplyElectionResult {
  const endedElections = existingElections
    .filter((e) => e.planId === plan.id && e.endDate === undefined)
    .map((e) => ({ ...e, endDate: effectiveDate }));
  const endedDeductionIds = new Set(endedElections.map((e) => `benefit-${e.id}`));

  const election: BenefitElection = { id: randomUUID(), employeeId: employee.id, planId: plan.id, coverageTier, effectiveDate };
  const newDeduction = deductionPlanFromElection(plan, election, periodsPerYear);

  return {
    employee: {
      ...employee,
      deductionPlans: [...employee.deductionPlans.filter((d) => !endedDeductionIds.has(d.id)), newDeduction],
    },
    election,
    endedElections,
  };
}

/**
 * Whether an employee may CHANGE their election on `requestDate` — outside
 * the employer's own annual open-enrollment window, federal rules (IRC
 * § 125's own cafeteria-plan regulations) restrict a mid-year change to a
 * genuine qualifying life event (marriage, birth/adoption, divorce, loss
 * of other coverage, ...). This function only enforces the WINDOW; it
 * trusts the caller's own `hasQualifyingLifeEvent` assertion the same way
 * the tax engine trusts a caller-supplied eligibility fact rather than
 * verifying it — this is not a place to invent a rule that decides
 * whether a claimed life event is genuine.
 */
export function isElectionChangeAllowed(
  requestDate: string,
  openEnrollmentWindow: { start: string; end: string },
  hasQualifyingLifeEvent: boolean,
): boolean {
  const inWindow = requestDate >= openEnrollmentWindow.start && requestDate <= openEnrollmentWindow.end;
  return inWindow || hasQualifyingLifeEvent;
}

export interface ElectionEligibility {
  allowed: boolean;
  /** Present only when allowed is false — why, in a form fit to surface straight to whoever's requesting the election. */
  reason?: string;
}

/**
 * The gate a real election request actually needs, one level above
 * isElectionChangeAllowed(): a brand-new hire's FIRST-EVER benefit
 * election isn't a "change" IRC § 125 restricts at all — there's no prior
 * election to protect the cafeteria plan's tax treatment from being
 * gamed mid-year — so it's always allowed regardless of window or life
 * event. Only once an employee already holds an election does the
 * window/qualifying-event rule bind. A company with no open-enrollment
 * window configured at all is treated as a real configuration gap, not a
 * silent "anything goes": rather than letting every change through
 * because there's nothing to check it against, this refuses the change
 * and says so, the same "won't build an incomplete answer" choice
 * payroll/newHireReporting.ts's own buildNewHireReport() makes for a
 * report missing required data.
 */
export function canElectBenefit(
  existingElections: readonly BenefitElection[],
  requestDate: string,
  openEnrollmentWindow: { start: string; end: string } | undefined,
  hasQualifyingLifeEvent: boolean,
): ElectionEligibility {
  if (existingElections.length === 0) return { allowed: true };

  if (!openEnrollmentWindow) {
    return {
      allowed: false,
      reason: 'No open enrollment window is configured for this company. A mid-year election change needs either an active open enrollment window or a genuine qualifying life event.',
    };
  }

  if (isElectionChangeAllowed(requestDate, openEnrollmentWindow, hasQualifyingLifeEvent)) {
    return { allowed: true };
  }

  return {
    allowed: false,
    reason: `${requestDate} falls outside the open enrollment window (${openEnrollmentWindow.start} to ${openEnrollmentWindow.end}) and no qualifying life event was asserted.`,
  };
}

/**
 * A plain CSV roster of everyone electing ONE plan — the "who's enrolled
 * in what, since when" file a carrier without EDI 834 support actually
 * asks a small employer to send by hand, one row per election (including
 * a since-ended one, with its own end date) rather than only current
 * enrollment: a carrier reconciling its own records wants to see who
 * DROPPED coverage and when, not just who currently has it. Sorted by
 * employee name, then effective date, so a human skimming the file finds
 * a given person's own history grouped together.
 */
export function renderCarrierEligibilityRoster(
  employees: readonly Employee[],
  plan: BenefitPlan,
  elections: readonly BenefitElection[],
): string {
  const byId = new Map(employees.map((e) => [e.id, e]));
  const header = ['Employee Name', 'Coverage Tier', 'Effective Date', 'End Date', 'Status', 'Employee Monthly Cost', 'Employer Monthly Cost'];

  const rows = elections
    .filter((e) => e.planId === plan.id)
    .map((election) => {
      const employee = byId.get(election.employeeId);
      const name = employee ? `${employee.firstName} ${employee.lastName}` : election.employeeId;
      const employeeCost = employeeMonthlyPremium(plan, election.coverageTier);
      const fullPremium = plan.monthlyPremiumByTier[election.coverageTier];
      const employerCost = fullPremium === undefined ? 0 : fullPremium - employeeCost;
      return {
        sortKey: [name, election.effectiveDate] as const,
        row: [
          name,
          election.coverageTier,
          election.effectiveDate,
          election.endDate ?? '',
          election.endDate ? 'Terminated' : 'Active',
          (employeeCost / 100).toFixed(2),
          (employerCost / 100).toFixed(2),
        ],
      };
    })
    .sort((a, b) => a.sortKey[0].localeCompare(b.sortKey[0]) || a.sortKey[1].localeCompare(b.sortKey[1]))
    .map((entry) => entry.row);

  const lines = [header, ...rows];
  return lines.map((row) => row.map(csvField).join(',')).join('\n') + '\n';
}
