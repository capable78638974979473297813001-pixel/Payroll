# What is not done, what needs a person, and what was not verified

This is the list to read before real money moves. It is written to be accurate, not reassuring.

## What was and was not tested

- **Tested:** Totali's own logic (208 tests) and the vendored engine's suites (2,107 tests). The ACH flow runs against a simulated bank on a simulated clock: debit, bank confirmation, hold, credits, returns, rejections, crashes mid-flight, split deposits. The NACHA writer is checked by a parser that recomputes every control total. The Stripe client is tested against a local fake server and an in-memory fake. Key guards (the hold, never paying twice, the amount check) were each broken on purpose to confirm a test fails.
- **SFTP delivery has never talked to a real server.** This machine has no `sftp` client, so the tests check the exact command Totali would run through a stand-in. Try it against one real bank's test endpoint first. PGP-encrypted files, password login and post-upload renames are not supported.
- **Not tested: anything against real Stripe, or any real bank.** Stripe request shapes follow its documentation, read 2026-10-29. The ACH files follow the NACHA record layout from my knowledge of it and are self-consistent, but no bank's file validator has seen one. Expect a real bank to reject something on the first file, and plan for that.
- **Verified against primary sources on 2026-10-29** (each checklist item carries its own source and a `verified` flag; `false` means it was not checked): California overtime (DIR), Nevada overtime (NRS 608.018), Alaska overtime (AS 23.10.060), Colorado overtime (7 CCR 1103-1), New York spread-of-hours and call-in pay (12 NYCRR 146-1.5, 146-1.6), IRS rules on tip reporting (Pub. 531), Form 8027, Form 8846 and service charges, the Federal Reserve holiday rule, and Stripe's Financial Connections documentation.
- **Not verified:** card-tip payout timing and card-fee deduction rules, youth-work rules, workers' compensation class codes, I-9 timing, California wage statements, Oregon predictive scheduling, the Nacha third-party-sender requirements, and how an approved business retrieves full account numbers from Stripe. Whatever the checklist says about those is a prompt to ask a specialist.
- **Alaska:** a 2021 bill (HB 201) proposed rewording the statute; I could not confirm whether it passed. **Colorado:** I could not confirm which COMPS Order number is current.

## Needs a person, a lawyer, a bank, or Stripe — not code

In the default **employer-bank mode** the employer's own bank sends the money, so items 1 and 2 below apply only if you later choose Totali-sent mode.

1. **(Totali-sent mode only) A bank that will take Totali's ACH files.** Without a sponsoring bank, nothing leaves Totali in that mode. Expect the bank to underwrite Totali and, probably, each employer; to set exposure limits; and to have its own rules for a third-party sender.
2. **(Totali-sent mode only) A way to get files to that bank and the bank's reports back.** An adapter for your bank (SFTP, file drop or API), or a person doing it by hand through the outbox and the admin endpoints.
   **In employer-bank mode,** each employer needs a business bank account with ACH origination and (for automatic delivery) a bank that offers SFTP. See [BANK-FILE-DELIVERY.md](BANK-FILE-DELIVERY.md): no published count exists, banks enable it per customer, setup can take weeks, and some banks are dropping file delivery for new customers.
3. **Stripe's approval for full account numbers**, if you want employers and employees not to type them. Otherwise the typed-number design stays.
4. **Holding other people's money is regulated.** Between the employer's debit and the employees' credits, and for tax money until it is remitted, Totali's settlement account holds funds that belong to others. Money-transmitter licensing, trust-account rules, and the difference between a payroll provider and a PEO vary by state. Get counsel before the first live payroll.
5. **The employer's debit authorization wording** is a draft. A lawyer has to approve it, and it has to be shown to the employer before they accept.
6. **Tax remittance has no rail yet.** See [MONEY.md](MONEY.md).
7. **Bad-debt exposure.** Totali pays employees after the debit settles plus a hold. If the debit comes back later (a business-account debit can be returned within about two banking days, or later for some codes), Totali is out the net pay. Underwriting, limits and reserves are business decisions this code supports with a hold and a ledger, not replaces.
8. **Employer KYB, terms of service, privacy policy, breach plan, SOC 2.** None exist.

