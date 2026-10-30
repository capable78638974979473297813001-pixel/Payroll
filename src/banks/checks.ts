import { bankingDaysBetween } from '../lib/bizdays.ts';
import type { BankProfile, Finding } from './types.ts';

const dollars = (c: number) => `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const calendarDays = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

export interface SetupFacts {
  odfiRoutingNumber: string;
  immediateOrigin: string;
  leadBankingDays?: number;
  limitsTier?: string;
  sftp?: { host: string; port: number };
}

/**
 * Check an employer's bank setup against the bank's published rules. Errors
 * mean the setup cannot work as written; warnings mean it may not match what
 * the bank documents; info is something to do or ask.
 */
export function checkSetup(profile: BankProfile, s: SetupFacts): Finding[] {
  const out: Finding[] = [];
  const r = profile.rules;

  if (r.immediateOrigin && !new RegExp(r.immediateOrigin.pattern).test(s.immediateOrigin)) {
    out.push({ severity: 'error', code: 'immediate_origin_format', message: `${profile.name} expects the immediate origin to be ${r.immediateOrigin.description}. You entered '${s.immediateOrigin}'. Files with the wrong id may be rejected.` });
  }
  if (profile.knownRoutingNumbers.length > 0 && !profile.knownRoutingNumbers.includes(s.odfiRoutingNumber)) {
    out.push({ severity: 'warning', code: 'routing_not_in_spec', message: `${profile.name}'s file specification shows routing number ${profile.knownRoutingNumbers.join(' or ')}. You entered ${s.odfiRoutingNumber}. Banks can use several routing numbers, so check it with them.` });
  }
  if (r.effectiveMustFollowCreation && s.leadBankingDays === 0) {
    out.push({ severity: 'error', code: 'lead_days_zero', message: `${profile.name} requires the effective date to be after the day the file is created, so leadBankingDays cannot be 0.` });
  }
  if (r.defaultLeadBankingDays && s.leadBankingDays !== undefined && s.leadBankingDays < r.defaultLeadBankingDays.days) {
    const basis = r.defaultLeadBankingDays.basis === 'documented' ? 'documents' : 'appears to require, from its guide,';
    out.push({ severity: r.defaultLeadBankingDays.basis === 'documented' ? 'error' : 'warning', code: 'lead_days_short', message: `${profile.name} ${basis} about ${r.defaultLeadBankingDays.days} banking days between preparing a payroll file and its effective date. You set ${s.leadBankingDays}.` });
  }
  if (s.limitsTier !== undefined) {
    if (!r.limits || r.limits.tier !== s.limitsTier) {
      out.push({ severity: 'error', code: 'limits_tier_unknown', message: `${profile.name} has no limits tier called '${s.limitsTier}'${r.limits ? ` (it has '${r.limits.tier}')` : ''}.` });
    } else {
      out.push({ severity: 'info', code: 'limits_tier', message: `Each file will be checked against this tier's limits: ${dollars(r.limits.perBatchCents)} per batch and ${dollars(r.limits.perMonthCents)} a month.` });
    }
  } else if (r.limits) {
    out.push({ severity: 'info', code: 'limits_tier_available', message: `${profile.name} limits ACH on its ${r.limits.tier} service to ${dollars(r.limits.perBatchCents)} per batch and ${dollars(r.limits.perMonthCents)} a month. If you use that service, set limitsTier to '${r.limits.tier}'.` });
  }

  if (s.sftp) {
    const sf = profile.sftp;
    if (sf.support === 'unsupported_auth') {
      out.push({ severity: 'error', code: 'sftp_login_unsupported', message: `${profile.name}'s file transfer needs a password login. Totali's SFTP delivery uses a key only, so it cannot deliver there. Remove the sftp settings and use download-and-upload.` });
    } else if (sf.support === 'none_found') {
      out.push({ severity: 'warning', code: 'sftp_not_documented', message: `I found no automatic file delivery documented for ${profile.name}. Only set this up if the bank has told you it is available for your account.` });
    } else if (sf.support === 'unconfirmed') {
      out.push({ severity: 'warning', code: 'sftp_unconfirmed', message: `I could not confirm that ${profile.name} takes SFTP for your account. Only set this up if the bank has told you it does, and with a key login.` });
    } else if (sf.auth === 'password') {
      out.push({ severity: 'error', code: 'sftp_login_unsupported', message: `${profile.name} logs in with a password; Totali uses keys.` });
    }
    if (sf.host && s.sftp.host.toLowerCase() !== sf.host && s.sftp.host.toLowerCase() !== sf.testHost) {
      out.push({ severity: 'warning', code: 'sftp_host_differs', message: `${profile.name}'s guide names ${sf.host}${sf.testHost ? ` (and ${sf.testHost} for testing)` : ''}. You entered ${s.sftp.host}. Use the host your implementation team gave you.` });
    }
    if (sf.port && s.sftp.port !== sf.port) {
      out.push({ severity: 'warning', code: 'sftp_port_differs', message: `${profile.name}'s guide shows port ${sf.port}. You entered ${s.sftp.port}.` });
    }
    if (r.ipAllowListRequired) out.push({ severity: 'info', code: 'ip_allow_list', message: `${profile.name} only accepts automated connections from IP addresses you have registered with them. Give them the address Totali sends from.` });
    if (r.pgp === 'optional') out.push({ severity: 'info', code: 'pgp_off', message: `${profile.name} offers PGP encryption. Totali does not support it, so leave it off for your ACH folder.` });
    if (r.pgp === 'unconfirmed') out.push({ severity: 'info', code: 'pgp_ask', message: `I could not confirm whether ${profile.name} requires PGP. Totali does not support it: ask the bank.` });
  }
  return out;
}

