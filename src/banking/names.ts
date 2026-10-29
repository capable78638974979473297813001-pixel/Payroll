/**
 * Does the bank say the account belongs to who we expect? Compares the
 * significant words of the expected name against each owner the bank
 * reports. Order, punctuation, case, initials and company suffixes are
 * ignored; joint accounts (extra owners) are fine. It is a check against
 * typing someone else's account in, not an identity proof.
 */

const STOP = new Set(['llc', 'inc', 'incorporated', 'corp', 'corporation', 'co', 'company', 'ltd', 'lp', 'llp', 'pllc', 'pc', 'dba', 'the', 'and', 'of', 'jr', 'sr', 'ii', 'iii', 'iv', 'tr', 'trust', 'est', 'estate']);

export function nameTokens(name: string): Set<string> {
  const out = new Set<string>();
  for (const raw of name.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/)) {
    if (raw.length < 2 || STOP.has(raw)) continue;
    out.add(raw);
  }
  return out;
}

export function ownerNamesMatch(expected: string, owners: readonly string[]): 'match' | 'mismatch' | 'unavailable' {
  const clean = owners.map((o) => o.trim()).filter(Boolean);
  if (clean.length === 0) return 'unavailable';
  const want = nameTokens(expected);
  if (want.size === 0) return 'unavailable';
  for (const owner of clean) {
    const have = nameTokens(owner);
    if (have.size === 0) continue;
    const [small, big] = want.size <= have.size ? [want, have] : [have, want];
    if ([...small].every((t) => big.has(t))) return 'match';
  }
  return 'mismatch';
}
