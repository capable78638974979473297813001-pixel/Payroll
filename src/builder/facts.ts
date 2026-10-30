import { hasStateRuleset, miCityRuleset, ohMunicipalityRuleset, kyJurisdictionRuleset, stateRuleset } from '../../engine/src/registry.ts';

/**
 * What the builder knows about a state, from the tax engine's own data where the engine has it (does the state tax
 * wages, which cities tax them) and from a short reference list where it does not (state sick-leave laws, state
 * withholding forms Totali collects).
 */

/**
 * States with a statewide paid or earned sick leave law, as I understand them. This is a reference prompt only:
 * Totali does not compute or enforce sick leave, and the card says to check the state's current rules.
 * Not checked against a primary source.
 */
const SICK_LEAVE_STATES = new Set(['AK', 'AZ', 'CA', 'CO', 'CT', 'DC', 'DE', 'IL', 'MA', 'MD', 'ME', 'MI', 'MN', 'NE', 'NJ', 'NM', 'NV', 'NY', 'OR', 'RI', 'VT', 'WA']);

/** State withholding certificates Totali collects from a new hire, because the engine reads their answers. */
export const STATE_FORMS: Record<string, { id: string; label: string }> = {
  MI: { id: 'mi_w4', label: 'MI-W4' },
};

export interface StateFacts {
  code: string;
  name: string;
  /** Whether the state withholds income tax from wages. */
  incomeTax: boolean;
  form: { id: string; label: string } | null;
  sickLeaveLaw: boolean;
  /** The engine has a ruleset for this tax year, so payroll can run there. */
  supported: boolean;
}

export function stateFacts(code: string, date: string): StateFacts {
  const upper = code.toUpperCase();
  const supported = hasStateRuleset(upper, date);
  const rs = supported ? stateRuleset(upper, date) : undefined;
  return {
    code: upper,
    name: rs?.name ?? upper,
    incomeTax: rs ? rs.method !== 'no_income_tax' : false,
    form: STATE_FORMS[upper] ?? null,
    sickLeaveLaw: SICK_LEAVE_STATES.has(upper),
    supported,
  };
}

export interface LocalTax {
  city: string;
  /** Resident and nonresident rates as decimals, where the engine's table has them. */
  residentRate?: number;
  nonresidentRate?: number;
}

/**
 * Does this city tax wages? Answered from the engine's closed lists for Michigan, Ohio and Kentucky, where an
 * unlisted city owes nothing. Other states with local taxes (Pennsylvania, Alabama, Indiana and Maryland counties)
 * are not looked up here: they need an address, not a city name.
 */
export function localTax(state: string, city: string, date: string): LocalTax | null {
  const name = city.trim();
  if (!name) return null;
  const s = state.toUpperCase();
  try {
    if (s === 'MI') {
      const c = miCityRuleset(name, date);
      return c ? { city: c.name, residentRate: c.residentRate, nonresidentRate: c.nonresidentRate } : null;
    }
    if (s === 'OH') {
      const c = ohMunicipalityRuleset(name, date) as { name: string; rate?: number } | undefined;
      return c ? { city: c.name, ...(typeof c.rate === 'number' ? { residentRate: c.rate, nonresidentRate: c.rate } : {}) } : null;
    }
    if (s === 'KY') {
      const c = kyJurisdictionRuleset(name, date) as { name: string; wageRateResidentDecimal?: number | null; wageRateNonresidentDecimal?: number | null } | undefined;
      return c ? { city: c.name, ...(typeof c.wageRateResidentDecimal === 'number' ? { residentRate: c.wageRateResidentDecimal } : {}), ...(typeof c.wageRateNonresidentDecimal === 'number' ? { nonresidentRate: c.wageRateNonresidentDecimal } : {}) } : null;
    }
  } catch {
    return null;
  }
  return null;
}

export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'x';
