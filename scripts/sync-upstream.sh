#!/usr/bin/env bash
# Re-vendor the tax engine and MasteryTax into this repo.
#
#   scripts/sync-upstream.sh <path-to-payroll-tax-engine-> <path-to-Masterysx-thing->
#
# engine/        <- payroll-tax-engine- : src/, data/, payroll/, geocode/ (+ the engine tests that only need those)
# engine/bridge.ts, engine/locate.ts <- Masterysx-thing- (the JSON stdin/stdout runner MasteryTax drives)
# masterytax/    <- Masterysx-thing-    : the Python filing/deposit layer
#
# The pinned upstream commits are written to engine/UPSTREAM and masterytax/UPSTREAM.
# After syncing, run `npm test` and `npm run test:vendored`.
set -euo pipefail

ENGINE_SRC="${1:?path to payroll-tax-engine- checkout}"
MASTERY_SRC="${2:?path to Masterysx-thing- checkout}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

rm -rf "$HERE/engine" "$HERE/masterytax"
mkdir -p "$HERE/engine/tests"

for d in src data payroll geocode; do
  cp -R "$ENGINE_SRC/$d" "$HERE/engine/$d"
done
while read -r t; do
  [ -z "$t" ] && continue
  cp "$ENGINE_SRC/tests/$t" "$HERE/engine/tests/$t"
done < "$HERE/scripts/vendored-engine-tests.txt"
[ -d "$ENGINE_SRC/tests/helpers" ] && cp -R "$ENGINE_SRC/tests/helpers" "$HERE/engine/tests/helpers" || true

cp "$MASTERY_SRC/engine/bridge.ts" "$MASTERY_SRC/engine/locate.ts" "$HERE/engine/"
cp -R "$MASTERY_SRC/masterytax" "$HERE/masterytax"
find "$HERE/masterytax" -name __pycache__ -prune -exec rm -rf {} +

git -C "$ENGINE_SRC" rev-parse HEAD > "$HERE/engine/UPSTREAM"
git -C "$MASTERY_SRC" rev-parse HEAD > "$HERE/masterytax/UPSTREAM"
echo "engine   pinned to $(cat "$HERE/engine/UPSTREAM")"
echo "masterytax pinned to $(cat "$HERE/masterytax/UPSTREAM")"
