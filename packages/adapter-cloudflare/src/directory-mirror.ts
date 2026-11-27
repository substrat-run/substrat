/**
 * Step 3b of the directory split (K-68, directory split; rfc/tenant-scale.md §12): DUAL-WRITE.
 * Every write to a row of the one directory (`ControlPlaneDO`) is also written to the object the
 * row is placed in after the split (`directory-placement.ts`): its tenant's `TenantDirectoryDO`, or
 * the `DirectoryRegistryDO`. The directory stays the only thing anything reads and the only place
 * anything is decided. The objects are a copy, written after the directory's transaction commits.
 *
 * **Off by default.** `DIRECTORY_MIRROR` unset (or `off`) installs nothing, so a directory writes
 * exactly what it wrote before this file existed. `all`, or a comma list of tables, switches it on.
 *
 * **Capture is triggers, as the routing read model's is (#3395).** An `AFTER INSERT/UPDATE/DELETE`
 * trigger on each mirrored table appends (table, key, target object) to `directory_mirror_outbox` in
 * the same transaction as the change, so no write path is missed and a path added later is covered
 * without anyone remembering to. The triggers only append: no JSON is read and no constraint can be
 * met (the outbox's key is its rowid), because a trigger that can fail is a directory write that can
 * fail. The row itself is NOT copied: a `vertical_versions` manifest copied into an outbox would
 * double the directory's largest writes and could carry a row past the object row limit.
 *
 * **The flush sends the CURRENT row, stamped with a version.** When the outermost directory method
 * returns, the flush reads a batch of the outbox and, in the same synchronous transaction, bumps the
 * directory's mirror version (one row a batch, not a row a write) and reads each key's row as it
 * stands. Every change in the batch carries that version. The invariant that makes this correct:
 * a row sent with version `v` reflects every directory write made before `v` was taken, and every
 * write after it will be sent with a larger version. So the object applies a change only if its
 * version is larger than the one it holds for that key, and keeps a tombstone (`deleted`) for a key
 * it removed. Order and idempotency per row follow: a resend, a reordered delivery, or a second flush
 * of the same key after a crash applies once and never goes back.
 *
 * A key's target is decided twice: at write time, by the trigger (so a delete knows where to go),
 * and again at flush time over the current row, by the same SQL. A key the trigger sent to an object
 * the current row is no longer placed in (a scope moved to another tenant, a row deleted) is sent
 * there as a delete. A row no object takes (a tenant-placed row with no tenant, rfc §3's sweep-run
 * units) is counted, never sent: `unplaced` in the flush report.
 *
 * **What is retried.** A send that fails leaves its outbox rows; they go to the back of the outbox
 * (so one unreachable object never holds back the others), and the alarm retries after
 * `MIRROR_RETRY_MS`. Only what an object confirmed is deleted from the outbox.
 *
 * **3c's backfill beside it** (not built here). A backfill page is read the same way: in one
 * transaction, take a new version (`takeMirrorVersion`) and read the rows, then send them through the
 * same `applyMirror`. A row written after the page was read has a larger version and wins; one
 * written before it is in the page already. A key deleted after the page was read left a tombstone
 * with a larger version, so the page cannot bring it back. The backfill and the dual-write therefore
 * need no coordination and no cursor shared between them.
 *
 * **3d's comparison** reads, per tenant, every directory row whose `mirrorTargetsSql` names that
 * tenant's object (the same SQL the triggers and the flush use, so the three cannot disagree about
 * placement), and the object's own rows, and compares them key by key. A key with a row still in
 * `directory_mirror_outbox` for that object, or parked in it, is in flight and reported apart, not as
 * a difference.
 */
import { REGISTRY_OWNER, tenantOwnerOf } from '@substrat-run/kernel';
import { DIRECTORY_PLACEMENT, type DirectoryObjectKind } from './directory-placement.js';

