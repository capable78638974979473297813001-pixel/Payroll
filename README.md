# Totali backend

Totali is an all-in-one payroll app that comes as a different app for each kind of business. You pick **Restaurant → Full-service** and the company starts with that niche's roles, tip rules, pay rules and compliance checklist. This repo is the backend.

Restaurant is built end to end, with nine niches: full service, fine dining, quick service, fast casual, café, bar and nightclub, food truck, catering and banquets, pizzeria and delivery. The other industries are in the picker as `planned` and refuse selection until they have a profile.

Three things do the work, and each is a separate codebase this repo vendors:

| Job | Where it comes from | Where it lives here |
| --- | --- | --- |
| Tax math: federal, 50 states + DC, local, minimum wage, tip credit | [`payroll-tax-engine-`](https://github.com/capable78638974979473297813001-pixel/payroll-tax-engine-) | `engine/` |
| Deposits, 941/940/W-2, state wage reports, and an independent re-check of every run | [`Masterysx-thing-`](https://github.com/capable78638974979473297813001-pixel/Masterysx-thing-) (MasteryTax) | `masterytax/` |
| Moving money | Stripe, using `STRIPE_SECRET_KEY` | `src/money/` |

Everything else (the niches, tip and wage rules, pay runs, API) is Totali's own, in `src/`.

**Read [docs/GAPS.md](docs/GAPS.md) before putting real money through this.** Nothing here has run against Stripe. Several things need a person or a lawyer, not code.

## How a payroll run works

```
shifts, tips, sales ──► niche rules ──► earnings ──► tax engine ──► paychecks ──► approve ──► fund ──► disburse
 (POS or manual)        tip-outs,       REG/OT/DT,   federal, state,   issues:      locks      ACH debit   Stripe transfer
                        tip pool,       tips, make-  local, FICA,      blocking /   shifts,    from the    to each employee's
                        service charge, up, service  FUTA, SUI         review /     rolls YTD  employer's  connected account
                        tip credit      charge                         info                    bank
                                                                          │
                                       MasteryTax recomputes the same run independently, then produces
                                       the deposit calendar, Form 941/940, W-2s, state reports
```

- **Niche rules** (`src/restaurant/`): overtime by workweek (federal weekly, plus California daily, double time and seventh day); the tip credit and its per-workweek make-up; tip-outs by role; tip pools by hours or points with managers excluded; mandatory service charges as wages; California meal and rest premiums; cash tips taxed but never paid out. Every step conserves cents, and the tests check it.
- **Issues.** A run reports `blocking` problems (cannot approve), `review` items (Totali made an assumption or does not model a rule; an operator must acknowledge them), and `info`. Totali does not guess a missing fact.
- **Approve** locks the period's shifts and rolls each employee's year-to-date so the next run's wage-base caps are right. An approved run that has not moved money can be voided exactly.
- **Money** is a state machine with a ledger. See [docs/MONEY.md](docs/MONEY.md).

## Run it

Node 22.18+ and Python 3.10+ (MasteryTax). No packages to install.

```bash
cp .env.example .env     # then fill it in; set these in your host's secret store, not in git
npm test                 # Totali: 113 tests, a few seconds
npm run test:vendored    # the vendored engine's own suites (2,107 tests)
npm run check:stripe     # read-only: what is not ready for Stripe
npm start
```

Walk through it with curl:

```bash
B=http://localhost:8787

# 1. the picker
curl $B/v1/industries
curl $B/v1/industries/restaurant/niches/fine_dining

# 2. create a company (admin). The niche's profile is applied. The response carries the company key, once.
curl -X POST $B/v1/companies -H "authorization: Bearer $TOTALI_ADMIN_TOKEN" -H 'content-type: application/json' -d '{
  "legalName":"Corner Table LLC","ein":"12-3456789","industry":"restaurant","niche":"full_service","homeState":"TX",
  "taxAccounts":{"state":{"TX":{"account":"99-887766-5","suiRate":0.0215}}}}'

# 3. with the company key: hire, record shifts with tips, draft a run, review, approve
K=totali_sk_...; C=co_...
curl -X POST $B/v1/companies/$C/employees -H "authorization: Bearer $K" -H 'content-type: application/json' -d '{
  "firstName":"Ana","lastName":"Ruiz","roleKey":"server","hireDate":"2026-01-05","tipCreditNoticeDate":"2026-01-05",
  "payType":{"kind":"hourly","rateCents":213},"ssn":"512-34-1001"}'
curl -X POST $B/v1/companies/$C/shifts -H "authorization: Bearer $K" -H 'content-type: application/json' -d '{
  "employeeId":"emp_...","workDate":"2026-06-01","minutes":360,"chargedTipsCents":8000,"cashTipsCents":2000,"salesCents":60000}'
curl -X POST $B/v1/companies/$C/pay-runs -H "authorization: Bearer $K" -H 'content-type: application/json' -d '{
  "periodStart":"2026-06-01","periodEnd":"2026-06-14","checkDate":"2026-06-19"}'
```

## API

Public: `GET /health`, `GET /v1/industries`, `GET /v1/industries/:id`, `GET /v1/industries/:id/niches/:niche`, `POST /v1/webhooks/stripe` (signature-verified).
Admin: `POST /v1/companies`. A company key reaches only its own company.

Under `/v1/companies/:cid`:

| | |
| --- | --- |
| `GET`, `PATCH /` | company, its niche, its checklist, its editable settings (roles, tip policy) |
| `GET`, `POST /employees` · `GET`, `PATCH /employees/:eid` · `POST /employees/:eid/terminate` | people. SSNs are accepted, encrypted, never returned |
| `POST /employees/:eid/payout/onboarding` | a Stripe-hosted page where the employee enters their own bank details |
| `POST`, `GET /shifts` · `DELETE /shifts/:sid` · `PUT /house-days` | time, tips, sales, break violations, counted tip jar, service charges |
| `POST`, `GET /pay-runs` · `GET /pay-runs/:rid` | draft and read runs |
| `POST /pay-runs/:rid/recalculate`, `approve`, `void`, `fund`, `disburse` · `GET /pay-runs/:rid/legs` | the lifecycle |
| `POST /funding/setup` · `GET /ledger` | link the employer's bank; the double-entry ledger |
| `GET /reports/tips?from&to` | monthly cash-tip reporting flags, FICA tip credit estimate, Form 8027 headcount test |
| `GET /tax/{validate,liabilities,deposits,941,940,w2,payments,state}` | MasteryTax. `validate` is the independent re-check |
| `POST`, `GET /tax/recorded-deposits` | deposits the company made, so MasteryTax can match them to what was due |

## Layout

```
src/industries/   the catalog and the restaurant niches (roles, tip policy, checklist)
src/restaurant/   overtime, wages and tip credit, tip distribution, tip reporting
src/payroll/      pay run: draft, approve, void
src/money/        Stripe client, money state machine, ledger, webhook verification
src/tax/          MasteryTax adapter
src/domain/       companies, employees, shifts, auth
src/store/        transactional document store (single process, JSON file)
src/api/          HTTP server
engine/           vendored tax engine   (do not edit; see below)
masterytax/       vendored MasteryTax   (do not edit; see below)
test/             Totali's tests; fake-stripe.ts is an in-memory Stripe
scripts/          sync-upstream.sh, check-stripe.ts
docs/
```

## Vendored code

`engine/` and `masterytax/` are copies, pinned to the commits in `engine/UPSTREAM` and `masterytax/UPSTREAM`, so this repo deploys on its own. Fix tax data upstream, then:

```bash
scripts/sync-upstream.sh ../payroll-tax-engine- ../Masterysx-thing-
npm test && npm run test:vendored
```

The engine's rates need a yearly update each January (its own `AGENTS.md` has the procedure). `engine/bridge.ts` and `engine/locate.ts` are MasteryTax's, copied from its repo. `scripts/vendored-engine-tests.txt` lists the upstream tests that run inside this layout; the rest need upstream's site and API code.
