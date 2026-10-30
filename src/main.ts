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

const config = loadConfig();
const log = (m: string) => console.error(`[totali] ${m}`);

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
const app = createApp({ store, banks, ach, config, log });

const timer = setInterval(() => void reconcile(ach, store, { autoDisburse: config.autoDisburse, log }), 60_000);
timer.unref();

app.server.listen(config.port, () => log(`listening on :${config.port}`));
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => app.server.close(() => { store.close(); process.exit(0); }));
}