/** The tables this owns in the directory. Excluded from a dump, kept across a restore. */
export const DIRECTORY_MIRROR_TABLE_GLOB = 'directory_mirror_*';
/** A crafted dump naming one of them is refused (`importDump`). */
export const isDirectoryMirrorTable = (name: string): boolean => name.toLowerCase().startsWith('directory_mirror_');

/** How soon a failed send is tried again, by the alarm. */
export const MIRROR_RETRY_MS = 10_000;
/** Outbox rows one batch reads, and one flush at most (the rest go on the next kick). */
export const MIRROR_BATCH = 100;
export const MIRROR_FLUSH_MAX_ROWS = 1_000;

// ---------------------------------------------------------------------------
// Where a row goes: one SQL expression per target, over a row named `ref` (`NEW`, `OLD` or `t`).
// Each yields an owner (`registry`, `tenant:<id>`, as the crossing ledger names them) or NULL.
// ---------------------------------------------------------------------------

type TargetSql = (ref: string) => string;

const REGISTRY: TargetSql = () => `'${REGISTRY_OWNER}'`;
const tenantPrefix = tenantOwnerOf('');
const TENANT: TargetSql = (ref) => `'${tenantPrefix}' || ${ref}."tenant_id"`;
/** rfc §3: "written in the object that changes (D or G)": a tenant's row in D, a platform row in G. */
const TENANT_OR_REGISTRY: TargetSql = (ref) => `CASE WHEN ${ref}."tenant_id" IS NULL THEN '${REGISTRY_OWNER}' ELSE '${tenantPrefix}' || ${ref}."tenant_id" END`;
const VIA_CONNECTION: TargetSql = (ref) =>
  `'${tenantPrefix}' || (SELECT c.tenant_id FROM _substrat_connections c WHERE c.id = ${ref}."connection_id")`;
const viaScope = (column: string): TargetSql => (ref) =>
  `'${tenantPrefix}' || (SELECT s.tenant_id FROM scopes s WHERE s.scope_id = ${ref}."${column}")`;
/** `tenant:<id>` is its tenant's; `scope:<id>` its scope's tenant's; `directory:epoch` is the store's own. */
const LIFECYCLE_SUBJECT: TargetSql = (ref) =>
  `CASE WHEN ${ref}."subject" GLOB 'tenant:*' THEN ${ref}."subject"
        WHEN ${ref}."subject" GLOB 'scope:*' THEN '${tenantPrefix}' || (SELECT s.tenant_id FROM scopes s WHERE s.scope_id = substr(${ref}."subject", 7))
   END`;

export interface MirrorRoute {
  targets: readonly TargetSql[];
  /** Why the route is not the placement's default, for the PR's owner list. */
  note?: string;
}

/** Placed tables whose route is not the default for their placement. */
const ROUTE_OVERRIDES: Readonly<Record<string, MirrorRoute | { notMirrored: string }>> = {
  tenants: { targets: [REGISTRY, TENANT], note: 'G keeps the projection §7.3 sends a status to; D is authoritative' },
  _substrat_access_log: { targets: [TENANT_OR_REGISTRY] },
  _substrat_admin_log: { targets: [TENANT_OR_REGISTRY] },
  _substrat_ops_failures: { targets: [TENANT_OR_REGISTRY] },
  _substrat_markup_schedule: { targets: [TENANT_OR_REGISTRY], note: 'G for defaults (no tenant); per-tenant rows in D' },
  _substrat_connection_secrets: { targets: [VIA_CONNECTION] },
  _substrat_connection_keys: { targets: [VIA_CONNECTION] },
  _substrat_connector_state: { targets: [VIA_CONNECTION] },
  scope_lifecycle_receipts: { targets: [viaScope('scope_id')] },
  scope_tenant_asks: { targets: [viaScope('scope_id')] },
  scope_lifecycle_failures: { targets: [viaScope('scope_id')] },
  _substrat_scope_object_reads: { targets: [viaScope('scope_id')] },
  lifecycle_revisions: {
    targets: [LIFECYCLE_SUBJECT],
    note: '`directory:epoch` is not mirrored: each object mints its own epoch (directory-placement.ts)',
  },
  peer_bindings: {
    targets: [TENANT, viaScope('target_scope_id')],
    note: 'a cross-tenant binding lives in both tenants’ objects (placement: "both" read as both tenants)',
  },
  // Each object ships its own logs to the lake (K-70): copying the directory's queue would ship twice.
  _substrat_directory_outbox: { notMirrored: 'each object keeps and ships its own lake outbox (K-70)' },
  _substrat_directory_capture: { notMirrored: 'each object switches its own lake capture (K-70)' },
};