## Not built

- **A networked database.** Persistence is SQLite in one process: durable and transactional, fine for a pilot, not for scale or two servers. `src/store/store.ts` is the seam.
- **No front end, no login for people.** API keys only. No employee self-service.
- **No e-filing.** Returns are computed lines. Nothing is sent to the IRS, SSA or a state.
- **Form 8027 and Form 8846** are flagged and estimated, not prepared. Box 8 (allocated tips) is 0.
- **W-2 box 12 split.** Uncollected tax on tips is recorded as one amount; the codes A (Social Security) and B (Medicare) need the order the employer collected them in.
- **Earlier-provider history.** Opening balances can be loaded so wage-base caps are right (`POST /employees/:id/ytd-import`), but earlier wages do not flow into Totali's W-2 or quarterly returns; those need the earlier provider's records.
- **POS and time-clock integrations**, multiple locations, an employee in two states in one period, effective-dated pay rates inside a period (set `rateCentsPerHour` on the shifts affected).
- **Bank API adapters** (Level 3 in BANK-FILE-DELIVERY.md): none exist. **Reading bank reports automatically** (acceptance, returns, settlement): in employer-bank mode the employer uploads the return file and says when they released the file.
- **Same-day ACH**, non-US accounts, instant payments.
- **Engine modules vendored but not wired:** garnishments, PTO and paid sick leave, benefits and ACA, workers' comp premiums, new-hire reporting, I-9, contractors (1099), California wage statements.
- **Industries other than restaurant.**
- **Totali's own pricing and fees.** The run funds exactly what it needs; there is no platform fee line.

## Known modelling limits

- **Overtime.** Weekly 40 hours everywhere; California daily, double time and seventh day; Alaska and Nevada daily; Colorado daily and weekly. Not modelled: Alaska's small-employer exemption, Nevada's four-ten agreement, Colorado's 12-consecutive-hours test across split shifts. A Nevada workday is treated as the calendar day a shift began. Regular rate counts straight-time wages and tip credit only: nondiscretionary bonuses and service charges do not feed it.
- **Tip credit.** The 80/20 dual-jobs rule is not evaluated (the engine module says the same). A tip credit is taken only for roles marked "customarily tipped", only with a notice date on file, and only where the state allows one.
- **New York call-in pay** applies on any day an employee worked less than the minimum, whatever the reason; the regulation text I read lists no exceptions, but I did not check for ones elsewhere. A "regularly scheduled shift" is whatever `scheduledMinutes` says.
- **Card fees on tips** are passed on only if the company turns on `cardFeeDeductionBps`; whether that is lawful is state law Totali does not check.
- **Cash tips** the employee kept are taxed but never paid out. When their tax exceeds the cash pay left, the shortfall is recorded as uncollected and flagged.
- **Tip-outs** are taken only from card tips. A tip-out larger than the card tips is capped and flagged.
- **Pay periods that split a workweek** (semi-monthly, monthly) compute a split week's regular rate and make-up in the run that holds its last day. Weekly and biweekly periods that start on the company's workweek avoid this.
- **Salaried staff** are checked against the federal salary level only. Duties, and states with a higher level (California, New York, Washington and others), are not tested. Hire or termination mid-period is not prorated.
- **Region.** New York and Oregon have regional minimum wages. If `settings.region` is not set, the statewide baseline is used and a review issue says so.
- **The $20 monthly tip-report threshold** is totalled from the tips recorded on each person's own shifts, not tip-outs received or pool shares.
- **Minimum wage and tax data** come from the engine at the pinned commit and need the engine's yearly update.
- **Rate limiting** is per process, by client address.
