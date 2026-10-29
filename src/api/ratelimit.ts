/**
 * A fixed-window rate limiter keyed by client address, in memory. Two budgets:
 * a general one for every request, and a much smaller one for failed
 * authentication, so guessing API keys is slow. It is per process; behind
 * several servers, put a shared limiter in front.
 */
export class RateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();
  private readonly windowMs: number;
  constructor(windowMs = 60_000) {
    this.windowMs = windowMs;
  }

  /** Count one hit. Returns seconds to wait if the key is over `limit`, else 0. */
  hit(key: string, limit: number, nowMs: number): number {
    if (limit <= 0) return 0;
    let w = this.windows.get(key);
    if (!w || nowMs >= w.resetAt) {
      w = { count: 0, resetAt: nowMs + this.windowMs };
      this.windows.set(key, w);
    }
    w.count += 1;
    if (this.windows.size > 50_000) this.sweep(nowMs);
    return w.count > limit ? Math.max(1, Math.ceil((w.resetAt - nowMs) / 1000)) : 0;
  }

  /** Is the key already over the limit, without counting a hit? */
  blocked(key: string, limit: number, nowMs: number): number {
    const w = this.windows.get(key);
    if (limit <= 0 || !w || nowMs >= w.resetAt) return 0;
    return w.count > limit ? Math.max(1, Math.ceil((w.resetAt - nowMs) / 1000)) : 0;
  }

  private sweep(nowMs: number): void {
    for (const [k, w] of this.windows) if (nowMs >= w.resetAt) this.windows.delete(k);
  }
}
