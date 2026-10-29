import { DatabaseSync } from 'node:sqlite';
import { statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AddressPoint } from './rooftop.ts';

/**
 * A LOCAL address-point index, queried instead of the network.
 *
 * This is the answer to a gap that no amount of retrying the National
 * Address Database fixes. NAD is aggregated from states that volunteer,
 * and a 5km-box probe over each city (measured, not assumed) found ZERO
 * NAD points in Detroit, Grand Rapids, Pittsburgh, Honolulu, Las Vegas,
 * Manchester, Charleston, Boise, Jackson and Miami — while Philadelphia
 * and Hartford are dense. Contribution is county-by-county even within
 * one state.
 *
 * OpenAddresses collects the same authoritative local files directly from
 * counties, so it carries much of what NAD never received. Built into a
 * SQLite index by scripts/build-address-index.ts.
 *
 * TWO THINGS THIS DELIBERATELY DOES NOT DO:
 *
 *   1. It does not decide which point IS the address. It returns the
 *      neighbourhood; rooftop.ts's matchAddressPoint() applies the
 *      house-number, directional, street-type and unit guards it already
 *      has. Keeping that judgement in one place is the point — two
 *      matchers would drift apart.
 *   2. It does not claim national coverage. OpenAddresses is voluntary
 *      too: New Hampshire, for instance, ships only five towns and
 *      Manchester is not among them. An empty result here is a genuine
 *      "not published", not an error, and the caller falls through to the
 *      network tiers exactly as before.
 *
 * Absent index file = absent tier. Nothing breaks; the pipeline behaves
 * as it did before this existed, which is what makes the index optional
 * for anyone who does not want 5GB of extracts on disk.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/** Read on every open, not once at load, so a test (or a deploy that moves the disk) can repoint it. */
function dbPath(): string {
  return process.env.ADDRESS_INDEX_PATH ?? join(HERE, '..', 'data', 'address-points', 'address-points.db');
}

/** Must match scripts/address-index-lib.ts — a mismatch silently returns nothing. */
const CELL = 0.01;
const MICRO = 1_000_000;

/**
 * How long a missing index is trusted before the file is looked for again.
 * The index can appear while the server is already running (the deploy
 * downloads or builds it in the background, then renames it into place), and
 * the process must pick it up without a restart. A present index is opened
 * once and kept.
 */
function recheckMs(): number {
  const v = Number(process.env.ADDRESS_INDEX_RECHECK_MS);
  return Number.isFinite(v) && v >= 0 ? v : 30_000;
}

let db: DatabaseSync | null = null;
let openedPath: string | null = null;
/** Identity of the file behind `db` (device + inode + birth time). A new index is renamed into place, which changes it, so a long-running server stops reading the old file. */
let openedIdentity: string | null = null;
let lastLookAt = 0;
/** 1 = text cell, REAL coordinates, text source (the original layout). 2 = see scripts/address-index-lib.ts. Read once per open. */
let format = 1;
/** Format 2 files built after ZIP was added carry a `zip` column; older ones do not. */
let hasZip = false;
let sourceNames: Map<number, string> | null = null;

function detectFormat(h: DatabaseSync): number {
  try {
    const row = h.prepare("SELECT value FROM meta WHERE key = 'format'").get() as { value: string } | undefined;
    return row ? Number(row.value) : 1;
  } catch {
    return 1; // no meta table: a format-1 file
  }
}

const REQUIRED_COLUMNS = ['cell', 'lat', 'lon', 'number', 'street', 'unit', 'city', 'state', 'source'];

/**
 * Whether an opened file really is an address index: a `points` table with
 * every column the queries read, and, for format 2, the `sources` table.
 * Opening a SQLite file succeeds for any SQLite file, so "it opened" says
 * nothing; a wrong-schema database would otherwise report itself available
 * and then throw "no such table" in the middle of a lookup.
 */
function validate(h: DatabaseSync, fmt: number): { ok: boolean; zip: boolean } {
  try {
    const cols = (h.prepare('PRAGMA table_info(points)').all() as { name: string }[]).map((c) => c.name);
    if (!REQUIRED_COLUMNS.every((c) => cols.includes(c))) return { ok: false, zip: false };
    if (fmt !== 1 && fmt !== 2) return { ok: false, zip: false };
    if (fmt === 2) h.prepare('SELECT 1 FROM sources LIMIT 1').all();
    return { ok: true, zip: cols.includes('zip') };
  } catch {
    return { ok: false, zip: false };
  }
}

function identityOf(path: string): string | null {
  try {
    const st = statSync(path);
    return `${st.dev}:${st.ino}:${st.birthtimeMs}`;
  } catch {
    return null;
  }
}

function closeHandle(): void {
  try {
    db?.close();
  } catch {
    /* already closed */
  }
  db = null;
  openedIdentity = null;
  sourceNames = null;
}

function handle(): DatabaseSync | null {
  const path = dbPath();
  const identity = identityOf(path);
  if (db && openedPath === path) {
    // Still the same file on disk? A rebuilt index is renamed over the old
    // path, and this handle would otherwise keep reading the old file's
    // (unlinked) contents for the life of the process.
    if (identity !== null && identity === openedIdentity) return db;
    closeHandle();
    lastLookAt = 0;
  }
  const now = Date.now();
  if (!db && now - lastLookAt < recheckMs() && lastLookAt !== 0 && openedPath === path) return null;
  lastLookAt = now;
  openedPath = path;
  closeHandle();
  if (identity === null) return null;
  let opened: DatabaseSync | null = null;
  try {
    opened = new DatabaseSync(path, { readOnly: true });
    const fmt = detectFormat(opened);
    const check = validate(opened, fmt);
    if (!check.ok) {
      opened.close();
      return null;
    }
    db = opened;
    format = fmt;
    hasZip = check.zip;
    openedIdentity = identity;
    sourceNames = null;
  } catch {
    try {
      opened?.close();
    } catch {
      /* not open */
    }
    db = null;
  }
  return db;
}

