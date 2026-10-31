import { newId } from '../lib/ids.ts';
import { conflict } from '../lib/errors.ts';
import { getNiche, settingsFromProfile } from '../industries/index.ts';
import type { Store } from '../store/store.ts';
import type { Company } from '../domain/types.ts';
import type { User } from '../accounts/types.ts';
import { build, type Answers, type IndustryId } from './catalog.ts';

/** Which starting profile a business gets. Restaurants differ by whether anyone earns tips; the others have one. */
export function nicheFor(industry: IndustryId, a: Answers): string {
  switch (industry) {
    case 'restaurant': return a.tips?.on ? 'full_service' : 'fast_casual';
    case 'hotel_lodging': return 'hotel_venue';
    case 'construction_trades': return 'trades_contractor';
    case 'office_studios': return 'office_studio';
    case 'delivery_couriers': return 'courier_fleet';
  }
}

/** The business's real settings: the niche's starting profile, shaped by what the owner said about tips and service charges. */
function settingsFor(industry: IndustryId, a: Answers) {
  const profile = getNiche(industry, nicheFor(industry, a));
  const settings = settingsFromProfile(profile);
  if (industry === 'restaurant') {
    if (a.tips?.on && a.tipcredit) settings.policy.takesTipCredit = a.tipcredit.on;
    if (!a.tips?.on) {
      settings.policy = { takesTipCredit: false, pool: { enabled: false, roles: [], basis: 'hours' }, tipOuts: [], serviceCharge: 'none', serviceChargeRoles: [], cardFeeDeductionBps: null };
    } else if (a.tips.pool === 'none') {
      settings.policy.pool = { ...settings.policy.pool, enabled: false };
    } else {
      // Only people who customarily receive tips share a pool where a tip credit is taken, and never a manager.
      const sharing = settings.roles.filter((r) => r.tipped === 'customarily' && !r.manager).map((r) => r.key);
      settings.policy.pool = { enabled: true, basis: a.tips.pool, roles: settings.policy.pool.roles.length ? settings.policy.pool.roles : sharing };
    }
  }
  if (industry === 'hotel_lodging' && a.service?.on) {
    settings.policy.serviceCharge = 'distribute_to_staff';
    settings.policy.serviceChargeRoles = settings.roles.filter((r) => r.tipped !== 'never').map((r) => r.key);
  }
  return settings;
}

/**
 * The weekday employees are paid, as a lag after the workweek ends. The workweek starts on `startDay` (0 is
 * Sunday), so it ends the day before; pay falls on `weekday` after that, one to seven days later.
 */
export function lagDays(startDay: number, weekday: string): number {
  const names = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const target = names.indexOf(weekday);
  const endDow = (startDay + 6) % 7;
  return ((target - endDow + 7) % 7) || 7;
}

/** Create the company the builder described. Nothing here can be done twice for one person. */
export function createCompanyFromSetup(store: Store, user: User, industry: IndustryId, answers: Answers, date: string, now: Date): Company {
  if (user.companyId) throw conflict('company_exists', 'Your company is already set up.');
  const result = build(industry, answers, date);
  if (!result.progress.ready) throw conflict('setup_incomplete', 'Finish the required questions first.', { next: result.progress.next });
  const profile = getNiche(industry, nicheFor(industry, answers));
  const frequency = answers.frequency!;
  const weekday = frequency.weekday;
  const settings = settingsFor(industry, answers);
  const company: Company = {
    id: newId('co'),
    legalName: user.businessName,
    // The builder does not ask for it. Payroll cannot be approved until it is added in Company setup.
    ein: '',
    industry,
    niche: profile.id,
    homeState: answers.state!,
    paySchedule: { frequency: frequency.value, checkDateLagDays: weekday ? lagDays(settings.workweekStartDay, weekday) : 5, ...(weekday ? { payWeekday: weekday } : {}) },
    settings,
    ...(answers.locations ? { locations: answers.locations } : {}),
    setup: { industry, answers: answers as Record<string, unknown>, builtAt: now.toISOString() },
    payment: { mode: 'employer_bank' },
    funding: {},
    createdAt: now.toISOString(),
  };
  store.tx(() => {
    store.companies.put(company);
  });
  return company;
}
