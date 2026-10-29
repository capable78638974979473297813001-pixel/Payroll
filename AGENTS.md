# AGENTS.md

Totali backend: an industry-specific payroll API (restaurants first). Read `README.md` first, then `docs/MONEY.md` and `docs/GAPS.md`.

## Rules for working here

- **Money is integer cents.** Never a float. Minutes are integers too. Percentages are basis points.
- **Do not edit `engine/` or `masterytax/`.** They are vendored copies pinned in `engine/UPSTREAM` and `masterytax/UPSTREAM`. Fix tax data or tax logic in the upstream repos, then run `scripts/sync-upstream.sh`. Totali code imports the engine from `engine/src` and `engine/payroll`; do not copy tax logic into `src/`.
- **Do not guess a missing fact.** The engine refuses or labels what it cannot compute; Totali does the same with `blocking` and `review` issues (`src/lib/issues.ts`). Add an issue, not a default.
- **A fact has one source.** The state unemployment rate lives in `taxAccounts.state[code].suiRate` and reaches the engine and MasteryTax only through `employerContextFor()`. A duplicate source already caused a real mismatch once.
- **Money movement rules** are in `docs/MONEY.md`. Write the leg to the store before the Stripe call; use the stable idempotency key; mark a leg succeeded only on Stripe's confirmation; post a balanced ledger entry in the same `store.tx()` as the state change. Never hold a `store.tx()` across an `await`.
- **Secrets** come from the environment (`STRIPE_SECRET_KEY` and the rest in `.env.example`). Never write one to a file, a log, a test, or an error message. SSNs are encrypted at rest and never returned by the API or logged.
- **No dependencies.** Node's built-ins only, TypeScript run by Node's type stripping: no `enum`, no namespaces, no constructor parameter properties, `.ts` extensions in imports.
- **Tests:** `npm test` (Totali) and `npm run test:vendored` (engine). Add a test with any rule change, with a hand-computed expectation. When you add a money path, add a case to `test/money.test.ts` using `FakeStripe`, and check the test fails if you break the guard it protects.
- **Types:** `npm run typecheck` checks `src/`, `test/` and `scripts/`. The vendored `engine/` has a few type errors of its own upstream (minimum-wage and pension-state); the script hides them and fails only on Totali's code. Node does not type-check at run time, so run it.