/** Format 2 stores a small id; the names live in `sources` (a few thousand rows), loaded once per open. */
function sourceNameOf(h: DatabaseSync, id: number | string): string {
  if (typeof id === 'string') return id;
  // A source added by an append after this handle opened is not in the cache; reload once on a miss.
  if (!sourceNames || !sourceNames.has(id)) {
    sourceNames = new Map();
    for (const r of h.prepare('SELECT id, name FROM sources').all() as { id: number; name: string }[]) sourceNames.set(r.id, r.name);
  }
  return sourceNames.get(id) ?? 'local address index';
}

/** Forget any open handle and the recheck timer. For tests, and for a process told the index was just replaced. */
export function resetLocalAddressIndexCache(): void {
  closeHandle();
  openedPath = null;
  lastLookAt = 0;
  format = 1;
  hasZip = false;
}

/** Whether a local index is available at all — for a caller that wants to report which tiers are live. */
export function hasLocalAddressIndex(): boolean {
  return handle() !== null;
}

export interface LocalIndexStats {
  available: boolean;
  totalPoints: number;
  states: { state: string; points: number }[];
}

export function localAddressIndexStats(): LocalIndexStats {
  const h = handle();
  if (!h) return { available: false, totalPoints: 0, states: [] };
  try {
    const total = h.prepare('SELECT COUNT(*) AS c FROM points').get() as { c: number };
    const rows = h
      .prepare('SELECT state, COUNT(*) AS c FROM points GROUP BY state ORDER BY c DESC')
      .all() as { state: string; c: number }[];
    return {
      available: true,
      totalPoints: total.c,
      states: rows.map((r) => ({ state: r.state, points: r.c })),
    };
  } catch {
    closeHandle();
    return { available: false, totalPoints: 0, states: [] };
  }
}

/**
 * Address points within `radiusMeters` of a coordinate, in the same shape
 * fetchAddressPointsNear() returns from NAD, so both feed the same
 * matcher.
 *
 * The cell index narrows to a block of ~1.1km cells first — a bounding
 * box on raw lat/lon would force a full scan of ~100M rows.
 */
export function localAddressPointsNear(
  lat: number,
  lon: number,
  radiusMeters = 300,
): AddressPoint[] {
  const h = handle();
  if (!h) return [];

  const dLat = radiusMeters / 111_320;
  const dLon = radiusMeters / (111_320 * Math.cos((lat * Math.PI) / 180));

  const latCells = spanOf(lat - dLat, lat + dLat);
  const lonCells = spanOf(lon - dLon, lon + dLon);
  const cells: (string | number)[] = [];
  for (const la of latCells) {
    for (const lo of lonCells) cells.push(format === 2 ? (la + 9000) * 100_000 + (lo + 18_000) : `${la}:${lo}`);
  }
  if (cells.length === 0) return [];

  const placeholders = cells.map(() => '?').join(',');
  const scale = format === 2 ? MICRO : 1;
  let rows: {
    lat: number; lon: number; number: string | null; street: string | null;
    unit: string | null; city: string | null; state: string; source: number | string; zip?: number | null;
  }[];
  try {
    rows = h
      .prepare(
        `SELECT lat, lon, number, street, unit, city, state, source${hasZip ? ', zip' : ''}
           FROM points
          WHERE cell IN (${placeholders})
            AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?`,
      )
      .all(...cells, (lat - dLat) * scale, (lat + dLat) * scale, (lon - dLon) * scale, (lon + dLon) * scale) as typeof rows;
  } catch {
    // A file that passed validation but fails to read (truncated, replaced
    // mid-query) is an absent tier for this call, not an exception in the
    // middle of a paycheck; the next lookup re-validates from scratch.
    closeHandle();
    lastLookAt = 0;
    return [];
  }

  return rows.map((r) => ({
    houseNumber: r.number,
    street: r.street,
    unit: r.unit,
    city: r.city,
    zip: r.zip ? String(r.zip).padStart(5, '0') : null,
    // The shared points table has no Placement column — both builders
    // (OpenAddresses per-county extracts, NAD's own bulk text file) leave
    // it unstated here rather than guessed at, the same honesty NAD itself
    // shows by shipping "Unknown" for many of its own live-queried points.
    // A live NAD query still carries the real value via toAddressPoint().
    placement: null,
    // Full provenance ("OpenAddresses tx/harris", "NAD Cook County GIS") is
    // written at ingest by each build script (format 2: as an id into
    // `sources`), not prefixed here: this table can hold rows from more than
    // one builder, so a single hardcoded prefix would mislabel the other's.
    source: sourceNameOf(h, r.source),
    lat: r.lat / scale,
    lon: r.lon / scale,
  }));
}

function spanOf(lo: number, hi: number): number[] {
  const a = Math.floor(lo / CELL);
  const b = Math.floor(hi / CELL);
  const out: number[] = [];
  for (let i = a; i <= b; i++) out.push(i);
  return out;
}
