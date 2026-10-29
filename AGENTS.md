# AGENTS.md

Totali backend: an industry-specific payroll API (restaurants first). Read `README.md` first, then `docs/MONEY.md` and `docs/GAPS.md`.

## Rules for working here

- **Money is integer cents.** Never a float. Minutes are integers too. Percentages are basis points.
- **Do not edit `engine/` or `masterytax/`.** They are vendored copies pinned in `engine/UPSTREAM` and `masterytax/UPSTREAM`. Fix tax data or tax logic in the upstream repos, then run `scripts/sync-upstream.sh`. Totali code imports the engine from `engine/src` and `engine/payroll`; do not copy tax logic into `src/`.
- **Do not guess a missing fact.** The engine refuses or labels what it cannot compute; Totali does the same with `blocking` and `review` issues (`src/lib/issues.ts`). Add an issue, not a default.
- **A fact has one source.** The state unemployment rate lives in `taxAccounts.state[code].suiRate` and reaches the engine and MasteryTax only through `employerContextFor()`. A duplicate source already caused a real mismatch once.
- **Stripe is for bank linking only.** `src/money/stripe.ts` creates customers and Financial Connections sessions and reads linked accounts; it must never gain a payment, payout, transfer or Connect call (a test fails if it does). Totali moves money itself by ACH.
- **Money movement rules** are in `docs/MONEY.md`. A leg and the file that carries it are created in one `store.tx()`, with the trace number; a leg is `submitted` only when the bank acknowledges its file, `settled` only on the bank's confirmation (debits) or the effective date (credits); post a balanced ledger entry in the same `store.tx()` as the state change. What the bank reports (accepted, funds received, returns) is admin-only: a company must never be able to confirm its own funds. Never hold a `store.tx()` across an `await`.
- **Secrets** come from the environment (`STRIPE_SECRET_KEY` and the rest in `.env.example`). Never write one to a file, a log, a test, or an error message. SSNs, bank account numbers and ACH file contents are encrypted at rest; they are never returned by the API, never logged, never echoed in an error, and never in the audit log (which records no bodies).
- **A rule is checked against its source or labelled.** Checklist items carry `verified` (date and sources) or `false`. When you add a state rule, read the statute or regulation, cite it in the item, and write a test with a hand-computed expectation.
- **No dependencies.** Node's built-ins only, TypeScript run by Node's type stripping: no `enum`, no namespaces, no constructor parameter properties, `.ts` extensions in imports.
- **Tests:** `npm test` (Totali) and `npm run test:vendored` (engine). Add a test with any rule change, with a hand-computed expectation. When you add a money path, add a case to `test/money.test.ts` using `FakeStripe`, and check the test fails if you break the guard it protects.
- **Types:** `npm run typecheck` checks `src/`, `test/` and `scripts/`. The vendored `engine/` has a few type errors of its own upstream (minimum-wage and pension-state); the script hides them and fails only on Totali's code. Node does not type-check at run time, so run it.
