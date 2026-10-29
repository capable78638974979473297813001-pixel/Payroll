# How money moves

There are two ways a payroll's money can move, chosen per company (`PUT /payment-setup`). Stripe is used in both for one thing only: connecting to people's banks.

| | **Employer-bank mode** (the default) | **Totali-sent mode** |
| --- | --- | --- |
| Who sends the money | The employer's own bank | Totali, through its own sponsoring bank |
| What Totali does | Writes the payment file with the employer's bank's details. Never touches the money. | Debits the employer, holds the funds, pays employees, tracks everything in a ledger |
| Needs | The employer's bank to offer business ACH. Nothing from Totali's side. | A sponsoring bank for Totali, registered as a third-party sender |
| Who approves | The employer, at their own bank, every time | The employer, once, with a debit authorization |
| Taxes | The employer pays them from their own account | Totali holds the money; paying the agencies is not built |
| Who can switch a company to it | Anyone | Totali staff only |

## Employer-bank mode

```
Totali ──► payment file (credits only, the employer's bank's ids in the header)
            ├─ download ──► the employer imports it in their bank's ACH service
            └─ SFTP ──────► delivered to the bank's server (where the bank supports it)
                              │
              the employer approves it at THEIR bank  (Totali never releases a payment)
                              │
       the employer tells Totali "released" ──► payments take effect on the file's date ──► run complete
```

- **Setup:** the employer's bank's routing number and name, the immediate-origin id and 10-character company id the bank assigned, optionally a file-name rule and SFTP details. See [BANK-FILE-DELIVERY.md](BANK-FILE-DELIVERY.md) for which banks do this, and what to ask them.
- **`POST /pay-runs/:id/prepare-payment`** builds the file for approved runs. It pays net pay only and says how much the employer needs in their account, and what they pay themselves (employee taxes withheld, employer taxes, deductions held).
- **No debit, no hold, no ledger.** The money never passes through Totali, so there is nothing to book. A return changes the run and raises an alert, nothing more.
- **Release and cancel** are the employer's calls: `POST /ach/files/:id/released` (with who approved it) and `…/cancel` (before release). Cancelling returns the run to approved so a new file can be made.
- **Returns:** the employer uploads the bank's return file (`POST /ach/returns`). It can only affect that company's own payments. The effect is the same as in Totali-sent mode: the leg is returned, a bad account is disabled, the employee's net pay is owed again, and the next prepare sends only what is outstanding.
- **Prenotes** for employee accounts entered by hand go in the same kind of file and are released the same way.
- **Never pays twice:** the same planner as Totali-sent mode decides what is still owed, so a second prepare covers only employees who were not paid.

The rest of this document describes the parts both modes share and Totali-sent mode in full.

## What Stripe does and does not give us

Stripe's documentation (read 2026-10-29) says account numbers from Financial Connections are **tokenized** and work only for ACH on Stripe; **full account numbers for ACH outside Stripe are available only to businesses that meet Stripe's risk and eligibility criteria**. The account object has an `account_numbers` field that says whether a number is `account_number` or `tokenized_account_number`, but I could not find how an approved business retrieves the full number, so nothing here guesses at it.

So Totali works without it:

1. Stripe confirms the account: it is active, checking or savings, belongs to the Stripe customer Totali created for that owner, and ends in a given four digits.
2. The account holder types the full account and routing number.
3. Totali accepts it only if its last four digits equal what Stripe confirmed and the routing number passes its check digit. The number is encrypted at once and never returned by the API.
4. If the bank reports the account's owners, their names must match the company or the employee. If it does not, an employee's account is verified by a zero-dollar prenote instead; a company's account waits to be re-checked or verified by Totali staff.

If Stripe approves you for full numbers, `BankService.completeLink` in `src/banking/accounts.ts` is the one place that changes: use Stripe's number in place of the typed one, and keep every other check.

Stripe live mode also needs a completed Financial Connections registration in the Dashboard before balances and ownership are returned.

## Totali-sent mode: the flow

```
Mon  employer approves the run ──fund──► debit file (one CCD entry for everything the run needs)
Tue  debit settles ─────────────────────► the bank tells you the money arrived: POST /v1/ops/pay-runs/:id/funds-received
Wed  ┐ hold: the employer's bank can still return the debit (two banking days by default)
Thu  ┘
Thu  disburse ──► credit file (one PPD entry per employee account)
Fri  credits settle on their effective date, the run is complete
```

Dates are banking days: weekends and Federal Reserve holidays are skipped (a Saturday holiday does not move to Friday; a Sunday holiday moves to Monday). `GET /pay-runs/:id/timeline` says when each step lands. If the check date cannot be reached (it is too soon), `fund` refuses unless the caller sends `acceptLate: true`, and a late payment is recorded as an alert.

**What the debit covers:** net pay, employee taxes withheld, employer taxes, and deductions held. Only net pay leaves. Taxes and deductions stay in Totali's settlement account and in the ledger as `tax_withheld`, `tax_employer` and `deductions_held`.

## Rules the code holds to