/** The route of a mirrored table, or null for one no object takes a copy of. */
export function mirrorRouteOf(table: string): MirrorRoute | null {
  const placement = DIRECTORY_PLACEMENT[table];
  if (!placement) throw new Error(`directory mirror: ${table} has no placement (K-68)`);
  const override = ROUTE_OVERRIDES[table];
  if (override) return 'notMirrored' in override ? null : override;
  switch (placement.to) {
    case 'lake':
      return null;
    case 'registry':
      return { targets: [REGISTRY] };
    case 'tenant':
      return { targets: [TENANT] };
    case 'both':
      throw new Error(`directory mirror: ${table} is placed in both objects and has no route saying which rows go where`);
  }
}

/** Every table the mirror can copy, in placement order. */
export const MIRRORED_TABLES: readonly string[] = Object.keys(DIRECTORY_PLACEMENT).filter((t) => mirrorRouteOf(t) !== null);

/** The owner expressions of one row: what the triggers append and what 3d's comparison reads. */
export function mirrorTargetsSql(table: string, ref: string): string[] {
  const route = mirrorRouteOf(table);
  if (!route) throw new Error(`directory mirror: ${table} is not mirrored`);
  return route.targets.map((t) => t(ref));
}

/** The object kind an owner names. */
export const objectKindOfOwner = (owner: string): DirectoryObjectKind => (owner === REGISTRY_OWNER ? 'registry' : 'tenant');

/**
 * The switch as the control plane's environment spells it: unset, empty or `off` mirrors nothing;
 * `all` mirrors every table; otherwise a comma list of `MIRRORED_TABLES`. A name it does not know
 * is refused rather than ignored, so a typo cannot read as "on".
 */
export function parseDirectoryMirror(value: unknown): string[] {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text === '' || text === 'off') return [];
  if (text === 'all') return [...MIRRORED_TABLES];
  const names = [...new Set(text.split(',').map((s) => s.trim()).filter((s) => s !== ''))];
  const unknown = names.filter((n) => !MIRRORED_TABLES.includes(n));
  if (unknown.length > 0) throw new Error(`directory mirror: unknown or unmirrored table ${unknown.join(', ')} (or all, or off)`);
  return names;
}

// ---------------------------------------------------------------------------
// The directory's half: tables, triggers, the flush.
// ---------------------------------------------------------------------------

const OUTBOX = 'directory_mirror_outbox';
const STATE = 'directory_mirror_state';
const TABLES = 'directory_mirror_tables';

const SOURCE_DDL = [
  // Append-only: `id` is the rowid, so no trigger insert can meet a constraint. No index: the flush
  // reads by id and acks by id, so an index would be one more row written for every directory write.
  `CREATE TABLE IF NOT EXISTS ${OUTBOX} (id INTEGER PRIMARY KEY, tbl TEXT NOT NULL, row_key TEXT NOT NULL, target TEXT NOT NULL)`,
  // `version` only grows: a flush batch (or a 3c backfill page) takes the next one. Kept across a
  // restore (it describes the objects, not the directory), so a version is never handed out twice.
  `CREATE TABLE IF NOT EXISTS ${STATE} (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL, restored_at TEXT)`,
  // Which tables mirror, and since when: a row written before `since` reached no object (3c fills it).
  `CREATE TABLE IF NOT EXISTS ${TABLES} (tbl TEXT PRIMARY KEY, since TEXT NOT NULL)`,
];

