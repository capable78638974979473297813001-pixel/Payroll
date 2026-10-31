# Totali backend

Totali is an all-in-one payroll app that comes as a different app for each kind of business. You pick **Restaurant → Full-service** and the company starts with that niche's roles, tip rules, pay rules and compliance checklist. This repo is the backend.

Restaurant is built end to end, with nine niches: full service, fine dining, quick service, fast casual, café, bar and nightclub, food truck, catering and banquets, pizzeria and delivery. The other industries are in the picker as `planned` and refuse selection until they have a profile.

Four things do the work:

| Job | Where it comes from | Where it lives here |
| --- | --- | --- |
| Tax math: federal, 50 states + DC, local, minimum wage, tip credit | [`payroll-tax-engine-`](https://github.com/capable78638974979473297813001-pixel/payroll-tax-engine-) | `engine/` (vendored) |
| Deposits, 941/940/W-2, state reports, and an independent re-check of every run | [`Masterysx-thing-`](https://github.com/capable78638974979473297813001-pixel/Masterysx-thing-) (MasteryTax) | `masterytax/` (vendored) |
| Connecting to banks: login, ownership, balance | **Stripe Financial Connections.** Stripe moves no money. | `src/money/stripe.ts`, `src/banking/` |
| Moving money | **The employer's own bank** (the default): Totali writes the payment file, the employer approves it at their bank, and Totali can deliver it by SFTP where the bank supports it. Or **Totali, by ACH**, through its own sponsoring bank. | `src/ach/`, `src/money/ach.ts` |

Everything else (the niches, tip and wage rules, pay runs, API) is Totali's own, in `src/`.

**Read [docs/GAPS.md](docs/GAPS.md) before putting real money through this.** Nothing here has run against real Stripe or a real bank. In the default mode the employer's own bank sends the money, so Totali needs no sponsoring bank; sending through Totali's own bank needs one.

## The web app

`npm start`, then open http://localhost:8787. The server serves the app from `web/` (plain ES modules, no build step), built from the screens in `design/totali/`.

**What you can do in it:** create an account (email code, or Google), pick an industry, answer a few questions and watch the dashboard build, then run payroll: enter hours and tips (or import a spreadsheet), review every paycheck, approve, open pay stubs, and download the payment file for your own bank. Invite new hires by email; they fill in their W-4, state form, I-9 section 1 and direct deposit on their phone from a private link. Time and tips by day, the tip pool, contractors with W-9s and a year-end export, job costing, crews and workers' comp classes, settings (including editing your setup answers), company setup, billing (card on file through Stripe) and help.

**Customizable.** Every dashboard is a saved document: cards, sizes, order, tabs, colors, fonts, corners, density, navigation and the owner's own words are all settable (press *Customize*). There are no templates; two businesses start from what they said and diverge from there.

### Run it locally

```bash
cp .env.example .env
TOTALI_DEV=1 npm start     # with no RESEND_API_KEY, emailed codes and links appear in the app instead of being sent
```

### Browser tests

Playwright and Chromium are used for end-to-end tests. Each script starts its own server on a free port:

```bash
for f in setup-flow dashboard payroll people settings time contractors jobs google; do node e2e/$f.e2e.cjs; done
```

### Deploy to Render

`render.yaml` is a blueprint: one web service, a persistent disk for the database, and every secret listed with `sync: false`, so Render asks you for the value in its dashboard and nothing secret is in git.

1. Render, *New*, *Blueprint*, pick this repo and branch. It asks for the secret values.
2. **`TOTALI_DATA_KEY`**: 32 random bytes, base64 (`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`). It encrypts SSNs and bank numbers. Back it up somewhere other than the disk; losing it makes them unrecoverable.
3. **`PUBLIC_BASE_URL`**: the site's address, with `https://`. It makes cookies `Secure` and decides where links in emails point. Without it the server refuses to build email links.
4. **`RESEND_API_KEY`** and **`RESEND_FROM`**: email. Verify your domain in Resend and use an address on it; until then Resend only delivers to its account owner.
5. Optional: `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` (add `{PUBLIC_BASE_URL}/v1/auth/google/callback` as a redirect URI; the button is hidden without them), `STRIPE_SECRET_KEY` / `STRIPE_PUBLISHABLE_KEY` / `STRIPE_WEBHOOK_SECRET` (cards on the Billing page; point a Stripe webhook at `/v1/stripe/webhook` for `setup_intent.succeeded`), `SUPPORT_EMAIL` (where Help messages go).

The persistent disk needs a paid Render instance. SQLite is a single file, so run one instance.

### Employee accounts

When the owner finishes the setup, the first screen says to add employees and shows a code like `K7PM-4QXR`. The code works for **three days**; for someone hired later the owner makes a new one (Onboarding tab, or Settings). It can be printed as a card.

An employee goes to `/employee`, taps *Create account*, and enters the code, their email and a password. **Nothing is emailed to them and there is no verification**: the email is just the username. They then fill in their name, W-4, I-9 section 1, optional bank details and a typed signature on one page, and send the request. Nothing is on the payroll yet.

The owner sees the request on the Onboarding tab (and as a to-do on the home), picks the role, pay, location and start date, and approves. That is when the employee record is created from the request and linked to the login; the private copy of the request (SSN, bank numbers) is deleted. The owner can instead link a request to someone they already added, so nobody is on the team twice, or decline with a reason. A declined person can fix it and send again.

Back at Totali, anyone with a login sees their name at the top of the landing page and a button to their dashboard. Approved employees see only their own pay stubs and hours, can change their W-4, and can ask to change their bank account (the owner approves). The cookie is `totali_emp`, separate from the owner's session. There is no password reset for employees yet.

### The questions

The builder asks industry-specific questions. Some are optional and start on No: tip credit (only if tips is Yes), bonuses and reimbursements, deductions, and earlier-provider year-to-date. Each one adds a real screen: tip credit notice on the invite form, a bonuses card on Run payroll, a Deductions card on a person's Pay tab, and an opening-balances form on the same tab.

### What isn't built yet

Said plainly, so nobody finds out the hard way:

- **Time off, trips and mileage** (office, delivery): the builder lists them as "coming soon" and does not count them.
- **Garnishments.** The deductions question covers benefits and retirement; court-ordered withholding is not set up.
- **Manager sign-ins.** Only the owner signs in to the dashboard. Employees have their own, smaller login (above); there are no manager accounts.
- **Employee password reset.** An employee who forgets their password cannot reset it; nothing is emailed to them.
- **Texting** invites. Invites go by email (or copy the link).
- **State forms other than Michigan's MI-W4.** Other states use the federal W-4 numbers and the state's default withholding.
- **Filing.** Totali keeps records and exports for your accountant (contractors, comp classes, job costs). It does not file 1099s.
- **The terms and privacy pages are drafts** that no lawyer has read.
- Nothing here has moved real money. See `docs/GAPS.md`.

## How a payroll run works

```
shifts, tips ──► niche rules ──► earnings ──► tax engine ──► paychecks ──► approve ──► fund ──► (bank confirms) ──► hold ──► disburse
 (POS or manual)  tip-outs, pool,  REG/OT/DT,  federal, state,  issues:       locks      ACH debit   money arrived     2 banking   ACH credit to each
                  service charge,  tips, make- local, FICA,     blocking /     shifts,    from the                      days        employee account
                  tip credit, NY/  up, spread  FUTA, SUI        review/info    rolls YTD  employer
                  CA/AK/NV/CO      call-in                         │
                                   MasteryTax recomputes the same run independently, then produces
                                   the deposit calendar, Form 941/940, W-2s, state reports
```

- **Niche rules** (`src/restaurant/`): overtime by workweek (federal; California daily, double time and seventh day; Alaska, Nevada and Colorado daily rules); the tip credit and its per-workweek make-up; tip-outs by role; tip pools by hours or points with managers excluded; mandatory service charges as wages; California meal and rest premiums; New York spread-of-hours and call-in pay; cash tips taxed but never paid out. Every step conserves cents, and the tests check it.
- **Issues.** A run reports `blocking` problems (cannot approve), `review` items (an assumption was made, or a rule is not modelled; an operator must acknowledge them) and `info`. Totali does not guess a missing fact.
- **Approve** locks the period's shifts and rolls each employee's year-to-date so the next run's wage-base caps are right. An approved run that has not moved money can be voided exactly.
- **Money** is a state machine with a ledger and real ACH dates (banking days, Federal Reserve holidays). See [docs/MONEY.md](docs/MONEY.md).

## Run it

Node 22.18+ and Python 3.10+ (MasteryTax). No packages to install.

```bash
cp .env.example .env     # then fill it in; set these in your host's secret store, not in git
npm test                 # Totali: ~400 tests, under a minute
npm run typecheck        # types for src/, test/, scripts/
npm run test:vendored    # the vendored engine's own suites (2,107 tests)
npm run check:stripe     # read-only: what is not ready for bank linking and ACH
npm start
```

For development, run a simulated bank: `TOTALI_ACH_MODE=sandbox` (refused when `NODE_ENV=production`).

## The money setup, in order (employer-bank mode, the default)

```bash
B=http://localhost:8787; K=totali_sk_...; C=co_...   # the company key is returned once, at signup

# 1. the employer's bank: its routing number and name, and the two ACH ids it assigned (optionally SFTP delivery)
curl -X PUT $B/v1/companies/$C/payment-setup -H "authorization: Bearer $K" -d '{"mode":"employer_bank","employerBank":{
  "odfiRoutingNumber":"021000021","odfiName":"Main Street Bank","immediateOrigin":"123456789","companyId":"1123456789"}}'

# 2. employees link a bank through Stripe (or are entered by hand and verified by a prenote), then split their pay
curl -X POST $B/v1/companies/$C/bank-links -H "authorization: Bearer $K" -d '{"owner":"employee","employeeId":"emp_..."}'
curl -X PUT  $B/v1/companies/$C/employees/emp_.../payout-accounts -H "authorization: Bearer $K" \
     -d '{"accounts":[{"bankAccountId":"bank_...","allocation":{"kind":"remainder"}}]}'

# 3. each payroll: draft, approve, prepare the file, download it (or let SFTP deliver it), release it AT THE BANK, then confirm
curl -X POST $B/v1/companies/$C/pay-runs/run_.../prepare-payment -H "authorization: Bearer $K" -d '{}'
curl         $B/v1/companies/$C/ach/files/ach_.../content -H "authorization: Bearer $K" -o payroll.ach
curl -X POST $B/v1/companies/$C/ach/files/ach_.../released -H "authorization: Bearer $K" -d '{"releasedBy":"Owner Name"}'
```

## The money setup for Totali-sent mode

```bash
B=http://localhost:8787; K=totali_sk_...; C=co_...   # the company key is returned once, at signup

# 1. the employer links a bank: Stripe confirms it, the owner types the numbers, Totali holds them encrypted
curl -X POST $B/v1/companies/$C/bank-links -H "authorization: Bearer $K" -d '{"owner":"company"}'
#    -> hand clientSecret to Stripe.js in the browser, then:
curl -X POST $B/v1/companies/$C/bank-links/complete -H "authorization: Bearer $K" \
     -d '{"sessionId":"fcsess_...","routingNumber":"021000021","accountNumber":"000987654321"}'

# 2. choose it as the funding account and record the employer's authorization to debit it
curl -X PUT  $B/v1/companies/$C/funding/account -H "authorization: Bearer $K" -d '{"bankAccountId":"bank_..."}'
curl         $B/v1/companies/$C/funding/authorization -H "authorization: Bearer $K"     # the text to show
curl -X POST $B/v1/companies/$C/funding/authorization -H "authorization: Bearer $K" -d '{"bankAccountId":"bank_...","acceptedBy":"Owner Name","accept":true}'

# 3. employees link a bank the same way (owner: "employee"), or are entered manually and verified by a prenote
curl -X PUT $B/v1/companies/$C/employees/emp_.../payout-accounts -H "authorization: Bearer $K" \
     -d '{"accounts":[{"bankAccountId":"bank_...","allocation":{"kind":"remainder"}}]}'

# 4. run payroll: draft, approve, fund, (the bank confirms), disburse
curl $B/v1/companies/$C/pay-runs/run_.../timeline -H "authorization: Bearer $K"
curl -X POST $B/v1/companies/$C/pay-runs/run_.../fund -H "authorization: Bearer $K" -d '{}'
```

## API

Public: `GET /health`, `GET /v1/industries`, `GET /v1/industries/:id`, `GET /v1/industries/:id/niches/:niche`.
Admin: `POST /v1/companies`, and everything under `/v1/ops`. A company key reaches only its own company.

Under `/v1/companies/:cid`:

| | |
| --- | --- |
| `GET`, `PATCH /` | company, niche, checklist, editable settings (roles, tip policy) |
| `GET`, `POST /employees` · `GET`, `PATCH /employees/:eid` · `POST …/terminate` | people. SSNs are accepted, encrypted, never returned |
| `PUT /employees/:eid/payout-accounts` | how net pay is split across the employee's own accounts (one is the remainder) |
| `POST /employees/:eid/ytd-import` | opening balances for someone paid elsewhere earlier this year |
| `PUT`, `GET /payment-setup` | how payments are sent: the employer's bank details, SFTP settings (the private key is never returned) |
| `POST …/pay-runs/:rid/prepare-payment` | employer-bank mode: build the payment file for the employer to release at their bank |
| `POST /ach/files/:fid/released`, `…/cancel`, `…/deliver` · `POST /ach/returns` | employer-bank mode: confirm release, withdraw before release, retry SFTP delivery, upload the bank's return file |
| `POST /bank-links`, `POST /bank-links/complete` | link a bank through Stripe; supply the account and routing number |
| `POST /bank-accounts/manual` · `GET /bank-accounts` · `POST …/:bid/refresh`, `…/disable` | manual employee accounts (verified by prenote); list; re-check ownership |
| `PUT /funding/account` · `GET`, `POST /funding/authorization` | the employer's debit account and authorization |
| `POST /ach/prenotes` · `GET /ach/files`, `…/:fid`, `…/:fid/content` | zero-dollar verification entries; the files Totali built |
| `POST`, `GET /shifts` · `POST /shifts/bulk` · `DELETE /shifts/:sid` · `PUT /house-days` | time, tips, sales, break violations, counted tip jar, service charges. Bulk is all-or-nothing |
| `POST`, `GET /pay-runs` · `GET …/:rid` | draft and read runs |
| `POST …/:rid/recalculate`, `approve`, `void`, `fund`, `disburse` · `GET …/:rid/timeline`, `…/legs` | the lifecycle |
| `GET …/:rid/paychecks/:eid/stub` | a pay stub (JSON, or `?format=text`) |
| `GET /ledger` | the double-entry ledger |
| `GET /reports/tips?from&to` | monthly tip-reporting flags, FICA tip credit by month, Form 8027 headcount test |
| `GET /tax/tip-split?year&quarter` | Form 941 line 5a/5b and W-2 box 7 |
| `GET /tax/{validate,liabilities,deposits,941,940,w2,payments,state}` | MasteryTax. `validate` is the independent re-check |
| `POST`, `GET /tax/recorded-deposits` | deposits the company made, so MasteryTax can match them to what was due |

Under `/v1/ops` (admin only: what the bank tells Totali, which a company must never be able to assert): `POST /ach/files/:fid/accepted`, `…/rejected`, `POST /ach/returns` (the return file as the body), `POST /pay-runs/:rid/funds-received`, `POST /ach/advance`, `POST /companies/:cid/bank-accounts/:bid/activate`, `POST /rotate-data-key`, `GET /ach/files`.

## Layout

```
src/industries/   the catalog and the restaurant niches (roles, tip policy, sourced checklist)
src/restaurant/   overtime, wages, tip credit, tip distribution, tip reporting, reports
src/payroll/      pay run (draft, approve, void) and pay stubs
src/banking/      bank links through Stripe, verification, the employer's debit authorization
src/column/       Column (a bank with an API): sends each payment, reads settlement and returns back, so every employer's bank works
src/bankapi/      bank API adapters (J.P. Morgan) used only after a named person approves the exact file in Totali
src/banks/        per-bank profiles (what each bank publishes about ACH files) and the checks that apply them
src/ach/          NACHA files (build and parse), return codes, SFTP delivery, submitter interface, simulated bank
src/money/        the ACH state machine, the ledger, the Stripe client (bank linking only)
src/tax/          MasteryTax adapter, the 941/W-2 tip split
src/domain/       companies, employees, shifts, auth, key rotation
src/store/        transactional document store on SQLite
src/api/          HTTP server, rate limiter
engine/           vendored tax engine   (do not edit; see below)
masterytax/       vendored MasteryTax   (do not edit; see below)
test/             Totali's tests; fake-stripe.ts is an in-memory Financial Connections
scripts/          sync-upstream.sh, check-stripe.ts
docs/
```

## Vendored code

`engine/` and `masterytax/` are copies, pinned to the commits in `engine/UPSTREAM` and `masterytax/UPSTREAM`, so this repo deploys on its own. Fix tax data upstream, then:

```bash
scripts/sync-upstream.sh ../payroll-tax-engine- ../Masterysx-thing-
npm test && npm run test:vendored
```

The engine's rates need a yearly update each January (its own `AGENTS.md` has the procedure). `engine/bridge.ts` and `engine/locate.ts` are MasteryTax's. `scripts/vendored-engine-tests.txt` lists the upstream tests that run inside this layout; the rest need upstream's site and API code.
