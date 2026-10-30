# Totali app designs

Static HTML mockups for the Totali payroll app. Open [`index.html`](index.html) or [`pages/landing.html`](pages/landing.html) in a browser. Shared CSS, fonts, and photos live in `assets/`. [`pages.json`](pages.json) is the page index. `build.py` regenerates `pages/*.html` from `src/*.py`. `shot.py` writes screenshots with headless Chrome into `out/` (gitignored).

Every page is labeled sample data. Names, tax figures, account numbers, and pay amounts are illustrations for the layout. The pay-run review screen says paying the team happens outside Totali, and the direct-deposit form says it only collects details. These files do not file a return, remit tax, or send a payment.

## Flow

Landing, then create account, email code, and log in. Industry pick, then a question builder whose answers add cards to a live preview. Restaurant plus Michigan is the full sequence (`build-rest-1` through `build-rest-6`). Hotels, trades, office, and delivery each have a base builder screen. After that: one dashboard per industry, then the app pages (run payroll, review, pay stub, employees, onboarding with W-4, I-9, and deposit, time and tips, job costing, settings, company setup, billing, help).

## How the screens sit on this API

This repo is the backend in `src/`. Nothing here serves these pages. The table is the nearest existing route for each screen, from `src/api/app.ts`.

| Screens | Nearest API |
| --- | --- |
| Landing, log in, verify email | API keys only. There is no person login or email code. |
| Create account | `POST /v1/companies` creates the company and returns an API key once. It takes legal name, EIN, `industry`, `niche`, and `homeState` in that one call. |
| Pick your industry | `GET /v1/industries` and `GET /v1/industries/:id`. `restaurant` is `available` (nine niches, including `pizzeria_delivery`). `hotel_lodging` and `construction_trades` are `planned` and refuse selection. The catalog also lists salon, retail, and childcare, which these screens do not. Office, and delivery as its own industry, are absent from the catalog. |
| Question builder | No step-by-step builder. The screens ask questions (state, city, tips, contractors) and never ask for a restaurant niche id. `POST /v1/companies` requires one (`full_service`, `fine_dining`, `quick_service`, `fast_casual`, `cafe_coffee`, `bar_nightclub`, `food_truck`, `catering_banquet`, or `pizzeria_delivery`) and copies that niche's roles, tip policy, and checklist. `checklistFor` keeps items for `homeState`. Later edits are `PATCH /v1/companies/:cid` (settings, tax accounts, pay frequency). Industry, niche, EIN, and home state stay fixed after signup. |
| Dashboards | `GET /v1/companies/:cid` returns the company, niche, and state checklist. Harbor Street Kitchen is the restaurant shape the API can represent. Lakeshore Inn, Northgate Electric, Birch & Lane Studio, and Switchback Delivery are sample layouts for industries the API does not run yet. |
| Run payroll, review | `POST /v1/companies/:cid/shifts`, `POST …/pay-runs`, `POST …/recalculate`, `GET …/pay-runs/:rid`, `POST …/approve`. |
| Pay stub | `GET …/pay-runs/:rid/paychecks/:eid/stub` (`?format=text` for the text form). |
| Employees, profile | `GET` and `POST …/employees`, `GET` and `PATCH …/employees/:eid`. |
| Onboarding, W-4 | Employee create and update accept `federalW4` plus `workState` and `residenceState` withholding. There is no invite link or stored form PDF. |
| I-9 | A restaurant checklist line. The engine's I-9 module is not wired in (see `docs/GAPS.md`). |
| Direct deposit | `PUT …/employees/:eid/payout-accounts` and `POST …/bank-links`. The screen collects sample bank details. It does not send pay. |
| Time and tips | `POST` and `GET …/shifts`, `PUT …/house-days`, `GET …/reports/tips`. |
| Job costing | No route. Construction and trades is `planned`. |
| Settings | `PATCH /v1/companies/:cid` for settings and tax account numbers. |
| Company setup | No route. Employer verification is listed as not built in `docs/GAPS.md`. |
| Billing, help | No route. The API has no platform fee. |

Sample businesses on these pages are layout data. They are not companies in the store.
