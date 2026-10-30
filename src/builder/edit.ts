import { badRequest, conflict } from '../lib/errors.ts';
import type { Store } from '../store/store.ts';
import type { Company } from '../domain/types.ts';
import { build, normalizeAnswers, type Answers, type IndustryId } from './catalog.ts';
import { lagDays } from './finish.ts';

/**
 * Change what the business told the builder: the locations, team size, tips, pay frequency, contractors and the
 * industry's own questions. The state is fixed (every tax number and year-to-date total follows it), and so is the
 * industry. The dashboard and the company's settings follow the new answers; history is untouched.
 */
export function updateSetup(store: Store, companyId: string, patch: unknown, date: string, now: Date): Company {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) throw badRequest('Send the answers to change.');
  const company = structuredClone(store.companies.require(companyId, 'Company'));
  if (!company.setup) throw conflict('no_setup', 'This company wasn’t made with the setup questions, so there are no answers to change.');
  const industry = company.setup.industry as IndustryId;
  const merged = { ...company.setup.answers, ...(patch as Record<string, unknown>) };
  if ('state' in (patch as object) && (patch as Record<string, unknown>).state !== company.homeState) {
    throw badRequest(`Your state is ${company.homeState} and can’t change here: every tax rate, form and year-to-date total follows it. Start a new company for a different state.`, { field: 'state' });
  }
  const { answers, errors } = normalizeAnswers(industry, merged, date);
  const firstError = Object.entries(errors)[0];
  if (firstError) throw badRequest(String(firstError[1]), { field: firstError[0] });
  const result = build(industry, answers as Answers, date);
  if (!result.progress.ready) throw conflict('setup_incomplete', 'Every question needs an answer.', { next: result.progress.next });

  // A location that people still work at cannot disappear from under them.
  const keep = new Set((answers.locations ?? []).map((l) => l.name.toLowerCase()));
  if (answers.locations) {
    const stranded = store.employees.where((e) => e.companyId === companyId && !e.terminationDate && !!e.location && !keep.has(e.location.toLowerCase()));
    if (stranded.length) throw conflict('location_in_use', `${stranded.length} ${stranded.length === 1 ? 'person works' : 'people work'} at a location you removed (${[...new Set(stranded.map((e) => e.location))].join(', ')}). Move them first.`, { field: 'locations' });
    company.locations = answers.locations;
  }
  const f = answers.frequency;
  if (f) {
    company.paySchedule = { frequency: f.value, checkDateLagDays: f.weekday ? lagDays(company.settings.workweekStartDay, f.weekday) : company.paySchedule.checkDateLagDays, ...(f.weekday ? { payWeekday: f.weekday } : {}) };
  }
  if (industry === 'restaurant' && answers.tips) {
    const pol = company.settings.policy;
    if (!answers.tips.on || answers.tips.pool === 'none') pol.pool = { ...pol.pool, enabled: false };
    else pol.pool = { ...pol.pool, enabled: true, basis: answers.tips.pool };
  }
  company.setup = { ...company.setup, answers: answers as Record<string, unknown> };
  void now;
  store.tx(() => store.companies.put(company));
  return company;
}
