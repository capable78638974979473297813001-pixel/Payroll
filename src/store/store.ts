import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { notFound } from '../lib/errors.ts';
import type { ApiKey, Company, Employee, HouseDay, LedgerEntry, MoneyLeg, PayRun, Shift, TaxDeposit, WebhookEvent } from '../domain/types.ts';

/**
 * A small transactional document store. Every mutation happens inside `tx()`:
 * if the callback throws, every change it made is undone, and if it returns,
 * the whole state is written to disk atomically (temp file + rename). That is
 * the property money movement needs: a state change and the record of it land
 * together or not at all.
 *
 * It is single-process and keeps everything in memory. It is the seam where a
 * Postgres adapter goes; nothing outside this file knows how documents are kept.
 */

type Doc = { id: string };

export class Collection<T extends Doc> {
  private docs = new Map<string, T>();
  private readonly name: string;
  private readonly store: Store;
  constructor(store: Store, name: string) {
    this.store = store;
    this.name = name;
  }

  get(id: string): T | undefined {
    const d = this.docs.get(id);
    return d === undefined ? undefined : structuredClone(d);
  }

  require(id: string, what: string): T {
    const d = this.get(id);
    if (!d) throw notFound(what);
    return d;
  }

  all(): T[] {
    return [...this.docs.values()].map((d) => structuredClone(d));
  }

  where(pred: (d: T) => boolean): T[] {
    return this.all().filter(pred);
  }

  put(doc: T): T {
    this.store.assertInTx();
    this.store.recordUndo(this.name, doc.id, this.docs.get(doc.id));
    const copy = structuredClone(doc);
    this.docs.set(doc.id, copy);
    return structuredClone(copy);
  }

  delete(id: string): void {
    this.store.assertInTx();
    this.store.recordUndo(this.name, id, this.docs.get(id));
    this.docs.delete(id);
  }

  /** Internal: used by the store to restore and load. */
  _raw(): Map<string, T> {
    return this.docs;
  }
}

export class Store {
  readonly companies = new Collection<Company>(this, 'companies');
  readonly employees = new Collection<Employee>(this, 'employees');
  readonly shifts = new Collection<Shift>(this, 'shifts');
  readonly houseDays = new Collection<HouseDay>(this, 'houseDays');
  readonly payRuns = new Collection<PayRun>(this, 'payRuns');
  readonly legs = new Collection<MoneyLeg>(this, 'legs');
  readonly ledger = new Collection<LedgerEntry>(this, 'ledger');
  readonly apiKeys = new Collection<ApiKey>(this, 'apiKeys');
  readonly webhookEvents = new Collection<WebhookEvent>(this, 'webhookEvents');
  readonly taxDeposits = new Collection<TaxDeposit>(this, 'taxDeposits');

  private readonly collections: Record<string, Collection<Doc>>;
  private readonly path: string | undefined;
  private undo: Array<{ name: string; id: string; prev: Doc | undefined }> | null = null;

  constructor(path?: string) {
    this.path = path;
    this.collections = {
      companies: this.companies,
      employees: this.employees,
      shifts: this.shifts,
      houseDays: this.houseDays,
      payRuns: this.payRuns,
      legs: this.legs,
      ledger: this.ledger,
      apiKeys: this.apiKeys,
      webhookEvents: this.webhookEvents,
      taxDeposits: this.taxDeposits,
    } as Record<string, Collection<Doc>>;
    if (path && existsSync(path)) this.load(path);
  }

  assertInTx(): void {
    if (this.undo === null) throw new Error('Store writes must happen inside store.tx()');
  }

  recordUndo(name: string, id: string, prev: Doc | undefined): void {
    this.undo!.push({ name, id, prev: prev === undefined ? undefined : structuredClone(prev) });
  }

  /** Run `fn` atomically. Synchronous on purpose: never hold a transaction across a network call. */
  tx<T>(fn: () => T): T {
    if (this.undo !== null) return fn(); // nested: join the outer transaction
    const undo: Array<{ name: string; id: string; prev: Doc | undefined }> = [];
    this.undo = undo;
    try {
      const result = fn();
      if (undo.length > 0) this.flush();
      this.undo = null;
      return result;
    } catch (err) {
      for (const { name, id, prev } of undo.reverse()) {
        const raw = this.collections[name]._raw();
        if (prev === undefined) raw.delete(id);
        else raw.set(id, prev);
      }
      this.undo = null;
      throw err;
    }
  }

  private flush(): void {
    if (!this.path) return;
    const snapshot: Record<string, Record<string, Doc>> = {};
    for (const [name, coll] of Object.entries(this.collections)) snapshot[name] = Object.fromEntries(coll._raw());
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(snapshot), { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  private load(path: string): void {
    const snapshot = JSON.parse(readFileSync(path, 'utf8')) as Record<string, Record<string, Doc>>;
    for (const [name, docs] of Object.entries(snapshot)) {
      const coll = this.collections[name];
      if (!coll) continue;
      for (const [id, doc] of Object.entries(docs)) coll._raw().set(id, doc);
    }
  }
}
