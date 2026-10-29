import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/store.ts';
import type { TaxDeposit } from '../src/domain/types.ts';

const dep = (id: string, over: Partial<TaxDeposit> = {}): TaxDeposit => ({ id, companyId: 'co_1', depositGroup: 'US-941', date: '2026-01-15', amountCents: 100, reference: 'r', createdAt: '2026-01-01T00:00:00Z', ...over });
const tmp = () => join(mkdtempSync(join(tmpdir(), 'totali-store-')), 'db.sqlite');

test('writes outside a transaction are refused', () => {
  assert.throws(() => new Store().taxDeposits.put(dep('a')), /inside store\.tx/);
});

test('a throwing transaction undoes everything it did', () => {
  const s = new Store();
  s.tx(() => s.taxDeposits.put(dep('keep')));
  assert.throws(() =>
    s.tx(() => {
      s.taxDeposits.put(dep('new'));
      s.taxDeposits.delete('keep');
      s.taxDeposits.put(dep('keep', { reference: 'changed' }));
      throw new Error('boom');
    }),
  );
  assert.equal(s.taxDeposits.get('new'), undefined);
  assert.equal(s.taxDeposits.get('keep')?.reference, 'r');
});

test('reads return copies, so callers cannot mutate stored state', () => {
  const s = new Store();
  s.tx(() => s.taxDeposits.put(dep('a')));
  const copy = s.taxDeposits.get('a')!;
  copy.reference = 'mutated';
  assert.equal(s.taxDeposits.get('a')!.reference, 'r');
});

test('state survives a restart, including updates and deletes', () => {
  const path = tmp();
  const a = new Store(path);
  a.tx(() => {
    a.taxDeposits.put(dep('one'));
    a.taxDeposits.put(dep('two'));
  });
  a.tx(() => {
    a.taxDeposits.put(dep('one', { amountCents: 999 }));
    a.taxDeposits.delete('two');
  });
  a.close();
  const b = new Store(path);
  assert.equal(b.taxDeposits.get('one')?.amountCents, 999);
  assert.equal(b.taxDeposits.get('two'), undefined);
  b.close();
});

test('a rolled-back transaction never reaches disk', () => {
  const path = tmp();
  const a = new Store(path);
  a.tx(() => a.taxDeposits.put(dep('one')));
  assert.throws(() => a.tx(() => { a.taxDeposits.put(dep('two')); throw new Error('x'); }));
  a.close();
  assert.equal(new Store(path).taxDeposits.get('two'), undefined);
});

test('only the documents a transaction touched are written, in one SQLite transaction', () => {
  const path = tmp();
  const a = new Store(path);
  a.tx(() => { for (let i = 0; i < 50; i++) a.taxDeposits.put(dep(`d${i}`)); });
  a.tx(() => a.taxDeposits.put(dep('d7', { amountCents: 7 })));
  a.close();
  const b = new Store(path);
  assert.equal(b.taxDeposits.all().length, 50);
  assert.equal(b.taxDeposits.get('d7')!.amountCents, 7);
  assert.equal(b.taxDeposits.get('d8')!.amountCents, 100);
});

test('if the disk write fails, memory is rolled back so it is never ahead of disk', () => {
  const path = tmp();
  const a = new Store(path);
  a.tx(() => a.taxDeposits.put(dep('one')));
  a.close(); // writes now fail: the connection is gone
  (a as unknown as { db: unknown }).db = { exec() { throw new Error('disk full'); }, prepare() { throw new Error('disk full'); } };
  assert.throws(() => a.tx(() => a.taxDeposits.put(dep('two'))), /disk full/);
  assert.equal(a.taxDeposits.get('two'), undefined);
  assert.equal(a.taxDeposits.get('one')?.id, 'one');
});

test('counters hand out strictly increasing values and survive restart', () => {
  const path = tmp();
  const a = new Store(path);
  const got = a.tx(() => [a.nextCounter('x'), a.nextCounter('x'), a.nextCounter('y')]);
  assert.deepEqual(got, [1, 2, 1]);
  a.close();
  const b = new Store(path);
  assert.equal(b.tx(() => b.nextCounter('x')), 3);
});