const quoteIdent = (name: string): string => `"${name.replaceAll('"', '""')}"`;
const triggerName = (verb: 'i' | 'u' | 'd', table: string): string => `dmirror_${verb}_${table}`;

/** A table's key: its declared primary key, in order, or its rowid when it declares none. */
export function mirrorKeyColumns(sql: SqlStorage, table: string): string[] {
  const cols = sql.exec(`SELECT name, pk FROM pragma_table_info(?)`, table).toArray() as { name: string; pk: number }[];
  if (cols.length === 0) throw new Error(`directory mirror: no table ${table}`);
  const pk = cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
  return pk.length > 0 ? pk : ['rowid'];
}

const keySql = (keys: readonly string[], ref: string): string =>
  `json_array(${keys.map((k) => (k === 'rowid' ? `${ref}.rowid` : `${ref}.${quoteIdent(k)}`)).join(', ')})`;

/** The triggers one table needs, spelled as `sqlite_master` keeps them (compared text for text). */
export function directoryMirrorTriggerSql(sql: SqlStorage, table: string): { name: string; sql: string }[] {
  const keys = mirrorKeyColumns(sql, table);
  const rows = (ref: string) => mirrorTargetsSql(table, ref).map((target) => `SELECT ${keySql(keys, ref)} AS k, ${target} AS x`);
  // UNION, not UNION ALL: an update that changes neither key nor target appends one row, not two.
  const append = (refs: string[]) =>
    `INSERT INTO ${OUTBOX} (tbl, row_key, target) SELECT '${table}', k, x FROM (${refs.flatMap(rows).join(' UNION ')}) WHERE x IS NOT NULL;`;
  const t = quoteIdent(table);
  return [
    { name: triggerName('i', table), sql: `CREATE TRIGGER ${triggerName('i', table)} AFTER INSERT ON ${t} BEGIN ${append(['NEW'])} END` },
    { name: triggerName('u', table), sql: `CREATE TRIGGER ${triggerName('u', table)} AFTER UPDATE ON ${t} BEGIN ${append(['OLD', 'NEW'])} END` },
    { name: triggerName('d', table), sql: `CREATE TRIGGER ${triggerName('d', table)} AFTER DELETE ON ${t} BEGIN ${append(['OLD'])} END` },
  ];
}

function dropTriggers(sql: SqlStorage, table: string): void {
  for (const verb of ['i', 'u', 'd'] as const) sql.exec(`DROP TRIGGER IF EXISTS ${triggerName(verb, table)}`);
}

/** Switch the mirror off on a directory that had it: its triggers go; its queue and version stay. */
export function uninstallDirectoryMirror(sql: SqlStorage): void {
  // One read on every construction of a directory that never had the mirror, not 3 drops a table.
  const triggers = sql.exec(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name GLOB 'dmirror_*'`).toArray() as { name: string }[];
  for (const { name } of triggers) sql.exec(`DROP TRIGGER IF EXISTS ${quoteIdent(name)}`);
  const has = sql.exec(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`, TABLES).toArray().length > 0;
  if (has) sql.exec(`DELETE FROM ${TABLES}`);
}

/** Take the next version, inside the caller's transaction (a flush batch, a 3c backfill page). */
export function takeMirrorVersion(sql: SqlStorage): number {
  sql.exec(`UPDATE ${STATE} SET version = version + 1 WHERE id = 1`);
  return Number((sql.exec(`SELECT version FROM ${STATE} WHERE id = 1`).one() as { version: number }).version);
}

/** A column value as the directory stores it. The directory holds no BLOB column (checked on read). */
export type MirrorValue = string | number | null;

