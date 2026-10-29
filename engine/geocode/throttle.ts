/**
 * A request spacer that holds under concurrency.
 *
 * The obvious version — read the last-request timestamp, sleep until the
 * interval has passed, then write the timestamp — is wrong when calls overlap:
 * every concurrent caller reads the same timestamp, sleeps the same time, and
 * they all fire together (measured with a 100 ms interval: gaps of 101, 0 and
 * 0 ms). Here each caller reserves its slot synchronously, before any await,
 * so the second caller's slot is the first's plus the interval, and so on.
 */
export function createThrottle(): (minIntervalMs: number) => Promise<void> {
  let nextSlot = 0;
  return async (minIntervalMs: number): Promise<void> => {
    const now = Date.now();
    const start = Math.max(now, nextSlot);
    nextSlot = start + Math.max(0, minIntervalMs);
    if (start > now) await new Promise((resolve) => setTimeout(resolve, start - now));
  };
}
