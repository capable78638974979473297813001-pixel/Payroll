import { badRequest } from '../lib/errors.ts';
import { profiles } from './profiles.ts';
import type { BankProfile, BankProfileId } from './types.ts';

export type { BankProfile, BankProfileId, Finding } from './types.ts';
export { profiles } from './profiles.ts';

export const PROFILE_IDS = Object.keys(profiles) as BankProfileId[];

export function getProfile(id: string | undefined): BankProfile {
  const key = (id ?? 'other') as BankProfileId;
  const p = profiles[key];
  if (!p) throw badRequest(`bankProfile '${id}' is not one of: ${PROFILE_IDS.join(', ')}`);
  return p;
}

/** The list the setup screen shows: enough to choose a bank and know what it supports. */
export function listProfiles() {
  return PROFILE_IDS.map((id) => {
    const p = profiles[id];
    return { id: p.id, name: p.name, coverage: p.coverage, upload: p.upload, sftp: p.sftp.support, verifiedOn: p.verifiedOn, sourcesRead: p.sources.filter((s) => s.how === 'read').length, sourcesSummaryOnly: p.sources.filter((s) => s.how === 'search_summary').length };
  });
}