/** One key's change, as an object applies it: the row as it stands, or null for a delete. */
export interface MirrorChange {
  table: string;
  /** The key's values as a JSON array, in the table's key order (`mirrorKeyColumns`). */
  key: string;
  row: Record<string, MirrorValue> | null;
}

/** One send: every change carries the batch's version. */
export interface MirrorBatch {
  version: number;
  changes: MirrorChange[];
}

/** What an object did with a batch (`applyMirrorBatch`). */
export interface MirrorApplyResult {
  applied: number;
  /** Already held at this version or a later one. */
  stale: number;
  /** Refused by the object's schema (a parent not there yet, mostly), kept and retried there. */
  parked: number;
  /** Rows parked earlier that applied this time. */
  healed: number;
  /** Rows the apply wrote in the object, as its cursors counted them. */
  rowsWritten: number;
}

/** How the directory reaches the objects: an RPC stub per owner on Cloudflare. */
export interface MirrorSender {
  send(owner: string, batch: MirrorBatch): Promise<MirrorApplyResult>;
}

export interface MirrorFlush {
  /** Outbox rows read and acknowledged. */
  read: number;
  acked: number;
  /** Changes sent, and what the objects did with them. */
  sent: number;
  applied: number;
  stale: number;
  parked: number;
  healed: number;
  /** Rows the directory had no object for (a tenant-placed row without a tenant). */
  unplaced: number;
  /** Rows written by the flush itself, in the directory (version, acks) and in the objects. */
  rowsWrittenDirectory: number;
  rowsWrittenObjects: number;
  /** Stopped because a directory method was running; that method's return restarts it. */
  deferred: boolean;
  /** Owners whose send failed this flush; their rows went to the back of the outbox. */
  failed: string[];
}

export interface MirrorStatus {
  enabled: true;
  tables: { table: string; since: string }[];
  version: number;
  restoredAt: string | null;
  queued: number;
  oldestQueuedId: number | null;
}

interface OutboxRow {
  id: number;
  tbl: string;
  row_key: string;
  target: string;
}

interface ReadBatch {
  ids: number[];
  version: number;
  /** Per owner: its changes, and the outbox ids they stand for. */
  byOwner: Map<string, { changes: MirrorChange[]; ids: number[] }>;
  unplaced: number;
}

const emptyFlush = (): MirrorFlush => ({
  read: 0, acked: 0, sent: 0, applied: 0, stale: 0, parked: 0, healed: 0, unplaced: 0,
  rowsWrittenDirectory: 0, rowsWrittenObjects: 0, deferred: false, failed: [],
});

export interface DirectoryMirrorOptions {
  sql: SqlStorage;
  /** The mirrored tables (`parseDirectoryMirror`), non-empty. */
  tables: readonly string[];
  sender: MirrorSender;
  transaction: <T>(fn: () => T) => T;
  /** No directory method is running, so a read sees only committed writes. */
  quiet: () => boolean;
  /** Arm the directory's alarm no later than `at` (an earlier one is kept). */
  armRetry: (at: number) => Promise<void>;
  now?: () => number;
}

/** The directory's half, one per `ControlPlaneDO` instance while the switch is on. */
export class DirectoryMirror {
  private readonly sql: SqlStorage;
  private readonly keys = new Map<string, string[]>();
  private flushing: Promise<MirrorFlush> | null = null;
  private again = false;
  private retryAfter = 0;
  /** The last flush's account, for status and tests. */
  last: MirrorFlush | null = null;

