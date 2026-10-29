import type { Cents } from '../src/money.ts';
import { dollars } from '../src/money.ts';

/**
 * Federal FLSA "white collar" overtime exemption salary/compensation
 * thresholds (29 C.F.R. Part 541) — LIVE-VERIFIED against the
 * Department of Labor's own current pages, not assumed from trained
 * memory:
 *  - https://www.dol.gov/agencies/whd/overtime/salary-levels
 *  - the $27.63/hour computer-employee alternative (DOL Fact Sheet #17E)
 * (fetched 2026-09-13).
 *
 * LITIGATION NOTE: the Department's 2024 rule, which would have raised
 * these thresholds substantially (and added automatic future updates),
 * was VACATED nationwide by a federal court in November 2024 (State of
 * Texas v. Dep't of Labor, E.D. Tex.). DOL's own current published
 * figures — the ones this module uses — are the pre-2024-rule ("2019
 * rule") levels: $684/week and $107,432/year. If that litigation
 * resolves differently in the future, or DOL issues a new rule, these
 * constants would need updating — the same "current published figure,
 * not a permanent one" caveat this project's other annually-adjusted
 * dollar constants (payroll/aca.ts, payroll/retirementLimits.ts) already
 * carry, but sharper here because this figure is unsettled by ongoing
 * litigation rather than a routine annual COLA.
 *
 * SCOPE: this module checks ONLY the SALARY/COMPENSATION LEVEL prong of
 * each exemption test. Every §541 exemption also requires a "duties
 * test" (the employee's actual primary job duties, e.g. genuinely
 * managing a department and directing two or more employees for the
 * executive exemption) and, separately, a "salary basis" test (the pay
 * must be a predetermined amount not subject to reduction for the
 * quality or quantity of work, with only a short list of permitted
 * deductions) — both are fact-specific legal judgments about what an
 * employee actually does and how they're actually paid, not reducible to
 * a formula, so this module doesn't attempt either one. A "meets the
 * salary level" result here is necessary, never sufficient, for actual
 * exempt status.
 */

export type FlsaExemptionCategory = 'executive' | 'administrative' | 'professional' | 'computer' | 'highly_compensated' | 'outside_sales';

/** DOL: the standard weekly salary level for the executive, administrative, and professional exemptions (and the floor the highly-compensated-employee test also requires). */
export const FLSA_STANDARD_SALARY_LEVEL_WEEKLY: Cents = dollars(684);

/** The standard weekly level annualized (684 × 52) — DOL's own published annual-equivalent figure. */
export const FLSA_STANDARD_SALARY_LEVEL_ANNUAL: Cents = dollars(35_568);

/** DOL Fact Sheet #17E: the computer-employee exemption's alternative hourly rate, usable instead of the standard weekly salary level. */
export const FLSA_COMPUTER_EMPLOYEE_HOURLY_RATE: Cents = dollars(27.63);

/** DOL: total annual compensation required for the highly-compensated-employee test, in addition to (not instead of) the standard weekly salary level. */
export const FLSA_HCE_ANNUAL_COMPENSATION_THRESHOLD: Cents = dollars(107_432);

/** The outside-sales exemption is the one §541 category with NO salary or compensation floor at all — it's decided entirely on duties (primarily making sales away from the employer's place of business), which this module doesn't evaluate. */
export function requiresSalaryLevelTest(category: FlsaExemptionCategory): boolean {
  return category !== 'outside_sales';
}

export function meetsStandardSalaryLevelTest(weeklySalaryCents: Cents): boolean {
  return weeklySalaryCents >= FLSA_STANDARD_SALARY_LEVEL_WEEKLY;
}

/** The computer employee exemption alone offers a choice: the standard weekly salary, OR an hourly rate at or above $27.63 — either satisfies this prong. */
export function meetsComputerEmployeeSalaryLevelTest(weeklySalaryCents: Cents | null, hourlyRateCents: Cents | null): boolean {
  if (weeklySalaryCents !== null && meetsStandardSalaryLevelTest(weeklySalaryCents)) return true;
  return hourlyRateCents !== null && hourlyRateCents >= FLSA_COMPUTER_EMPLOYEE_HOURLY_RATE;
}

/** The highly-compensated-employee test needs BOTH the standard weekly salary level AND total annual compensation at or above the HCE threshold — meeting only one is not enough. */
export function meetsHighlyCompensatedEmployeeTest(weeklySalaryCents: Cents, totalAnnualCompensationCents: Cents): boolean {
  return meetsStandardSalaryLevelTest(weeklySalaryCents) && totalAnnualCompensationCents >= FLSA_HCE_ANNUAL_COMPENSATION_THRESHOLD;
}

/**
 * Dispatches to the correct salary/compensation test for a given
 * exemption category — always true for 'outside_sales' (no floor at
 * all), the standard weekly test for 'executive'/'administrative'/
 * 'professional', the salary-or-hourly choice for 'computer', and the
 * two-part test for 'highly_compensated'. Still only the salary-level
 * prong — see this module's own header for what it deliberately leaves
 * out (duties test, salary basis/permitted-deductions test).
 */
export function meetsSalaryLevelRequirement(
  category: FlsaExemptionCategory,
  weeklySalaryCents: Cents | null,
  hourlyRateCents: Cents | null,
  totalAnnualCompensationCents: Cents | null,
): boolean {
  switch (category) {
    case 'outside_sales':
      return true;
    case 'computer':
      return meetsComputerEmployeeSalaryLevelTest(weeklySalaryCents, hourlyRateCents);
    case 'highly_compensated':
      return weeklySalaryCents !== null && totalAnnualCompensationCents !== null && meetsHighlyCompensatedEmployeeTest(weeklySalaryCents, totalAnnualCompensationCents);
    default:
      return weeklySalaryCents !== null && meetsStandardSalaryLevelTest(weeklySalaryCents);
  }
}
