import type { EmploymentCategory } from './types.ts';

/**
 * Shared input-validation helpers for optional caller-supplied fields that
 * flow in as loosely-typed data (a state's own `certificate: Record<string,
 * unknown>`, or a top-level field that TypeScript types but a JSON API
 * caller can still send anything for — this engine is served over HTTP by
 * supabase/functions/calculate-paycheck, where no compiler stands between
 * the wire and this code).
 */

/**
 * Read a field that must be a real boolean or absent — never a string,
 * number, or anything else that merely LOOKS like one. A caller-supplied
 * STRING "false" is truthy under a bare `if` check, which is exactly
 * backwards, and `Boolean("false")` doesn't help either (also true) — the
 * specific anti-pattern this function replaces everywhere it's used.
 * Absent/null defaults to false, the same "missing input changes nothing"
 * convention every optional field in this engine already follows.
 *
 * Originally two near-identical functions scoped to one field each
 * (certificate.exempt, certificate.nonresident) inside src/taxes/state.ts;
 * generalized here, in a file both state.ts and federal.ts can import
 * without a circular dependency (state.ts already imports federalIncomeTax
 * from federal.ts), once the same gap turned up in federal.ts's own
 * w4.exempt check — the highest-stakes instance of this bug class, since it
 * silently zeroes FEDERAL income tax on every paycheck it misreads, not
 * just one state's.
 */
export function resolveCertBoolean(cert: Record<string, unknown>, field: string): boolean {
  const raw = cert[field];
  if (raw === undefined || raw === null) return false;
  if (raw === true || raw === false) return raw;
  throw new Error(
    `Unrecognized certificate.${field} ${JSON.stringify(raw)} — expected a real boolean (true/false), not a ` +
      `string or other value that merely LOOKS like one.`,
  );
}

/** Every value of PaycheckInput.employmentCategory. */
export const EMPLOYMENT_CATEGORIES: readonly EmploymentCategory[] = [
  'standard',
  'clergy',
  'statutory_employee',
  'household',
  'agricultural',
  'railroad',
  'election_worker',
];

/**
 * employmentCategory selects whole sets of federal and state rules, and the
 * last branch of the federal category logic is the clergy exemption, which
 * zeroes every federal line. A misspelled value must therefore stop the
 * calculation, never fall into a branch by default.
 */
export function assertEmploymentCategory(value: unknown): void {
  if (value === undefined || value === null) return;
  if (!EMPLOYMENT_CATEGORIES.includes(value as EmploymentCategory)) {
    throw new Error(
      `Unrecognized employmentCategory ${JSON.stringify(value)} — expected one of ${EMPLOYMENT_CATEGORIES.join(', ')}, or omit it for 'standard'.`,
    );
  }
}

/** True for a yyyy-mm-dd string that names a real calendar day (not 2026-02-30 or 2026-99-99). */
export function isRealIsoDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  // Date.UTC maps years 0-99 to 1900-1999, so compare the year via setUTCFullYear too.
  date.setUTCFullYear(y);
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}
