/**
 * The federal Pregnant Workers Fairness Act (PWFA, 42 U.S.C. § 2000gg et
 * seq., effective June 27, 2023; EEOC final regulations at 29 C.F.R.
 * Part 1636, effective June 18, 2024) — LIVE-VERIFIED against the
 * EEOC's own materials, not assumed from trained memory:
 *  - https://www.eeoc.gov/pregnant-workers-fairness-act
 *  - https://www.eeoc.gov/wysk/what-you-should-know-about-pregnant-workers-fairness-act
 * (both fetched 2026-09-13), plus the regulation's own "predictable
 * assessments" concept (29 C.F.R. § 1636.3(k)), corroborated across
 * multiple independent legal-employer sources quoting its exact language.
 *
 * SCOPE: employer/effective-date coverage, and the one piece of this
 * regulation reducible to a clean rule — the four "predictable
 * assessment" accommodations the EEOC says will, in virtually all cases,
 * be reasonable and not an undue hardship, for which self-confirmation
 * by the employee is enough (no medical documentation, no individualized
 * case-by-case analysis needed). EVERY OTHER accommodation still goes
 * through PWFA's general "reasonable accommodation unless undue
 * hardship" standard — borrowed from the ADA — which is a fact-specific
 * judgment weighing cost, resources, and operational impact, not a
 * formula, the same kind of scope boundary payroll/warnAct.ts's own
 * exception-guidance functions and payroll/pumpAct.ts's own small-
 * employer exemption already draw around a legal judgment with no
 * closed-form answer.
 */

export const PWFA_EMPLOYER_THRESHOLD = 15;

export const PWFA_EFFECTIVE_DATE = '2023-06-27';

export type PwfaPredictableAssessmentAccommodation =
  | 'water_access'
  | 'additional_restroom_breaks'
  | 'sit_or_stand_as_needed'
  | 'additional_eating_drinking_breaks';

const PREDICTABLE_ASSESSMENT_ACCOMMODATIONS = new Set<PwfaPredictableAssessmentAccommodation>([
  'water_access',
  'additional_restroom_breaks',
  'sit_or_stand_as_needed',
  'additional_eating_drinking_breaks',
]);

export function isPwfaCoveredEmployer(employeeCount: number): boolean {
  return employeeCount >= PWFA_EMPLOYER_THRESHOLD;
}

export function isPwfaInEffect(requestDate: string): boolean {
  return requestDate >= PWFA_EFFECTIVE_DATE;
}

/** 29 C.F.R. § 1636.3(k): true for exactly the four accommodations the EEOC identifies as a "predictable assessment" — always reasonable in virtually every case, without an individualized undue-hardship analysis. */
export function isPredictableAssessmentAccommodation(accommodation: string): accommodation is PwfaPredictableAssessmentAccommodation {
  return PREDICTABLE_ASSESSMENT_ACCOMMODATIONS.has(accommodation as PwfaPredictableAssessmentAccommodation);
}

/** EEOC: for a predictable-assessment accommodation, the employee's own self-confirmation is enough — no medical documentation may be required. Every other accommodation may be documented if reasonable under the circumstances (a fact-specific call this module doesn't make). */
export function requiresMedicalDocumentation(accommodation: string): boolean {
  return !isPredictableAssessmentAccommodation(accommodation);
}
