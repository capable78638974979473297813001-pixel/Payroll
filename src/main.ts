import { loadConfig } from './config.ts';
import { Store } from './store/store.ts';
import { createApp } from './api/app.ts';
import { MoneyService, reconcile } from './money/service.ts';
import { stripeFromEnv, stripeKeyRefused, stripeMode } from './money/stripe.ts';
import { dataKeyConfigured } from './lib/crypto.ts';

const config = loadConfig();
const log = (m: string) => console.error(`[totali] ${m}`);

const refused = stripeKeyRefused();
if (refused) log(refused);
log(`stripe: ${stripeMode()}${stripeMode() === 'unconfigured' ? ' (money movement disabled until STRIPE_SECRET_KEY is set)' : ''}`);
if (config.webhookSecrets.length === 0) log('STRIPE_WEBHOOK_SECRET is not set: webhooks will be rejected, so debits cannot confirm.');
if (!config.adminToken && !config.openSignup) log('TOTALI_ADMIN_TOKEN is not set: no one can create a company.');
if (!dataKeyConfigured()) log('TOTALI_DATA_KEY is not set: SSNs will be refused.');
if (!config.dataFile) log('TOTALI_DATA_FILE is not set: data lives in memory only and is lost on restart.');

const store = new Store(config.dataFile);
const money = new MoneyService(store, stripeFromEnv(), { holdHours: config.holdHours });
const app = createApp({ store, money, config, log });

const timer = setInterval(() => void reconcile(money, store, { autoDisburse: config.autoDisburse, log }), 60_000);
timer.unref();

app.server.listen(config.port, () => log(`listening on :${config.port}`));
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => app.server.close(() => process.exit(0)));
