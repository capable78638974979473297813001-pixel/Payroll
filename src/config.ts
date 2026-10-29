import { validateRoutingNumber } from '../engine/payroll/directDeposit.ts';
import type { AchConfig } from './money/ach.ts';

export interface Config {
  port: number;
  /** SQLite file the store persists to. Unset means in-memory only (development). */
  dataFile: string | undefined;
  /** Bearer token with admin rights: creates companies, and records what the bank tells us. */
  adminToken: string | undefined;
  /** Let anyone create a company. Off by default; signup needs KYB first. */
  openSignup: boolean;
  ach: {
    /** outbox: write files for pickup by whatever carries them to the bank. sandbox: a simulated bank, development only. */
    mode: 'outbox' | 'sandbox';
    outboxDir: string;
    config: AchConfig;
  };
  /** Pay employees automatically once a run is funded and the hold has passed. */
  autoDisburse: boolean;
  /** Requests per minute per client address. 0 turns the limiter off. */
  rateLimitPerMinute: number;
  /** Trust X-Forwarded-For for the client address (only behind a proxy you control). */
  trustProxy: boolean;
}

function int(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const mode = (env.TOTALI_ACH_MODE ?? 'outbox').trim();
  if (mode !== 'outbox' && mode !== 'sandbox') throw new Error("TOTALI_ACH_MODE must be 'outbox' or 'sandbox'");
  if (mode === 'sandbox' && env.NODE_ENV === 'production') throw new Error('TOTALI_ACH_MODE=sandbox is a simulated bank and is refused when NODE_ENV=production.');
  const odfi = (env.TOTALI_ODFI_ROUTING ?? '').trim();
  if (odfi && !validateRoutingNumber(odfi)) throw new Error('TOTALI_ODFI_ROUTING is not a valid routing number (its check digit fails).');
  const companyId = (env.TOTALI_ORIGINATOR_COMPANY_ID ?? '').trim();
  if (companyId.length > 10) throw new Error('TOTALI_ORIGINATOR_COMPANY_ID is at most 10 characters.');
  return {
    port: int(env, 'PORT', 8787, 0, 65535),
    dataFile: env.TOTALI_DATA_FILE?.trim() || undefined,
    adminToken: env.TOTALI_ADMIN_TOKEN?.trim() || undefined,
    openSignup: env.TOTALI_OPEN_SIGNUP === '1',
    ach: {
      mode,
      outboxDir: env.TOTALI_ACH_OUTBOX?.trim() || './.totali-data/ach-outbox',
      config: {
        originator: {
          odfiRoutingNumber: odfi,
          odfiName: (env.TOTALI_ODFI_NAME ?? '').trim(),
          immediateOrigin: (env.TOTALI_ORIGIN_ID ?? '').trim(),
          companyName: (env.TOTALI_ORIGINATOR_NAME ?? 'TOTALI PAYROLL').trim(),
          companyId,
        },
        holdBankingDays: int(env, 'TOTALI_ACH_HOLD_BANKING_DAYS', 2, 0, 10),
        fundingLeadBankingDays: int(env, 'TOTALI_ACH_FUNDING_LEAD_DAYS', 1, 0, 5),
        creditLeadBankingDays: int(env, 'TOTALI_ACH_CREDIT_LEAD_DAYS', 1, 0, 5),
        trustSettlementDate: env.TOTALI_TRUST_SETTLEMENT_DATE === '1',
      },
    },
    autoDisburse: env.TOTALI_AUTO_DISBURSE === '1',
    rateLimitPerMinute: int(env, 'TOTALI_RATE_LIMIT_PER_MIN', 600, 0, 1_000_000),
    trustProxy: env.TOTALI_TRUST_PROXY === '1',
  };
}
