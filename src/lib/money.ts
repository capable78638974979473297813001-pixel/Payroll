/** Money is integer cents everywhere in Totali, the same convention as the tax engine. */
export type Cents = number;

export function isCents(n: unknown): n is Cents {
  return typeof n === 'number' && Number.isSafeInteger(n);
}

/** Pay for `minutes` of work at `rateCentsPerHour`, rounded half-up to the cent. Minutes stay integers so hours never drift as floats. */
export function payForMinutes(rateCentsPerHour: number, minutes: number): Cents {
  return Math.round((rateCentsPerHour * minutes) / 60);
}

/** `cents * bps / 10_000`, rounded half-up. Basis points keep percentages integral (150 bps = 1.5%). */
export function applyBps(cents: Cents, bps: number): Cents {
  return Math.round((cents * bps) / 10_000);
}

/**
 * Split `total` across `weights` in proportion, so the parts always sum to
 * exactly `total`. Largest-remainder method; ties go to the lowest index, so
 * the result is deterministic. A zero-weight entry never receives a cent.
 */
export function allocate(total: Cents, weights: readonly number[]): Cents[] {
  if (!isCents(total) || total < 0) throw new RangeError(`allocate: total must be a non-negative integer, got ${total}`);
  if (weights.some((w) => !Number.isFinite(w) || w < 0)) throw new RangeError('allocate: weights must be finite and non-negative');
  const sum = weights.reduce((a, b) => a + b, 0);
  if (weights.length === 0 || sum === 0 || total === 0) return weights.map(() => 0);

  const raw = weights.map((w) => (total * w) / sum);
  const parts = raw.map(Math.floor);
  let remainder = total - parts.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .filter(({ i }) => weights[i] > 0)
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; remainder > 0; k = (k + 1) % order.length) {
    parts[order[k].i] += 1;
    remainder -= 1;
  }
  return parts;
}

export const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);

export function fmtUsd(cents: Cents): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`;
}
