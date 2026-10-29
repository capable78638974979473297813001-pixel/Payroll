import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { notFound } from '../lib/errors.ts';
import type { AchFile, ApiKey, AuditEntry, BankAccount, BankLink, Company, Counter, Employee, HouseDay, LedgerEntry, MoneyLeg, PayRun, Shift, TaxDeposit } from '../domain/types.ts';

/**
 * A small transactional document store.
 *
 * Every mutation happens inside `tx()`. If the callback throws, every change
 * it made is undone. If it returns, the documents it changed are written to
 * SQLite in one transaction (WAL, synchronous=FULL) before `tx()` returns, so
 * a state change and the record of it land together or not at all. If the
 * disk write itself fails, the in-memory change is undone too: memory is
 * never ahead of disk.
 *
 * Reads are served from memory. With no path the store is in-memory only
 * (tests, local experiments). It is single-process, and it is the seam where
 * a networked database goes: nothing outside this file knows how documents
 * are kept.
 */

type Doc = { id: string };

export class Collection<T extends Doc> {
  private docs = new Map<string, T>();
  readonly name: string;
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

  /** Internal: used by the store to restore, load and persist. */
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
  readonly taxDeposits = new Collection<TaxDeposit>(this, 'taxDeposits');
  readonly bankAccounts = new Collection<BankAccount>(this, 'bankAccounts');
  readonly bankLinks = new Collection<BankLink>(this, 'bankLinks');
  readonly achFiles = new Collection<AchFile>(this, 'achFiles');
  readonly counters = new Collection<Counter>(this, 'counters');
  readonly auditLog = new Collection<AuditEntry>(this, 'auditLog');

  private readonly collections: Record<string, Collection<Doc>>;
  private db: DatabaseSync | undefined;
  private undo: Array<{ name: string; id: string; prev: Doc | undefined }> | null = null;

  constructor(path?: string) {
    this.collections = Object.fromEntries(
      [this.companies, this.employees, this.shifts, this.houseDays, this.payRuns, this.legs, this.ledger, this.apiKeys, this.taxDeposits, this.bankAccounts, this.bankLinks, this.achFiles, this.counters, this.auditLog].map((c) => [c.name, c as unknown as Collection<Doc>]),
    );
    if (path) this.open(path);
  }

  private open(path: string): void {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(path);
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;');
    db.exec('CREATE TABLE IF NOT EXISTS docs (collection TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY (collection, id)) WITHOUT ROWID');
    for (const row of db.prepare('SELECT collection, id, json FROM docs').all() as Array<{ collection: string; id: string; json: string }>) {
      this.collections[row.collection]?._raw().set(row.id, JSON.parse(row.json));
    }
    this.db = db;
  }

  close(): void {
    this.db?.close();
    this.db = undefined;
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
      if (undo.length > 0) this.persist(undo);
      this.undo = null;
      return result;
    } catch (err) {
      for (const { name, id, prev } of [...undo].reverse()) {
        const raw = this.collections[name]._raw();
        if (prev === undefined) raw.delete(id);
        else raw.set(id, prev);
      }
      this.undo = null;
      throw err;
    }
  }

  /** Write every document this transaction touched, as it now stands, in one SQLite transaction. */
  private persist(undo: Array<{ name: string; id: string }>): void {
    const db = this.db;
    if (!db) return;
    const touched = new Map<string, { name: string; id: string }>();
    for (const u of undo) touched.set(`${u.name}\u0000${u.id}`, u);
    db.exec('BEGIN IMMEDIATE');
    try {
      const upsert = db.prepare('INSERT INTO docs (collection, id, json) VALUES (?, ?, ?) ON CONFLICT (collection, id) DO UPDATE SET json = excluded.json');
      const remove = db.prepare('DELETE FROM docs WHERE collection = ? AND id = ?');
      for (const { name, id } of touched.values()) {
        const doc = this.collections[name]._raw().get(id);
        if (doc === undefined) remove.run(name, id);
        else upsert.run(name, id, JSON.stringify(doc));
      }
      db.exec('COMMIT');
    } catch (e) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // the connection may already have rolled back
      }
      throw e;
    }
  }

  /** Allocate the next value of a named counter (trace numbers, file sequence). Call inside tx(). */
  nextCounter(name: string, start = 1): number {
    const cur = this.counters.get(name);
    const value = cur ? cur.value + 1 : start;
    this.counters.put({ id: name, value });
    return value;
  }
}