export interface FileFacts {
  kind: 'credit' | 'prenote';
  today: string;
  effectiveDate: string;
  entryCount: number;
  creditsCents: number;
  debitsCents: number;
  largestEntryCents: number;
  /** Credits already in this company's other live employer files with an effective date in the same month. */
  monthSoFarCents: number;
  limitsTier?: string;
}

/** Check a payment file Totali has just built against the bank's rules. Errors stop it being offered for release. */
export function checkFile(profile: BankProfile, f: FileFacts): Finding[] {
  const out: Finding[] = [];
  const r = profile.rules;
  const sameDay = f.effectiveDate <= f.today;

  if (r.effectiveMustFollowCreation && sameDay) {
    out.push({ severity: 'error', code: 'effective_not_after_creation', message: `${profile.name} requires the effective date (${f.effectiveDate}) to be after the day the file is created (${f.today}).` });
  }
  if (sameDay && r.sameDay === 'no') {
    out.push({ severity: 'error', code: 'same_day_unsupported', message: `${profile.name} does not support same-day settlement.` });
  }
  if (sameDay && r.sameDayMaxEntryCents !== undefined && f.largestEntryCents > r.sameDayMaxEntryCents) {
    out.push({ severity: 'error', code: 'same_day_entry_limit', message: `A same-day entry of ${dollars(f.largestEntryCents)} is over ${profile.name}'s same-day limit of ${dollars(r.sameDayMaxEntryCents)} per entry.` });
  }
  if (r.maxAhead) {
    const ahead = r.maxAhead.unit === 'banking' ? bankingDaysBetween(f.today, f.effectiveDate) : calendarDays(f.today, f.effectiveDate);
    if (ahead > r.maxAhead.days) {
      out.push({ severity: 'error', code: 'too_far_ahead', message: `${profile.name} accepts files up to ${r.maxAhead.days} ${r.maxAhead.unit} days ahead (${r.maxAhead.applies}). This file takes effect ${ahead} days from now.` });
    }
  }
  if (f.limitsTier !== undefined && r.limits && r.limits.tier === f.limitsTier) {
    if (f.creditsCents > r.limits.perBatchCents) {
      out.push({ severity: 'error', code: 'batch_limit', message: `This file is ${dollars(f.creditsCents)}. ${profile.name}'s ${r.limits.tier} limit is ${dollars(r.limits.perBatchCents)} per batch. Split the pay run, pay some employees another way, or move to a service with higher limits.` });
    }
    if (f.monthSoFarCents + f.creditsCents > r.limits.perMonthCents) {
      out.push({ severity: 'error', code: 'month_limit', message: `With this file the month's ACH total would be ${dollars(f.monthSoFarCents + f.creditsCents)}, over ${profile.name}'s ${r.limits.tier} limit of ${dollars(r.limits.perMonthCents)} a month.` });
    }
  }
  if (r.controlTotalsRequired && f.kind === 'credit') {
    out.push({ severity: 'info', code: 'control_totals', message: `${profile.name} will not release the file until you enter its control totals: ${f.entryCount} entries, credits ${dollars(f.creditsCents)}, debits ${dollars(f.debitsCents)}.` });
  }
  if (r.testFileRequired) out.push({ severity: 'info', code: 'test_file', message: `${profile.name} requires a test file before your first live file. Arrange it with them.` });
  if (r.returnTrace) out.push({ severity: 'info', code: 'return_trace', message: r.returnTrace });
  return out;
}

export const errorsOf = (fs: Finding[]) => fs.filter((f) => f.severity === 'error');
