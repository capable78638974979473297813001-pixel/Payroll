import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadConfig } from './config.ts';
import { Store } from './store/store.ts';
import { createApp } from './api/app.ts';
import { AchService, reconcile } from './money/ach.ts';
import { BankService } from './banking/accounts.ts';
import { stripeFromEnv, stripeKeyRefused, stripeMode } from './money/stripe.ts';
import { OutboxSubmitter } from './ach/submitter.ts';
import { SandboxBank } from './ach/sandbox.ts';
import { ColumnClient } from './column/client.ts';
import { ColumnSubmitter } from './column/submitter.ts';
import { dataKeyConfigured } from './lib/crypto.ts';
import { mailerFromEnv } from './mail/mailer.ts';
import { isProduction, productionProblems } from './production.ts';

// A git-ignored .env next to the code, if there is one. Real environment variables win.
if (existsSync('.env')) process.loadEnvFile('.env');
const config = loadConfig();
const log = (m: string) => console.error(`[totali] ${m}`);

// In production, refuse to start rather than run in a way that loses data or breaks sign-in and billing.
if (isProduction(process.env)) {
  const { errors, warnings } = productionProblems(process.env);
  for (const w of warnings) log(`note: ${w}`);
  if (errors.length && process.env.TOTALI_SKIP_PREFLIGHT !== '1') {
    for (const e of errors) log(`NOT READY: ${e}`);
    log(`Not starting: ${errors.length} thing${errors.length === 1 ? '' : 's'} to fix first. (Set TOTALI_SKIP_PREFLIGHT=1 to start anyway. Don't, for real customers.)`);
    process.exit(1);
  }
}

const refused = stripeKeyRefused();
if (refused) log(refused);
log(`stripe: ${stripeMode()}${stripeMode() === 'unconfigured' ? ' (bank linking disabled until STRIPE_SECRET_KEY is set)' : ' (bank linking only; Stripe moves no money)'}`);
const o = config.ach.config.originator;
if (!o.odfiRoutingNumber || !o.immediateOrigin || !o.companyId || !o.odfiName) log('Totali-sent payments are not configured (TOTALI_ODFI_ROUTING, TOTALI_ODFI_NAME, TOTALI_ORIGIN_ID, TOTALI_ORIGINATOR_COMPANY_ID). That only matters for companies in totali_ach mode; the default employer-bank mode uses each employer\'s own bank details.');
if (config.ach.mode === 'column') log(config.ach.column!.apiKey.startsWith('test_') ? 'ACH mode is COLUMN SANDBOX: Column test key, no real money moves.' : 'ACH mode is COLUMN LIVE: real money moves.');
if (config.ach.mode === 'sandbox') log('ACH mode is SANDBOX: a simulated bank. No money moves. Never use this for real payroll.');
else log(`ACH mode: outbox. Files are written to ${config.ach.outboxDir} for pickup; they are not sent to a bank by Totali itself.`);
if (!config.adminToken && !config.openSignup) log('TOTALI_ADMIN_TOKEN is not set: no one can create a company or record what the bank says.');
if (!dataKeyConfigured()) log('TOTALI_DATA_KEY is not set: SSNs and bank account numbers will be refused.');
if (!config.dataFile) log('TOTALI_DATA_FILE is not set: data lives in memory only and is lost on restart.');

const store = new Store(config.dataFile);
const banks = new BankService(store, stripeFromEnv());
const submitter = config.ach.mode === 'sandbox' ? new SandboxBank() : config.ach.mode === 'column' ? new ColumnSubmitter(new ColumnClient({ apiKey: config.ach.column!.apiKey, bankAccountId: config.ach.column!.bankAccountId })) : new OutboxSubmitter(config.ach.outboxDir);
const ach = new AchService(store, banks, submitter, config.ach.config);
const mailer = mailerFromEnv(process.env, log);
log(mailer.kind === 'resend' ? 'email: Resend' : 'email: no RESEND_API_KEY, so verification codes are not emailed (they are kept in an in-memory outbox' + (config.devTools ? ' and shown at /v1/dev/outbox)' : '; set TOTALI_DEV=1 to read them in development)'));
// Tests point the POS adapters at a fake server. Only when the dev tools are on.
const posHosts = config.devTools && process.env.TOTALI_DEV_POS_HOSTS ? (JSON.parse(process.env.TOTALI_DEV_POS_HOSTS) as Record<string, string>) : undefined;
const app = createApp({ store, banks, ach, config, log, mailer, ...(posHosts ? { posHosts } : {}) });

// A copy of the database every six hours, the last two weeks kept, beside the data file. A copy on the same disk guards
// against a bad deploy or a mistake, not against losing the disk: take Render's disk snapshots too.
if (config.dataFile && process.env.TOTALI_BACKUP !== '0') {
  const dir = process.env.TOTALI_BACKUP_DIR || `${dirname(config.dataFile)}/backups`;
  const backup = () => { try { const f = store.backup(dir, new Date()); log(`backup written: ${f}`); store.pruneBackups(dir, 56); } catch (e) { log(`backup failed: ${(e as Error).message}`); } };
  setTimeout(backup, 60_000).unref();
  setInterval(backup, 6 * 3_600_000).unref();
}

const timer = setInterval(() => void reconcile(ach, store, { autoDisburse: config.autoDisburse, log }), 60_000);
timer.unref();

app.server.listen(config.port, () => log(`listening on :${config.port}`));
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => app.server.close(() => { store.close(); process.exit(0); }));
}
