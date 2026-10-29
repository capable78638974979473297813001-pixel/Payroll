export interface Config {
  port: number;
  /** JSON file the store persists to. Unset means in-memory only (development). */
  dataFile: string | undefined;
  /** Bearer token with admin rights: creates companies. */
  adminToken: string | undefined;
  /** Let anyone create a company. Off by default; signup needs KYB first. */
  openSignup: boolean;
  /** Signing secrets for the Stripe webhook endpoints that point at /v1/webhooks/stripe. A regular endpoint and a Connect endpoint each have their own. */
  webhookSecrets: string[];
  /** Hours to hold employer-debit money before paying employees (ACH returns). */
  holdHours: number;
  /** Pay employees automatically once a run is funded and the hold has passed. */
  autoDisburse: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const hold = env.TOTALI_ACH_RETURN_HOLD_HOURS === undefined ? 48 : Number(env.TOTALI_ACH_RETURN_HOLD_HOURS);
  if (!Number.isFinite(hold) || hold < 0) throw new Error('TOTALI_ACH_RETURN_HOLD_HOURS must be a number of hours, 0 or more');
  const port = Number(env.PORT ?? 8787);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be a valid port number');
  return {
    port,
    dataFile: env.TOTALI_DATA_FILE?.trim() || undefined,
    adminToken: env.TOTALI_ADMIN_TOKEN?.trim() || undefined,
    openSignup: env.TOTALI_OPEN_SIGNUP === '1',
    webhookSecrets: (env.STRIPE_WEBHOOK_SECRET ?? '').split(',').map((x) => x.trim()).filter(Boolean),
    holdHours: hold,
    autoDisburse: env.TOTALI_AUTO_DISBURSE === '1',
  };
}
