import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/store.ts';
import type { WebhookEvent } from '../src/domain/types.ts';

const ev = (id: string): WebhookEvent => ({ id, type: 't', receivedAt: '2026-01-01T00:00:00Z' });

test('writes outside a transaction are refused', () => {
  const s = new Store();
  assert.throws(() => s.webhookEvents.put(ev('a')), /inside store\.tx/);
});

test('a throwing transaction undoes everything it did', () => {
  const s = new Store();
  s.tx(() => s.webhookEvents.put(ev('keep')));
  assert.throws(() =>
    s.tx(() => {
      s.webhookEvents.put(ev('new'));
      s.webhookEvents.delete('keep');
      s.webhookEvents.put({ ...ev('keep'), type: 'changed' });
      throw new Error('boom');
    }),
  );
  assert.equal(s.webhookEvents.get('new'), undefined);
  assert.equal(s.webhookEvents.get('keep')?.type, 't');
});

test('reads return copies, so callers cannot mutate stored state', () => {
  const s = new Store();
  s.tx(() => s.webhookEvents.put(ev('a')));
  const copy = s.webhookEvents.get('a')!;
  copy.type = 'mutated';
  assert.equal(s.webhookEvents.get('a')!.type, 't');
});

test('state survives a restart from disk', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'totali-store-')), 'db.json');
  const a = new Store(path);
  a.tx(() => a.webhookEvents.put(ev('persisted')));
  const b = new Store(path);
  assert.equal(b.webhookEvents.get('persisted')?.id, 'persisted');
  assert.ok(JSON.parse(readFileSync(path, 'utf8')).webhookEvents.persisted);
});

test('a rolled-back transaction is never written to disk', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'totali-store-')), 'db.json');
  const a = new Store(path);
  a.tx(() => a.webhookEvents.put(ev('one')));
  assert.throws(() => a.tx(() => { a.webhookEvents.put(ev('two')); throw new Error('x'); }));
  assert.equal(new Store(path).webhookEvents.get('two'), undefined);
});
