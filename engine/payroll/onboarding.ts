import { randomUUID } from 'node:crypto';
import type { EmploymentCategory, FederalW4, StateWithholding } from '../src/types.ts';
import { freshYearToDate } from './ytd.ts';
import type { Employee } from './types.ts';

/**
 * Recruiting through hire: a job posting attracts candidates, a candidate
 * moves through pipeline stages, an accepted offer becomes exactly the
 * Employee record payroll/run.ts already knows how to pay — the moment a
 * full HCM platform's "recruiting" module hands off to its "payroll"
 * module, made explicit as one function (hireCandidate()) rather than a
 * manual re-entry step.
 *
 * SCOPE: pipeline tracking and the hire handoff. No job board posting
 * integration, background-check/I-9 verification workflow, or offer-letter
 * document generation — those are real, separate systems, the same
 * "disclosed, not built" boundary this project draws around benefits
 * carrier EDI and e-filing elsewhere.
 */

export type CandidateStage =
  | 'applied'
  | 'screening'
  | 'interviewing'
  | 'offer_extended'
  | 'offer_accepted'
  | 'offer_declined'
  | 'hired'
  | 'rejected';

export interface JobPosting {
  id: string;
  companyId: string;
  title: string;
  department?: string;
  openedAt: string;
  closedAt?: string;
}

export interface OfferDetails {
  payType: Employee['payType'];
  startDate: string;
  workState: StateWithholding;
  jobTitle?: string;
  department?: string;
  employmentCategory?: EmploymentCategory;
}

export interface Candidate {
  id: string;
  jobPostingId: string;
  firstName: string;
  lastName: string;
  email: string;
  stage: CandidateStage;
  appliedAt: string;
  /** Set once an offer is extended; the source of truth hireCandidate() reads from — never re-entered by hand at hire time. */
  offer?: OfferDetails;
}

const FORWARD_MOVES: Readonly<Record<CandidateStage, readonly CandidateStage[]>> = {
  applied: ['screening', 'rejected'],
  screening: ['interviewing', 'rejected'],
  interviewing: ['offer_extended', 'rejected'],
  offer_extended: ['offer_accepted', 'offer_declined'],
  offer_accepted: ['hired'],
  offer_declined: [],
  hired: [],
  rejected: [],
};

/** Guards the pipeline against an impossible jump (straight from 'applied' to 'hired', or moving anything out of a terminal stage) — the same "an ambiguous/invalid state transition is an error, not silently accepted" discipline payroll/run.ts's own approvePayRun() applies to a non-draft run. */
function assertValidMove(from: CandidateStage, to: CandidateStage): void {
  if (!FORWARD_MOVES[from].includes(to)) {
    throw new Error(`Cannot move a candidate from "${from}" to "${to}"`);
  }
}

export function advanceCandidate(candidate: Candidate, to: Exclude<CandidateStage, 'offer_extended' | 'hired'>): Candidate {
  assertValidMove(candidate.stage, to);
  return { ...candidate, stage: to };
}

export function extendOffer(candidate: Candidate, offer: OfferDetails): Candidate {
  assertValidMove(candidate.stage, 'offer_extended');
  return { ...candidate, stage: 'offer_extended', offer };
}

export function acceptOffer(candidate: Candidate): Candidate {
  assertValidMove(candidate.stage, 'offer_accepted');
  return { ...candidate, stage: 'offer_accepted' };
}

export function declineOffer(candidate: Candidate): Candidate {
  assertValidMove(candidate.stage, 'offer_declined');
  return { ...candidate, stage: 'offer_declined' };
}

/**
 * Turns an accepted offer into a real Employee record, ready for its
 * first payroll run, and moves the candidate to 'hired'. `federalW4`
 * is required rather than defaulted to something plausible-looking
 * (e.g. 'single', no adjustments): a fabricated W-4 would silently
 * mis-withhold federal income tax from someone's very first paycheck,
 * exactly the class of guessed input the tax engine itself refuses to
 * make up (see src/types.ts's own FederalW4 and the engine's "an absent
 * fact changes nothing, it is never invented" convention throughout).
 */
export function hireCandidate(
  candidate: Candidate,
  companyId: string,
  federalW4: FederalW4,
  residenceState: StateWithholding,
  /** Optional here, but required before payroll/newHireReporting.ts's own buildNewHireReport() can produce the report PRWORA obligates every employer to file within 20 days of this hire — see DirectHireInput's own doc comment on the same two fields. */
  ssn?: string,
  mailingAddress?: string,
): { employee: Employee; candidate: Candidate } {
  if (candidate.stage !== 'offer_accepted') {
    throw new Error(`Cannot hire candidate ${candidate.id}: offer is not accepted (stage is "${candidate.stage}")`);
  }
  const offer = candidate.offer;
  if (!offer) throw new Error(`Cannot hire candidate ${candidate.id}: no offer on file`);

  const employee: Employee = {
    id: candidate.id,
    companyId,
    firstName: candidate.firstName,
    lastName: candidate.lastName,
    hireDate: offer.startDate,
    jobTitle: offer.jobTitle,
    department: offer.department,
    employmentCategory: offer.employmentCategory ?? 'standard',
    payType: offer.payType,
    residenceState,
    workState: offer.workState,
    federalW4,
    ssn,
    mailingAddress,
    deductionPlans: [],
    directDepositAccounts: [],
    garnishmentOrders: [],
    ytd: freshYearToDate(),
    ytdYear: Number(offer.startDate.slice(0, 4)),
  };

  return { employee, candidate: { ...candidate, stage: 'hired' } };
}

/**
 * A real employee record for someone who never went through this
 * project's own recruiting pipeline at all — the case hireCandidate()
 * doesn't cover: onboarding an EXISTING workforce onto the platform for
 * the first time (a new customer switching payroll providers with staff
 * already employed), or a hire an employer tracked entirely outside this
 * system. Builds the identical Employee shape hireCandidate() produces,
 * so payroll/run.ts and everything downstream of it treats a directly
 * added employee no differently from one hired through the pipeline.
 *
 * Requires a real FederalW4, same as hireCandidate() — a fabricated one
 * would silently mis-withhold this person's very first paycheck here,
 * the same class of guessed input the tax engine itself refuses to
 * invent.
 */
export interface DirectHireInput {
  firstName: string;
  lastName: string;
  hireDate: string;
  jobTitle?: string;
  department?: string;
  employmentCategory?: EmploymentCategory;
  payType: Employee['payType'];
  residenceState: StateWithholding;
  workState?: StateWithholding;
  federalW4: FederalW4;
  /** Both optional here, but required before payroll/newHireReporting.ts's own buildNewHireReport() can produce the report PRWORA obligates every employer to file within 20 days of THIS hire — omitting them doesn't skip that obligation, it just leaves it as an outstanding compliance finding until they're filled in. */
  ssn?: string;
  mailingAddress?: string;
}

export function directHire(companyId: string, input: DirectHireInput): Employee {
  return {
    id: randomUUID(),
    companyId,
    firstName: input.firstName,
    lastName: input.lastName,
    hireDate: input.hireDate,
    jobTitle: input.jobTitle,
    department: input.department,
    employmentCategory: input.employmentCategory ?? 'standard',
    payType: input.payType,
    residenceState: input.residenceState,
    workState: input.workState,
    federalW4: input.federalW4,
    ssn: input.ssn,
    mailingAddress: input.mailingAddress,
    deductionPlans: [],
    directDepositAccounts: [],
    garnishmentOrders: [],
    ytd: freshYearToDate(),
    ytdYear: Number(input.hireDate.slice(0, 4)),
  };
}
