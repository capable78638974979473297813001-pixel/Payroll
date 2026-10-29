# What is not done, what needs a person, and what was not verified

This is the list to read before real money moves. It is written to be accurate, not reassuring.

## What was and was not tested

- **Tested:** Totali's own logic (113 tests) and the vendored engine's suites (2,107 tests). The Stripe client is tested against a local fake HTTP server and an in-memory fake Stripe. The MasteryTax integration runs the real Python package against real registers.
- **Not tested: anything against real Stripe, even test mode.** Request shapes follow Stripe's documentation as of this build. Run `npm run check:stripe` and a small test-mode payroll before trusting any of it. Expect to adjust something.
- **Not verified against primary sources:** the compliance checklist text (`src/industries/restaurant.ts`) and the California overtime rule (`src/restaurant/overtime.ts`) were written from general knowledge of the rules, not re-read from the statutes and agency pages. The tip-credit, minimum-wage and tax-rate code comes from the vendored engine, whose authors verified it against agency sources (see `engine/`). Have a payroll or wage-and-hour specialist review the restaurant rules before relying on them.

## Needs a person, a lawyer, or Stripe — not code

1. **Stripe has to approve this use.** Stripe's restricted-business list (read at build time) restricts money transmitters and prohibits paying payroll through Issuing cards. It does not name payroll processing, but paying other people's wages out of a platform balance is close enough to money transmission that you should ask Stripe in writing before going live, and expect due diligence.
2. **Holding other people's money is regulated.** Between the employer's debit and the employee's transfer, and for tax money until it is remitted, Totali's platform balance holds funds that belong to others. Money-transmitter licensing, trust-account rules, and the difference between a payroll provider and a PEO vary by state. Get counsel before the first live payroll.
3. **Employee accounts.** Express connected accounts under Stripe's default agreement are what the code creates. Stripe's `recipient` service agreement is "available in select countries"; whether it covers US-to-US wages is unconfirmed, so it is an opt-in (`STRIPE_CONNECT_SERVICE_AGREEMENT=recipient`). Ask Stripe which model fits W-2 employees. Stripe-hosted onboarding will ask each employee for identity details, which they may not expect from an employer's payroll.
4. **Tax remittance has no rail yet.** See [MONEY.md](MONEY.md). Until built, someone pays the agencies by hand.
5. **Bad-debt exposure.** The platform pays employees after an ACH debit succeeds plus a hold. If the debit comes back later, the platform is out the net pay. Underwriting employers, limits, and reserves are business decisions this code only supports with a hold and a ledger.
6. **Employer KYB, terms of service, ACH authorisation language, privacy policy, breach plan, SOC 2.** None exist.

## Not built

- **Persistence is one JSON file in one process.** Atomic and transactional (see `src/store/store.ts`), fine for a pilot, not for scale or two servers. The store is the seam for Postgres.
- **No front end, no login for people.** API keys only. No employee self-service, no pay stubs as documents (the data is there), no e-sign.
- **No e-filing.** Returns are computed lines. Nothing is sent to the IRS, SSA or a state.
- **Tips on the 941 and W-2.** MasteryTax reports tips inside wages: there is no 941 line 5b split and no W-2 box 7 (Social Security tips) or box 8 (allocated tips). Total tax is right; the presentation is not. Uncollected FICA on tips (W-2 box 12, codes A and B) is recorded on the paycheck but not carried into MasteryTax's W-2.
- **Form 8027 and Form 8846** are flagged and estimated, not prepared.
- **Mid-year start.** No year-to-date import, so a company that starts mid-year gets Social Security and unemployment wage bases wrong until it is loaded. Needs an import endpoint.
- **POS and time-clock integrations**, multiple locations, an employee in two states in one period, effective-dated pay rates inside a period.
- **Other engine modules are vendored but not wired:** garnishments, PTO and paid sick leave, benefits and ACA, workers' comp premiums, new-hire reporting, I-9, contractors (1099). Some are listed in the checklist as `coveredBy`; that means the code exists upstream, not that Totali calls it yet.
- **Industries other than restaurant.** Construction and trades (prevailing wage, certified payroll) exists in the Crewtally codebase and is not folded in.
- **Totali's own pricing and fees.** The run funds exactly what the run needs; there is no platform fee line.
- **Rate limiting, request logging, audit trail of who changed what.**
- **Key rotation** for `TOTALI_DATA_KEY` (stored ciphertexts are tagged `v1`).

## Known modelling limits in the restaurant rules

- **Overtime:** weekly 40 hours everywhere; California daily, double time and seventh day. Alaska, Nevada and Colorado have daily rules that are **not** modelled; every run for those states raises a review issue. Regular rate counts straight-time wages and tip credit only: nondiscretionary bonuses and service charges do not feed it.
- **Tip credit:** 80/20 dual-jobs rule is not evaluated (the engine module says the same). A tip credit is taken only for roles marked "customarily tipped" and only with a notice date on file.
- **Cards fees on tips** are passed on only if the company turns on `cardFeeDeductionBps`; whether that is lawful is state law Totali does not check.
- **Cash tips** the employee kept are taxed but never paid out. When their tax exceeds the cash pay left, the shortfall is recorded as uncollected and flagged.
- **Tip-outs** are taken only from card tips. A tip-out larger than the card tips is capped and flagged; the remainder is settled in cash outside payroll.
- **Pay periods that split a workweek** (semi-monthly, monthly) compute a split week's regular rate and make-up in the run that holds its last day. Weekly and biweekly periods that start on the company's workweek avoid this.
- **Salaried staff** are assumed exempt; their duties and salary level are not tested, and hire or termination mid-period is not prorated (a review issue says so).
- **Region.** New York and Oregon have regional minimum wages. If `settings.region` is not set, the statewide baseline is used and a review issue says so.
- **Minimum wage and tax data** come from the engine at the pinned commit and need the engine's yearly update.