- **Nothing is paid until the bank has confirmed the funds arrived**, and then only after the hold. Confirmation is an **admin-only** call. A company cannot confirm its own funds. (`TOTALI_TRUST_SETTLEMENT_DATE=1` makes a debit settle on its effective date with no confirmation; it is off, and should stay off unless your bank's reporting makes that safe.)
- **The debit needs the employer's authorization**: who accepted which text, for which account, when and from where. An authorization for one account does not cover another, and changing the funding account clears it. Debits come only from business accounts. The authorization wording in `src/banking/authorization.ts` is a draft for counsel to review.
- **A leg and its file are created in one transaction**, with the trace number that will come back on any return. A crash before the file is handed over leaves a file in `created` that the next reconcile hands over. The same payroll is never built twice, so it cannot be debited twice; the same employee is never paid more than their approved net pay.
- **A file is `accepted` only when the bank acknowledges it** (admin-only call, or an adapter that does it for you).
- **Returns undo exactly what the leg did.** Matched by trace number, idempotent, and recorded in the ledger.
- **The ledger is double-entry** and refuses an unbalanced entry. After a completed run, `employee_net_pay` is zero and `bank_cash` equals the tax and deduction money still held.
- **A balance check before the debit.** If Stripe reports a fresh balance below the debit, nothing is debited. A stale or missing balance does not block it, and the leg records that it was not checked.
- **Everything sensitive is encrypted at rest**: SSNs, account numbers and the stored ACH files. The key can be rotated.

## When things go wrong

| Event | What Totali does |
| --- | --- |
| Bank rejects a file | legs `failed`; a debit's run returns to `approved`; fund again (new file, new trace numbers) |
| Employer debit returned before funds were confirmed | leg `returned`; run back to `approved`; nothing was paid |
| Employer debit returned after employees were paid | leg `returned`; ledger shows `bank_cash` negative by exactly the net pay already sent; alert `debit_returned_after_payout`. **A person has to recover that money.** |
| Return code R29, R10, R07 etc. (unauthorized) | as above, plus the employer's account is disabled and the authorization revoked |
| Return code R01 / R09 (insufficient funds) | the account is kept; the run can be funded again |
| Employee credit returned (R02, R03, R04…) | leg `returned`; ledger reversed; the account is disabled; their net pay is owed again; the next `disburse` pays only them, to a working account |
| Notification of change (C01…) | the account is held (`needs_update`) until a person applies the corrected details |
| Prenote returned | the account is disabled and never receives real money |
| Employee has no working account | their pay stays in `employee_net_pay`; they are listed as waiting; `disburse` again once they are set up |

Return reason codes are in `src/ach/returns.ts`. A code not in the table is treated as needing a person.

## Handing files to the bank

`AchSubmitter` (`src/ach/submitter.ts`) is the interface. How a file reaches a bank depends on the bank: a secure file drop, an SFTP server, or an API. Totali does not pick for you.

- **Default (`TOTALI_ACH_MODE=outbox`)**: files are written to `TOTALI_ACH_OUTBOX` (0600 files in a 0700 directory, because they contain account numbers) and marked `queued`, never `accepted`. Whatever carries them to the bank, someone records the bank's acknowledgement: `POST /v1/ops/ach/files/:id/accepted`.
- **Your bank's adapter**: implement `submit()`, return `accepted` only when the bank has acknowledged the file. Everything else already works.
- **`TOTALI_ACH_MODE=sandbox`**: a simulated bank for development. It is refused when `NODE_ENV=production`.

What the bank reports back, all admin-only: file acceptance or rejection, funds received (`POST /v1/ops/pay-runs/:id/funds-received`, with the exact amount), and return files (`POST /v1/ops/ach/returns` with the file text). A bank adapter that reads the bank's reporting can call the same service methods.

**Third-party sender.** Nacha's rules treat a company that sends ACH files to a bank on behalf of other businesses as a third-party sender, and banks have requirements for that: agreements, registration, risk assessment, audits, and data-security rules. I did not verify those requirements; ask your bank what it needs before the first file.

## Taxes

Totali collects the tax money and tracks it, and MasteryTax says what is due and when. It does **not** pay the IRS or any state. Now that Totali originates ACH itself, remitting is possible in principle: federal deposits can be made by ACH credit with a tax-payment addendum, and states have their own portals and formats. I did not build or verify that. Until it exists, a person or a licensed provider pays the agencies, and the company records each payment with `POST /tax/recorded-deposits`.

## Setting up (test mode first)

1. `STRIPE_SECRET_KEY=sk_test_...`: a test key. Enable Financial Connections in the Dashboard.
2. Get from your bank: the ODFI routing number and name, your immediate-origin id and your company id. Set `TOTALI_ODFI_ROUTING`, `TOTALI_ODFI_NAME`, `TOTALI_ORIGIN_ID`, `TOTALI_ORIGINATOR_COMPANY_ID`.
3. Set `TOTALI_ADMIN_TOKEN`, `TOTALI_DATA_KEY`, `TOTALI_DATA_FILE`.
4. `npm run check:stripe`.
5. Start with `TOTALI_ACH_MODE=sandbox` and run a small payroll start to finish, including a simulated return (`SandboxBank.returnFile` in `src/ach/sandbox.ts`).
6. Only then switch to `outbox` with your bank's real credentials, and start with one tiny payroll.
