import { badRequest, conflict, notFound } from '../lib/errors.ts';
import { restaurantNiches } from './restaurant.ts';
import { generalNiches } from './general.ts';
import type { ChecklistItem, CompanySettings, IndustryDef, NicheProfile } from './types.ts';

export type { ChecklistItem, CompanySettings, IndustryDef, NicheProfile, RoleTemplate, TipOutRule, TipPolicy } from './types.ts';

const planned = (id: string, label: string, description: string): IndustryDef => ({ id, label, status: 'planned', description, niches: [] });

/**
 * The catalog the signup picker reads. Restaurant is built end to end. Hotels, trades, offices and couriers run
 * on the same pay engine with their own starting roles. The rest are listed and refuse selection until they have
 * a profile.
 */
export const catalog: IndustryDef[] = [
  {
    id: 'restaurant',
    label: 'Restaurant',
    status: 'available',
    description: 'Tips, tip credit, tip pools, service charges, split shifts and delivery. Nine niches from fine dining to food trucks.',
    niches: restaurantNiches,
  },
  {
    id: 'hotel_lodging',
    label: 'Hotels and venues',
    status: 'available',
    description: 'Departments, seasonal staff and service charges.',
    niches: generalNiches.filter((n) => n.industry === 'hotel_lodging'),
  },
  {
    id: 'construction_trades',
    label: 'Trades and construction',
    status: 'available',
    description: 'Job costing, crews and workers’ comp classes. Prevailing wage and certified payroll are not computed.',
    niches: generalNiches.filter((n) => n.industry === 'construction_trades'),
  },
  {
    id: 'office_studios',
    label: 'Office and studios',
    status: 'available',
    description: 'Salaried and hourly staff, time off and more than one state.',
    niches: generalNiches.filter((n) => n.industry === 'office_studios'),
  },
  {
    id: 'delivery_couriers',
    label: 'Delivery and couriers',
    status: 'available',
    description: 'Trips, mileage and contractor drivers.',
    niches: generalNiches.filter((n) => n.industry === 'delivery_couriers'),
  },
  planned('salon_spa', 'Salon and spa', 'Booth rent, commission tiers and service tips.'),
  planned('retail', 'Retail', 'Commission, predictive scheduling and seasonal hiring.'),
  planned('childcare', 'Childcare', 'Ratio-aware scheduling and subsidy-aware payroll.'),
];

export function listIndustries(): Array<Pick<IndustryDef, 'id' | 'label' | 'status' | 'description'> & { niches: Array<Pick<NicheProfile, 'id' | 'label' | 'tagline'>> }> {
  return catalog.map((i) => ({
    id: i.id,
    label: i.label,
    status: i.status,
    description: i.description,
    niches: i.niches.map((n) => ({ id: n.id, label: n.label, tagline: n.tagline })),
  }));
}

export function getIndustry(id: string): IndustryDef {
  const industry = catalog.find((i) => i.id === id);
  if (!industry) throw notFound(`Industry '${id}'`);
  return industry;
}

export function getNiche(industryId: string, nicheId: string): NicheProfile {
  const industry = getIndustry(industryId);
  if (industry.status !== 'available') {
    throw conflict('industry_not_available', `${industry.label} is on the roadmap and cannot be selected yet.`);
  }
  const niche = industry.niches.find((n) => n.id === nicheId);
  if (!niche) throw notFound(`Niche '${nicheId}' in ${industry.label}`);
  return niche;
}

/** The settings a new company starts with: a deep copy, so editing one company never edits the catalog. */
export function settingsFromProfile(profile: NicheProfile): CompanySettings {
  return structuredClone({ roles: profile.roles, policy: profile.policy, workweekStartDay: profile.workweekStartDay });
}

/** The checklist items that apply to a company working in `state`. */
export function checklistFor(profile: NicheProfile, state: string): ChecklistItem[] {
  return profile.checklist.filter((c) => !c.states || c.states.includes(state));
}

/** Reject a settings document that names a role or rule target that does not exist. */
export function assertSettingsConsistent(settings: CompanySettings): void {
  const keys = new Set(settings.roles.map((r) => r.key));
  if (keys.size !== settings.roles.length) throw badRequest('settings.roles contains a duplicate role key');
  const needs = (k: string, where: string) => {
    if (!keys.has(k)) throw badRequest(`${where} names role '${k}', which is not in settings.roles`);
  };
  for (const r of settings.policy.pool.roles) needs(r, 'policy.pool.roles');
  for (const r of settings.policy.serviceChargeRoles) needs(r, 'policy.serviceChargeRoles');
  for (const t of settings.policy.tipOuts) {
    needs(t.fromRole, `tip-out '${t.id}'`);
    needs(t.toRole, `tip-out '${t.id}'`);
    if (!Number.isInteger(t.bps) || t.bps < 0 || t.bps > 10_000) throw badRequest(`tip-out '${t.id}' bps must be an integer from 0 to 10000`);
  }
  if (settings.policy.cardFeeDeductionBps !== null && (!Number.isInteger(settings.policy.cardFeeDeductionBps) || settings.policy.cardFeeDeductionBps < 0 || settings.policy.cardFeeDeductionBps > 1000)) {
    throw badRequest('policy.cardFeeDeductionBps must be null or an integer from 0 to 1000');
  }
  if (!Number.isInteger(settings.workweekStartDay) || settings.workweekStartDay < 0 || settings.workweekStartDay > 6) {
    throw badRequest('workweekStartDay must be an integer from 0 (Sunday) to 6');
  }
}