  constructor(private readonly options: DirectoryMirrorOptions) {
    this.sql = options.sql;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /**
   * Create the tables and hold the triggers to the switch, in the caller's transaction: a table
   * switched on gets its triggers and `since = now`, one switched off loses them. Writes nothing
   * when nothing changed. Run on construction and after a restore (whose drops took the triggers).
   */
  install(): { enabled: string[]; disabled: string[] } {
    for (const stmt of SOURCE_DDL) this.sql.exec(stmt);
    this.sql.exec(`INSERT OR IGNORE INTO ${STATE} (id, version, restored_at) VALUES (1, 0, NULL)`);
    const before = new Set((this.sql.exec(`SELECT tbl FROM ${TABLES}`).toArray() as { tbl: string }[]).map((r) => r.tbl));
    const want = new Set(this.options.tables);
    const enabled: string[] = [];
    const disabled: string[] = [];
    const at = new Date(this.now()).toISOString();
    for (const table of MIRRORED_TABLES) {
      if (!want.has(table)) {
        dropTriggers(this.sql, table);
        if (before.has(table)) {
          this.sql.exec(`DELETE FROM ${TABLES} WHERE tbl = ?`, table);
          disabled.push(table);
        }
        continue;
      }
      for (const t of directoryMirrorTriggerSql(this.sql, table)) {
        const held = this.sql.exec(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?`, t.name).toArray()[0] as { sql: string } | undefined;
        if (held?.sql === t.sql) continue;
        this.sql.exec(`DROP TRIGGER IF EXISTS ${t.name}`);
        this.sql.exec(t.sql);
      }
      if (!before.has(table)) {
        this.sql.exec(`INSERT INTO ${TABLES} (tbl, since) VALUES (?, ?)`, table, at);
        enabled.push(table);
      }
    }
    return { enabled, disabled };
  }

  /** A restore replaced the directory: every object now differs from it until 3c fills them again. */
  markRestored(): void {
    this.sql.exec(`UPDATE ${STATE} SET restored_at = ? WHERE id = 1`, new Date(this.now()).toISOString());
  }

  pending(): boolean {
    return this.sql.exec(`SELECT 1 FROM ${OUTBOX} LIMIT 1`).toArray().length > 0;
  }

  status(): MirrorStatus {
    const state = this.sql.exec(`SELECT version, restored_at FROM ${STATE} WHERE id = 1`).one() as { version: number; restored_at: string | null };
    const q = this.sql.exec(`SELECT COUNT(*) AS n, MIN(id) AS oldest FROM ${OUTBOX}`).one() as { n: number; oldest: number | null };
    return {
      enabled: true,
      tables: (this.sql.exec(`SELECT tbl, since FROM ${TABLES} ORDER BY tbl`).toArray() as { tbl: string; since: string }[]).map((r) => ({ table: r.tbl, since: r.since })),
      version: Number(state.version),
      restoredAt: state.restored_at,
      queued: Number(q.n),
      oldestQueuedId: q.oldest === null ? null : Number(q.oldest),
    };
  }

  private keyColumns(table: string): string[] {
    let keys = this.keys.get(table);
    if (!keys) {
      keys = mirrorKeyColumns(this.sql, table);
      this.keys.set(table, keys);
    }
    return keys;
  }

  /** The row a key names as it stands, and the owners it is placed in now. */
  private readCurrent(table: string, key: string): { row: Record<string, MirrorValue> | null; owners: Set<string> } {
    const keys = this.keyColumns(table);
    const values = JSON.parse(key) as MirrorValue[];
    const where = keys.map((k) => (k === 'rowid' ? 't.rowid = ?' : `t.${quoteIdent(k)} IS ?`)).join(' AND ');
    const targets = mirrorTargetsSql(table, 't').map((expr, i) => `${expr} AS "__mirror_t${i}"`);
    const rowid = keys[0] === 'rowid' ? ', t.rowid AS "__mirror_rowid"' : '';
    const found = this.sql.exec(`SELECT t.*${rowid}, ${targets.join(', ')} FROM ${quoteIdent(table)} t WHERE ${where}`, ...values).toArray()[0] as
      | Record<string, unknown>
      | undefined;
    if (!found) return { row: null, owners: new Set() };
    const row: Record<string, MirrorValue> = {};
    const owners = new Set<string>();
    for (const [column, value] of Object.entries(found)) {
      if (column.startsWith('__mirror_t')) {
        if (typeof value === 'string') owners.add(value);
        continue;
      }
      if (value instanceof ArrayBuffer) throw new Error(`directory mirror: ${table}.${column} holds a BLOB, which the mirror does not carry`);
      row[column === '__mirror_rowid' ? 'rowid' : column] = value as MirrorValue;
    }
    return { row, owners };
  }

  /** One batch, read in one transaction: the version, then each key's current row. */
  private readBatch(limit: number): ReadBatch | null {
    const rows = this.sql.exec(`SELECT id, tbl, row_key, target FROM ${OUTBOX} ORDER BY id LIMIT ?`, limit).toArray() as unknown as OutboxRow[];
    if (rows.length === 0) return null;
    const version = takeMirrorVersion(this.sql);
    const byOwner: ReadBatch['byOwner'] = new Map();
    const current = new Map<string, ReturnType<DirectoryMirror['readCurrent']>>();
    const seen = new Set<string>();
    let unplaced = 0;
    for (const r of rows) {
      const slot = byOwner.get(r.target) ?? { changes: [], ids: [] };
      byOwner.set(r.target, slot);
      slot.ids.push(r.id);
      // Once per (owner, key) a batch, in the order the keys were first written.
      const once = `${r.target}\u0000${r.tbl}\u0000${r.row_key}`;
      if (seen.has(once)) continue;
      seen.add(once);
      const keyId = `${r.tbl}\u0000${r.row_key}`;
      let now = current.get(keyId);
      if (!now) {
        now = this.readCurrent(r.tbl, r.row_key);
        current.set(keyId, now);
        if (now.row && now.owners.size === 0) unplaced += 1;
      }
      slot.changes.push({ table: r.tbl, key: r.row_key, row: now.owners.has(r.target) ? now.row : null });
    }
    return { ids: rows.map((r) => r.id), version, byOwner, unplaced };
  }

  /**
   * Send what the outbox holds, batch by batch, up to `maxRows`. Throws once every send it started
   * has settled when any was refused: what an object confirmed is acknowledged, the rest has moved
   * to the back of the outbox.
   */
  async flush(maxRows = MIRROR_FLUSH_MAX_ROWS): Promise<MirrorFlush> {
    const out = emptyFlush();
    const failed = new Map<string, unknown>();
    while (out.read < maxRows) {
      if (!this.options.quiet()) {
        out.deferred = true;
        break;
      }
      const batch = this.options.transaction(() => this.readBatch(Math.min(MIRROR_BATCH, maxRows - out.read)));
      if (!batch) break;
      out.rowsWrittenDirectory += 1; // the version
      out.read += batch.ids.length;
      out.unplaced += batch.unplaced;
      const owners = [...batch.byOwner.keys()].filter((owner) => !failed.has(owner));
      const settled = await Promise.allSettled(
        owners.map((owner) => this.options.sender.send(owner, { version: batch.version, changes: batch.byOwner.get(owner)!.changes })),
      );
      const ack: number[] = [];
      const back: number[] = [];
      for (const [owner, slot] of batch.byOwner) {
        const i = owners.indexOf(owner);
        const r = i >= 0 ? settled[i]! : null;
        if (r && r.status === 'fulfilled') {
          ack.push(...slot.ids);
          out.sent += slot.changes.length;
          out.applied += r.value.applied;
          out.stale += r.value.stale;
          out.parked += r.value.parked;
          out.healed += r.value.healed;
          out.rowsWrittenObjects += r.value.rowsWritten;
        } else {
          if (r && r.status === 'rejected') failed.set(owner, r.reason);
          back.push(...slot.ids);
        }
      }
      if (back.length > 0) {
        // To the back: fresh rows behind everything queued, the rows this attempt read removed.
        const list = JSON.stringify(back);
        out.rowsWrittenDirectory += this.options.transaction(() => {
          const moved = this.sql.exec(
            `INSERT INTO ${OUTBOX} (tbl, row_key, target) SELECT tbl, row_key, target FROM ${OUTBOX} WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id`,
            list,
          ).rowsWritten;
          return moved + this.sql.exec(`DELETE FROM ${OUTBOX} WHERE id IN (SELECT value FROM json_each(?))`, list).rowsWritten;
        });
      }
      if (ack.length > 0) {
        const deleted = this.sql.exec(`DELETE FROM ${OUTBOX} WHERE id IN (SELECT value FROM json_each(?))`, JSON.stringify(ack)).rowsWritten;
        out.acked += ack.length;
        out.rowsWrittenDirectory += deleted;
      }
      // A batch that landed nothing while an object refuses: stop, and let the alarm try again.
      if (ack.length === 0 && failed.size > 0) break;
    }
    out.failed = [...failed.keys()];
    this.last = out;
    if (failed.size > 0) {
      const [first] = failed.values();
      throw new Error(`directory mirror: ${failed.size} object(s) refused a batch; retried from the alarm. First: ${String(first)}`);
    }
    return out;
  }

  /**
   * Called when the directory's outermost method returns. One flush at a time: a kick during a
   * flush runs one more round after it. After a failure only the alarm retries (`retry`).
   */
  kick(): void {
    if (this.now() < this.retryAfter) return;
    if (this.flushing) {
      this.again = true;
      return;
    }
    if (!this.pending()) return;
    void this.own(async () => {
      let result: MirrorFlush;
      do {
        this.again = false;
        result = await this.flush();
      } while (!result.deferred && (this.again || result.read >= MIRROR_FLUSH_MAX_ROWS));
      return result;
    }).catch(async (err) => {
      console.error('directory mirror: a send failed, retrying from the alarm', err);
      this.retryAfter = this.now() + MIRROR_RETRY_MS;
      await this.options.armRetry(this.now() + MIRROR_RETRY_MS).catch(() => undefined);
    });
  }

  /** The alarm's half: lift the backoff and flush. */
  retry(): void {
    this.retryAfter = 0;
    this.kick();
  }

  /** Wait until the outbox is drained, or a flush fails (for a caller, and a test, that must see it land). */
  async settle(): Promise<MirrorFlush | null> {
    this.retryAfter = 0;
    let last: MirrorFlush | null = null;
    while (this.pending()) {
      last = await this.own(() => this.flush());
      if (last.deferred) break;
    }
    return last;
  }

  private async own(flush: () => Promise<MirrorFlush>): Promise<MirrorFlush> {
    while (this.flushing) await this.flushing.catch(() => undefined);
    const run = flush();
    this.flushing = run;
    try {
      return await run;
    } finally {
      this.flushing = null;
    }
  }
}

/**
 * The directory's mirror as its environment sets it: null (and every mirror trigger dropped) when
 * `DIRECTORY_MIRROR` is off, refused, or the objects are not bound; otherwise installed and ready to
 * kick. Called once, from `ControlPlaneDO`'s constructor.
 */
export function directoryMirrorFor(
  env: unknown,
  sender: MirrorSender | null,
  options: Omit<DirectoryMirrorOptions, 'tables' | 'sender'>,
): DirectoryMirror | null {
  let tables: string[];
  try {
    tables = parseDirectoryMirror(Reflect.get(env as object, 'DIRECTORY_MIRROR'));
  } catch (err) {
    console.error('directory mirror: DIRECTORY_MIRROR refused, the mirror stays off:', (err as Error).message);
    tables = [];
  }
  if (tables.length > 0 && !sender) {
    console.error('directory mirror: DIRECTORY_MIRROR is on but DIRECTORY_REGISTRY / TENANT_DIRECTORY are not bound; the mirror stays off');
  }
  if (tables.length === 0 || !sender) {
    options.transaction(() => uninstallDirectoryMirror(options.sql));
    return null;
  }
  const mirror = new DirectoryMirror({ ...options, tables, sender });
  options.transaction(() => mirror.install());
  return mirror;
}
