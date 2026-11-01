# Launch checklist

Everything the code can do to be ready for real customers is done. This is what only you can do, in the order to do it.
Tick each one. `npm run check:stripe` checks the Stripe and server settings and says what is missing.

When the server starts with `NODE_ENV=production` it checks its own settings and **refuses to start** if something that
would lose data or break sign-in or billing is missing (`src/production.ts`). It prints exactly what.

## 1. Before anything else

- [ ] **A lawyer reads the Terms of Service and Privacy Policy** (`web/js/pages/legal.content.js`). They describe what the
  product does and were written carefully, but they are not legal advice and have not been reviewed by a lawyer. The two
  things they most need to settle: the governing-law state, and whether the liability limit is right for payroll.
  Change the text in that one file; bump `termsVersion` in `src/api/app.ts` when it changes.
- [ ] **A real support address** that someone reads (`SUPPORT_EMAIL`, default hello@omnia.tax) and a mailing address for OMNIA TAX LLC in the Terms.
- [ ] **Decide who is allowed to sign up.** `TOTALI_OPEN_SIGNUP=1` lets anyone create a company.

## 2. Deploy

- [ ] Render, *New*, *Blueprint*, this repo and branch. It asks for the secrets (`sync: false` in `render.yaml`).
- [ ] `TOTALI_DATA_KEY`: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. **Keep a copy somewhere other than Render.** Losing it makes every SSN and bank number unreadable.
- [ ] `PUBLIC_BASE_URL`: your https address, with no trailing slash.
- [ ] A paid instance with the persistent disk (the database is a file on it). Run **one** instance only.
- [ ] Your own domain pointed at the service, https on.
- [ ] Turn on Render's **disk snapshots**. Totali also copies the database every six hours to `/var/data/backups` and keeps the last 56 (14 days), which protects against a bad deploy, not against losing the disk.
- [ ] **Restore test:** copy a file from `backups/` over `db.sqlite` on a scratch instance and sign in. A backup nobody has restored is a hope.
- [ ] An uptime monitor on `https://YOUR-SITE/ready` (it reads and writes the database, so it fails if storage is stuck).

## 3. Email (Resend)

- [ ] Verify your sending domain in Resend and publish the SPF and DKIM records it gives you.
- [ ] `RESEND_API_KEY` and `RESEND_FROM` (an address on that domain). Without them nobody can verify their email, and the server will not start in production.
- [ ] Sign up with a real inbox and check the code arrives and is not in spam.

## 4. Stripe, the subscription ($20 every 3 months)

- [ ] Activate your Stripe account (business details, bank for payouts).
- [ ] Test first. `STRIPE_SECRET_KEY=sk_test_...`, `STRIPE_PUBLISHABLE_KEY`, then in Stripe: *Developers, Webhooks, Add endpoint*
  `https://YOUR-SITE/v1/stripe/webhook` for events `checkout.session.completed`, `customer.subscription.created`,
  `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`. Copy its signing secret to `STRIPE_WEBHOOK_SECRET`.
- [ ] In Stripe *Settings, Billing, Customer portal*: turn on updating the card and cancelling, and set the return link.
- [ ] In test mode, subscribe with card `4242 4242 4242 4242`, see Billing say Active, approve a pay run, open Manage billing, cancel, and see "Ends on".
- [ ] Try the failed-payment card `4000 0000 0000 0341` and see "Payment late".
- [ ] Go live: live keys, a **live** webhook endpoint and its secret, and `STRIPE_ALLOW_LIVE=1`. Subscribe once for real with your own card and refund it.
- [ ] Tax on the subscription: if you owe sales tax on software, switch on Stripe Tax and tell me, and I'll turn it on in Checkout.
- [ ] Companies you want free (pilots, friends): `TOTALI_BILLING_EXEMPT=cmp_...,cmp_...`.

## 5. Sign-in and connections

- [ ] **Google:** an OAuth client with `https://YOUR-SITE/v1/auth/google/callback`. Set `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`, or leave them off and the button hides.
- [ ] **Square (sandbox only):** a sandbox application with redirect `https://totali.tax/v1/pos/square/callback`; `SQUARE_APPLICATION_ID` / `SQUARE_APPLICATION_SECRET` / `SQUARE_ENVIRONMENT=sandbox`. See `docs/PARTNER_APPLICATIONS.md`.
- [ ] **Clover:** the application in `docs/PARTNER_APPLICATIONS.md`. It takes weeks. Until then Clover restaurants use the report import.
- [ ] Try one real pull from Toast, Square and 7shifts. They have only been tested against fakes.

## 6. Money and taxes

- [ ] Run a real pay run for yourself end to end: hours, approve, download the payment file, upload it at **your own bank**, and confirm it pays. Totali does not move the money. Your bank does.
- [ ] Compare a pay run against another payroll provider's figures for the same people. Federal, your state, and any city.
- [ ] Check the Tax tab's due dates against the agencies' own calendars for your state.
- [ ] Set up the MasteryTax checks the README describes if you want the independent re-check of each run.

## 7. First week

- [ ] Start with one restaurant you know. Sit with them through setup and the first payroll.
- [ ] Watch the server log (`[totali] ...`) for `NOT READY`, `backup failed`, and unhandled errors.
- [ ] Re-run the `check:stripe` script after any change to the environment.
