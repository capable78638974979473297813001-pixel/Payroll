import type { PaycheckInput } from './types.ts';

/**
 * Inputs that are present but in a place, or a combination, the engine can't
 * use. Each one silently changes a tax if left alone, so it is reported in
 * result.warnings instead. None of these stops the calculation.
 */

/** Local-tax fields the engine reads from workState.certificate only. */
const LOCAL_FIELDS = [
  'workPSD',
  'residencePSD',
  'lstPSD',
  'schoolDistrictCode',
  'workJEDDId',
  'workCity',
  'residenceCity',
  'workCounty',
  'residenceCounty',
  'county',
  'workSchoolDistrict',
  'residenceSchoolDistrict',
  'locality',
  'localities',
] as const;

export function inputContractWarnings(input: PaycheckInput): string[] {
  const warnings: string[] = [];
  const work = (input.workState?.certificate ?? {}) as Record<string, unknown>;
  const residence = (input.residenceState?.certificate ?? {}) as Record<string, unknown>;

  // Local taxes are read from the WORK state's certificate, including the
  // residence-side fields (residencePSD, residenceCity, schoolDistrictCode).
  const stranded = LOCAL_FIELDS.filter((k) => residence[k] !== undefined && work[k] === undefined);
  if (input.residenceState && stranded.length > 0) {
    warnings.push(
      `residenceState.certificate has ${stranded.join(', ')}, but local taxes read these from workState.certificate only, so ${stranded.length === 1 ? 'it was' : 'they were'} ignored. ` +
        'Put the residence-side local fields (residencePSD, residenceCity, residenceCounty, residenceSchoolDistrict, schoolDistrictCode) on workState.certificate too.',
    );
  }

  // A nonresident flag with no residence state: reciprocity and every
  // residence-state rule need to know where the employee lives.
  if (work.nonresident === true && !input.residenceState) {
    warnings.push(
      `workState.certificate.nonresident is true but input.residenceState is absent, so reciprocity and residence-state rules could not apply. Supply residenceState with the employee's home state.`,
    );
  }

  // A nonresident flag on someone whose home state IS the work state zeroes or
  // cuts the resident tax (DC's nonresident flag takes DC tax to $0).
  if (work.nonresident === true && input.residenceState && input.workState && input.residenceState.code === input.workState.code) {
    warnings.push(
      `workState.certificate.nonresident is true, but residenceState is the same state (${input.workState.code}). A resident marked nonresident is under-withheld (in DC, to $0). Check which is right.`,
    );
  }

  return warnings;
}
