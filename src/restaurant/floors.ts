import { minimumWage } from '../../engine/src/minimum-wage.ts';
import type { Cents } from '../lib/money.ts';

/**
 * The binding minimum-wage floors for a place and date, from the engine's own
 * minimum-wage rulesets (federal, state, local, whichever is highest). This
 * does what the engine's `stateTipCredit()` does and adds `region`, which New
 * York and Oregon need: without it the engine uses the statewide baseline,
 * which is lower than the NYC or Portland-area rate.
 */
export interface WageFloors {
  /** Whether the binding jurisdiction lets an employer pay a cash wage below the full minimum and count tips toward it. */
  tipCreditAllowed: boolean;
  /** The lowest cash wage a tipped employee may be paid, per hour. */
  cashFloorCentsPerHour: Cents;
  /** The full minimum wage per hour. */
  standardFloorCentsPerHour: Cents;
  /** The most tip credit per hour the jurisdiction allows. Zero where none is allowed. */
  maxCreditCentsPerHour: Cents;
}

/** States whose engine rulesets carry named regions. For these a missing `region` setting means the statewide baseline is used. */
export const REGIONAL_STATES: readonly string[] = ['NY', 'OR'];

export function wageFloors(date: string, state: string, locality?: string, region?: string): WageFloors {
  const tipped = minimumWage({ checkDate: date, state, locality, region, tipped: true });
  const standard = minimumWage({ checkDate: date, state, locality, region, tipped: false });
  return {
    tipCreditAllowed: tipped.tipCreditAllowed,
    cashFloorCentsPerHour: tipped.cents,
    standardFloorCentsPerHour: standard.cents,
    maxCreditCentsPerHour: tipped.tipCreditAllowed ? Math.max(0, standard.cents - tipped.cents) : 0,
  };
}
