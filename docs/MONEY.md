# How money moves

Totali moves money through Stripe with `STRIPE_SECRET_KEY`. It never touches a bank account number: the employer links a bank through Stripe Financial Connections, and each employee enters their own bank on a Stripe-hosted page. Totali stores Stripe ids and the last four digits.

## The flow

```
employer's bank ──ACH debit (PaymentIntent, us_bank_account)──► platform Stripe balance
                                                                      │
                          after the debit SUCCEEDS and a hold passes  │
                                                                      ▼
              each employee's connected account ◄── Stripe transfer (one per employee)
                         │
                         ▼  Stripe payout on the account's own schedule
                  employee's bank
```

| Step | Call | Totali records |
| --- | --- | --- |
| Link employer bank | Customer + SetupIntent (`us_bank_account`), finished in Stripe.js | `setup_intent.succeeded` → company `funding.status = ready` |
| Onboard employee | Express connected account (`transfers`) + hosted Account Link | `account.updated` → `payout.status = ready` |
| Fund a run | PaymentIntent, `confirm`, `off_session`, amount = everything the run needs | funding leg; ledger entry on `payment_intent.succeeded` |
| Pay employees | one Transfer per employee, amount = their approved net pay | payout legs; ledger entry per transfer |

**What "funded" covers:** net pay, employee taxes withheld, employer taxes, and deductions held. Only net pay leaves. The taxes and deductions stay in the platform balance and in the ledger as `tax_withheld`, `tax_employer` and `deductions_held`.

## Rules the code holds to

- **Nothing is paid before the debit has succeeded**, and then only after a hold (`TOTALI_ACH_RETURN_HOLD_HOURS`, default 48). Stripe documents that an ACH debit can fail or be disputed after it shows `succeeded`: for a *business* bank account within about two business days, for a *personal* account up to 60 days. A sole proprietor who links a personal account is exposed for the longer window, and 48 hours does not cover it.
- **Every Stripe call that moves money has a stable idempotency key** (`totali_fund_<run>_a<n>`, `totali_payout_<run>_<employee>_a<n>`). The leg is written to the store *before* the call. A crash, a timeout or a retry reuses the key, so Stripe returns the first result and the money moves once. A failed leg retries with the next attempt number, because Stripe replays a stored failure for a reused key.
- **A leg is `succeeded` only when Stripe says so.** A dropped connection leaves it open; the next call resumes it.
- **Transfers are sized from the approved run**, never recomputed. A Stripe amount that does not match is treated as a failure, not as funded.
- **The platform balance is checked** before a disbursement. If it is short, nothing is sent.
- **The ledger is double-entry** and refuses an unbalanced entry. After a full run, `employee_net_pay` is zero and `stripe_cash` equals the tax and deduction money still held.
- **A live key is refused** unless `STRIPE_ALLOW_LIVE=1`. Start with `sk_test_`.
- **Webhooks are signature-verified** against the raw body with a 5-minute tolerance, and de-duplicated by event id. A 60-second reconcile loop re-checks anything a lost webhook left behind.

## When things go wrong

| Event | What Totali does |
| --- | --- |
| Debit declined or fails | funding leg `failed`; run returns to `approved`; fund again (new key) after fixing the bank |
| Debit returned **before** payout | leg `reversed`; ledger reversed; run back to `approved`; alert; nothing was sent |
| Debit returned **after** payout | leg `reversed`; ledger shows negative `stripe_cash` equal to the net pay already sent; alert `ach_return_after_payout`. **A person has to recover that money.** |
| Transfer rejected (account restricted) | that leg `failed`, others proceed; call disburse again after the employee fixes their account |
| Transfer reversed | leg `reversed`; ledger reversed; alert |
| Employee has no bank connected | their pay stays in `employee_net_pay`; they are listed as waiting; disburse again once they finish onboarding |
| `payout.failed` on an employee's account | their payout status becomes `restricted` |

## Taxes are collected but not remitted

Totali holds the tax money and tells you what is due and when (MasteryTax's deposit calendar and payment instructions, marked NOT TRANSMITTED). It does **not** pay the IRS or any state. Federal deposits go through EFTPS and state deposits through each agency's portal; those rails want ACH credits with specific addenda or a portal login. I could not confirm that Stripe can originate those, so assume it cannot until Stripe says it can. Until remitting is built, a person or a licensed provider has to pay the agencies, and the company records each payment with `POST /tax/recorded-deposits`.

## Setting up Stripe (test mode first)

1. Create a test-mode secret key and a webhook endpoint pointing at `https://<host>/v1/webhooks/stripe`. Subscribe it to: `setup_intent.succeeded`, `payment_intent.processing`, `payment_intent.succeeded`, `payment_intent.payment_failed`, `payment_intent.canceled`, `charge.dispute.created`, `transfer.reversed`. For connected accounts, add a second **Connect** endpoint to the same URL with `account.updated` and `payout.failed`.
2. Enable Connect and ACH Direct Debit on the account.
3. Set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (the `whsec_` value, or both values comma-separated), `TOTALI_ADMIN_TOKEN`, `TOTALI_DATA_KEY` where the server runs.
4. `npm run check:stripe`.
5. Link a test bank with Stripe's test accounts (`000123456789` / routing `110000000` succeeds), onboard a test employee, run a small payroll. In test mode ACH settles instantly; live it takes about four business days.

Stripe issues a separate signing secret for each webhook endpoint. Put both in `STRIPE_WEBHOOK_SECRET`, separated by a comma; an event is accepted if it matches any of them.
