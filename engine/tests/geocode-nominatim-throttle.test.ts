import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { crossCheckAddress, searchStructuredAddress } from '../geocode/nominatim.ts';

/**
 * Nominatim's usage policy allows one request per second across the whole
 * application. Concurrent callers and the retry path must both stay inside it.
 */

const GAP = 120;
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;

describe('Nominatim request spacing', () => {
  test('six concurrent lookups are spaced, not fired together', async () => {
    const starts: number[] = [];
    const fake = (async () => { starts.push(Date.now()); return ok([]); }) as unknown as typeof fetch;
    await Promise.all(Array.from({ length: 6 }, (_, i) => crossCheckAddress(`${i} Main St`, fake, { minIntervalMs: GAP })));
    starts.sort((a, b) => a - b);
    for (let i = 1; i < starts.length; i++) assert.ok(starts[i]! - starts[i - 1]! >= GAP - 15, `gap ${i}: ${starts[i]! - starts[i - 1]!}ms`);
  });

  test('a retry after a server error waits its turn too', async () => {
    const starts: number[] = [];
    let calls = 0;
    const fake = (async () => {
      starts.push(Date.now());
      calls += 1;
      return calls === 1 ? ({ ok: false, status: 503, json: async () => ({}) } as Response) : ok([]);
    }) as unknown as typeof fetch;
    // A tiny backoff, so only the throttle can account for the spacing.
    await crossCheckAddress('1 Main St', fake, { minIntervalMs: GAP, baseBackoffMs: 1, retries: 1 });
    assert.equal(starts.length, 2);
    assert.ok(starts[1]! - starts[0]! >= GAP - 15, `retry came ${starts[1]! - starts[0]!}ms after the first try`);
  });

  test('a retry does not let another caller jump the queue', async () => {
    const starts: number[] = [];
    let calls = 0;
    const fake = (async () => {
      starts.push(Date.now());
      calls += 1;
      return calls === 1 ? ({ ok: false, status: 429, headers: new Headers(), json: async () => ({}) } as unknown as Response) : ok([]);
    }) as unknown as typeof fetch;
    await Promise.all([
      crossCheckAddress('1 Main St', fake, { minIntervalMs: GAP, baseBackoffMs: 1, retries: 1 }),
      searchStructuredAddress({ street: '2 Main St' }, fake, { minIntervalMs: GAP, baseBackoffMs: 1, retries: 1 }),
    ]);
    starts.sort((a, b) => a - b);
    assert.equal(starts.length >= 3, true);
    for (let i = 1; i < starts.length; i++) assert.ok(starts[i]! - starts[i - 1]! >= GAP - 15, `gap ${i}: ${starts[i]! - starts[i - 1]!}ms`);
  });
});
