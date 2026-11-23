import {
  CONNECTOR_SCRIPT_PREFIX,
  PLATFORM_SCRIPT_NAMES,
  SCOPE_STORE_SCRIPT_PREFIX,
  ULID_PATTERN,
  addDecimal,
  cloudflareUsageDay,
  costDay,
  requestRollupDay,
  verticalScriptStem,
  type CloudflareUsageDay,
  type CostAttribution,
  type CostDay,
  type CostDimension,
  type RequestRollupDay,
  type ScopeId,
  type TenantId,
} from '@substrat-run/contracts';
import type { RedactionSql } from './subject-redaction.js';
import { assertRowLimit } from './retention.js';
import { assertUtcDay, pruneBillingDays, pushDayWindow } from './billing-retention.js';

/**
 * The daily Cloudflare cost rollup (#3316, #3311), as statements both adapters run against their
 * directory, beside the request rollup (`request-rollup.ts`).
 *
 * Cloudflare's GraphQL Analytics answer for 90 days. This keeps one row per (UTC day, script,
 * scope, Durable Object class, billed dimension), so the history outlives them. The rows are COST
 * INPUTS ONLY: quantities in the analytics' own units, never a price. A markup schedule prices them
 * at read.
 *
 * Attribution happens HERE, in the transaction that records the day, through the directory and
 * never through a script name's prefix: a Durable Object maps to a scope by the object id recorded
 * for it (`_substrat_scope_objects`), and a script to its vertical, version and owner by the
 * `verticals`, `vertical_versions` and `_substrat_vertical_owners` rows. The scheduled pass and the
 * backfill loader hand the same raw day (`CloudflareUsageDay`) to the same code, so a loaded day
 * and a read day cannot be attributed by different rules.
 *
 * `_substrat_cost_day_reads` is the request rollup's day ledger, for the same reason: a day without
 * a successful read has no rows to say anything with. Empty strings stand for "none" in the key
 * columns (`scope_id`, `object_class`, `object_id`), which a primary key cannot hold as NULL.
 *
 * Every per-object row keeps its object id, so a day read before its scopes' ids were recorded
 * (a pass that ran before a vertical could answer, a loaded snapshot) is attributed when they are:
 * recording an id re-attributes that object's `unmapped` and `unknown` rows in the same transaction.
 *
 * `_substrat_scope_objects` is the directory's record of each scope's Durable Object id: the hex id
 * Cloudflare reports, which is `SCOPE.idFromName(scopeId)` inside the script that holds the scope's
 * data and cannot be computed anywhere else. It keeps the scope's tenant, vertical and kind beside
 * the id, so an object stays attributable after its scope is reaped. `_substrat_scope_object_reads`
 * holds the last failed attempt per (scope, script), so a deployment that predates the read is
 * asked again a day later, not every pass.
 */
export const COST_ROLLUP_DDL = `
  CREATE TABLE IF NOT EXISTS _substrat_cost_days (
    day TEXT NOT NULL,
    script TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    object_class TEXT NOT NULL,
    object_id TEXT NOT NULL,
    dimension TEXT NOT NULL,
    attribution TEXT NOT NULL,
    tenant_id TEXT,
    vertical TEXT,
    kind TEXT NOT NULL,
    version_id TEXT,
    preview_tag TEXT,
    quantity TEXT NOT NULL,
    lower TEXT,
    upper TEXT,
    PRIMARY KEY (day, script, scope_id, object_class, object_id, dimension)
  );
  CREATE INDEX IF NOT EXISTS _substrat_cost_days_tenant ON _substrat_cost_days (tenant_id, day);
  CREATE INDEX IF NOT EXISTS _substrat_cost_days_object ON _substrat_cost_days (object_id, attribution);
  CREATE TABLE IF NOT EXISTS _substrat_cost_day_reads (
    day TEXT PRIMARY KEY,
    attempted_at TEXT NOT NULL,
    read_at TEXT,
    row_count INTEGER,
    error TEXT,
    failing_since TEXT,
    failing_count INTEGER
  );
  CREATE TABLE IF NOT EXISTS _substrat_scope_objects (
    object_id TEXT PRIMARY KEY,
    scope_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    script TEXT NOT NULL,
    vertical TEXT NOT NULL,
    kind TEXT NOT NULL,
    version_id TEXT,
    preview_tag TEXT,
    recorded_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS _substrat_scope_objects_scope ON _substrat_scope_objects (scope_id, script);
  CREATE TABLE IF NOT EXISTS _substrat_scope_object_reads (
    scope_id TEXT NOT NULL,
    script TEXT NOT NULL,
    attempted_at TEXT NOT NULL,
    error TEXT NOT NULL,
    PRIMARY KEY (scope_id, script)
  );
`;

/**
 * How many days back the cost rollup reaches. Cloudflare answers for 90 days ("cannot request data
 * older than 12w6d"); this stays inside them with a margin, so no day is read while it ages out.
 */
export const COST_ROLLUP_LOOKBACK_DAYS = 85;
/** The furthest back a lookback may be set: inside the 90 days with a day's margin for the first day's start. */
export const COST_ROLLUP_MAX_LOOKBACK_DAYS = 88;
/**
 * How long after a day ends it may be read. The periodic Durable Object dataset is an aggregate
 * Cloudflare writes after the fact, so this waits longer than the request rollup does: the first
 * pass after 03:00 UTC takes the day before.
 */
export const COST_ROLLUP_SETTLE_MS = 3 * 3_600_000;
/** How long a day whose read failed waits before it is tried again. */
export const COST_ROLLUP_RETRY_MS = 3_600_000;
/** How long one day's read (several GraphQL pages and the namespace list) may take. */
export const COST_ROLLUP_READ_TIMEOUT_MS = 60_000;
/** The most days one pass reads. A first pass catches up over several. */
export const COST_ROLLUP_DAYS_PER_PASS = 3;
/** How many rows one `pruneCostDays` call deletes, by default. */
export const COST_ROLLUP_PRUNE_BATCH = 500;
/** The most rows one `listCostDays` call returns, and its default. */
export const COST_ROLLUP_LIMIT_MAX = 10_000;
export const COST_ROLLUP_LIMIT_DEFAULT = 1_000;

/** How many scopes one pass asks for their object id. Asking wakes no object: it is `idFromName`. */
export const SCOPE_OBJECTS_PER_PASS = 100;
/** How long a scope whose object id could not be read waits before it is asked again. */
export const SCOPE_OBJECT_RETRY_MS = 86_400_000;

/** One attempt to roll up a day: the raw usage the analytics answered, or why the read failed. */
export type CostDayReadInput =
  | { day: string; attemptedAt: string; usage: CloudflareUsageDay }
  | { day: string; attemptedAt: string; error: string; failingSince?: string; failingCount?: number };

/** Filter for `listCostDays`: inclusive UTC days, at most `limit` rows, in key order. */
export interface CostDayFilter {
  tenantId?: TenantId;
  scopeId?: ScopeId;
  vertical?: string;
  attribution?: CostAttribution;
  since?: string;
  until?: string;
  limit?: number;
}

/** Filter for `listCostRollupDays`: inclusive UTC days. */
export interface CostRollupDayFilter {
  since?: string;
  until?: string;
}

// -- attribution --------------------------------------------------------------

/** A scope's recorded Durable Object, as attribution reads it. */
export interface ScopeObjectRecord {
  scopeId: string;
  tenantId: string;
  script: string;
  vertical: string;
  kind: 'live' | 'preview';
  versionId: string | null;
  previewTag: string | null;
}

/** What the directory knows that attribution needs, for one day. Built by `readCostDirectory`. */
export interface CostDirectory {
  /** Object id → the scope it was recorded for. */
  objects: ReadonlyMap<string, ScopeObjectRecord>;
  /** A stable script name (its stem, its serving ref, a jurisdiction script) → the vertical's slug. */
  slugByScript: ReadonlyMap<string, string>;
  /** A per-version script name → the version. */
  versionByScript: ReadonlyMap<string, { slug: string; versionId: string }>;
  /** A version id → its vertical, for a per-version script whose deployment ref was never stored. */
  versionById: ReadonlyMap<string, { slug: string; versionId: string }>;
  /** Who owned each slug on the day; null for a platform-owned vertical. */
  ownerBySlug: ReadonlyMap<string, string | null>;
  /** The scripts that hold some non-preview scope's data: a per-version script among them is live. */
  liveScripts: ReadonlySet<string>;
}

interface ScriptInfo {
  attribution: 'script' | 'platform' | 'unknown';
  vertical: string | null;
  versionId: string | null;
  kind: 'live' | 'preview';
  tenantId: string | null;
}

const ULID_SUFFIX = /^(.+)-([0-9a-hjkmnp-tv-z]{26})$/;
/** A container row's `script`: its Containers application, which is not a Worker script. */
export const CONTAINER_SCRIPT_PREFIX = 'container:';
/** A container row's `objectClass`; its `objectId` is the container instance. */
export const CONTAINER_OBJECT_CLASS = 'Container';
const GIB = 1024 ** 3;
const GB = 1_000_000_000;

/** Which vertical, version and owner a script is, by the directory alone. */
function scriptInfoOf(script: string, dir: CostDirectory): ScriptInfo {
  const none = { vertical: null, versionId: null, kind: 'live' as const, tenantId: null };
  if (PLATFORM_SCRIPT_NAMES.has(script) || script.startsWith(SCOPE_STORE_SCRIPT_PREFIX) || script.startsWith(CONNECTOR_SCRIPT_PREFIX)) {
    return { attribution: 'platform', ...none };
  }
  let version = dir.versionByScript.get(script);
  if (!version) {
    const m = ULID_SUFFIX.exec(script);
    const byId = m ? dir.versionById.get(m[2]!.toUpperCase()) : undefined;
    // The id alone is not enough: the stem has to be the version's own vertical's.
    if (byId && verticalScriptStem(byId.slug) === m![1]) version = byId;
  }
  if (version) {
    return {
      attribution: 'script',
      vertical: version.slug,
      versionId: version.versionId,
      kind: dir.liveScripts.has(script) ? 'live' : 'preview',
      tenantId: dir.ownerBySlug.get(version.slug) ?? null,
    };
  }
  const slug = dir.slugByScript.get(script);
  if (slug !== undefined) {
    return { attribution: 'script', vertical: slug, versionId: null, kind: 'live', tenantId: dir.ownerBySlug.get(slug) ?? null };
  }
  return { attribution: 'unknown', ...none };
}

/** A non-negative analytics number as a decimal string, at most 6 places. */
function decimalOf(n: number): string {
  if (!Number.isFinite(n) || n < 0) throw new Error(`a usage figure must be a non-negative number, got ${String(n)}`);
  if (Number.isInteger(n) && n <= Number.MAX_SAFE_INTEGER) return String(n);
  const fixed = n.toFixed(6);
  return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
}

const addBound = (a: string | null, b: string | null): string | null => (a !== null && b !== null ? addDecimal(a, b) : null);

/**
 * Attribute one day of raw usage through the directory (#3316). Pure: the rows it returns are what
 * `recordCostDayRows` writes. Rows that land on one key are summed, their intervals too. A figure
 * of zero writes no row: a read day with no row for a dimension had none of it.
 */
export function attributeCostDay(usage: CloudflareUsageDay, dir: CostDirectory): CostDay[] {
  const byKey = new Map<string, CostDay>();
  const add = (
    row: Omit<CostDay, 'day' | 'quantity' | 'lower' | 'upper' | 'dimension'>,
    dimension: CostDimension,
    value: number,
    interval?: { lower?: number | undefined; upper?: number | undefined },
  ) => {
    if (value === 0) return;
    const quantity = decimalOf(value);
    const sampled = interval?.lower !== undefined && interval.upper !== undefined;
    const lower = sampled ? decimalOf(Math.max(0, interval.lower!)) : null;
    const upper = sampled ? decimalOf(Math.max(0, interval.upper!)) : null;
    const key = [row.script, row.scopeId ?? '', row.objectClass ?? '', row.objectId ?? '', dimension].join('\u0000');
    const prior = byKey.get(key);
    if (prior) {
      byKey.set(key, { ...prior, quantity: addDecimal(prior.quantity, quantity), lower: addBound(prior.lower, lower), upper: addBound(prior.upper, upper) });
    } else {
      byKey.set(key, { day: usage.day, ...row, dimension, quantity, lower, upper });
    }
  };

  const scriptRow = (script: string, objectClass: string | null) => {
    const info = scriptInfoOf(script, dir);
    return {
      script,
      scopeId: null,
      objectClass,
      objectId: null,
      attribution: info.attribution,
      tenantId: info.tenantId as TenantId | null,
      vertical: info.vertical,
      kind: info.kind,
      versionId: info.versionId,
      previewTag: null,
    };
  };

  // Namespace → script and class: Cloudflare's list first, the day's invocations for a namespace
  // the list no longer holds (a reaped per-version script's).
  const namespaces = new Map<string, { script: string | null; objectClass: string | null }>();
  for (const n of usage.namespaces) namespaces.set(n.id, { script: n.script, objectClass: n.class });
  for (const i of usage.doInvocations) {
    const known = namespaces.get(i.namespaceId);
    if (!known) namespaces.set(i.namespaceId, { script: i.script, objectClass: null });
    else if (known.script === null) namespaces.set(i.namespaceId, { ...known, script: i.script });
  }

  for (const w of usage.workers) add(scriptRow(w.script, null), 'worker_cpu_us', w.cpuTimeUs, w);
  for (const i of usage.doInvocations) {
    add(scriptRow(i.script, namespaces.get(i.namespaceId)?.objectClass ?? null), 'do_requests', i.requests, i);
  }
  for (const o of usage.doObjects) {
    const ns = namespaces.get(o.namespaceId);
    const scope = dir.objects.get(o.objectId);
    let row: Omit<CostDay, 'day' | 'quantity' | 'lower' | 'upper' | 'dimension'>;
    if (scope) {
      row = {
        script: ns?.script ?? scope.script,
        scopeId: scope.scopeId as ScopeId,
        objectClass: ns?.objectClass ?? null,
        objectId: o.objectId,
        attribution: 'scope',
        tenantId: scope.tenantId as TenantId,
        vertical: scope.vertical,
        kind: scope.kind,
        versionId: scope.versionId,
        previewTag: scope.previewTag,
      };
    } else {
      // An object the directory recorded for no scope is reported apart: its script's vertical is a
      // fact, whose it is is not, so it carries no tenant. Its id stays, for when it is recorded.
      const base = scriptRow(ns?.script ?? '', ns?.objectClass ?? null);
      row = { ...base, objectId: o.objectId, attribution: base.attribution === 'script' ? 'unmapped' : base.attribution, tenantId: null };
    }
    add(row, 'do_rows_read', o.rowsRead);
    add(row, 'do_rows_written', o.rowsWritten);
    add(row, 'do_storage_write_units', o.storageWriteUnits);
    add(row, 'do_duration_gb_s', o.duration);
  }

  // Containers (#3316): Cloudflare names an application and an instance, never a tenant, so the
  // label the platform set at start is the only attribution there is. A container with no label is
  // the platform's own; one whose label is not a tenant id is reported apart, never guessed at.
  for (const c of usage.containers ?? []) {
    const tenant = c.tenant !== null && ULID_PATTERN.test(c.tenant) ? (c.tenant as TenantId) : null;
    const row = {
      script: `${CONTAINER_SCRIPT_PREFIX}${c.applicationId}`,
      scopeId: null,
      objectClass: CONTAINER_OBJECT_CLASS,
      objectId: c.instanceId,
      attribution: tenant !== null ? ('container' as const) : c.tenant === null ? ('platform' as const) : ('unknown' as const),
      tenantId: tenant,
      vertical: tenant !== null ? c.app : null,
      kind: 'live' as const,
      versionId: null,
      previewTag: null,
    };
    add(row, 'container_cpu_s', c.cpuTimeSec);
    add(row, 'container_memory_gib_s', c.allocatedMemory / GIB);
    add(row, 'container_disk_gb_s', c.allocatedDisk / GB);
    add(row, 'container_egress_bytes', c.txBytes);
  }
  return [...byKey.values()];
}


/**
 * The directory as attribution reads it for `day`: every recorded object, every vertical and
 * version, who owned each slug that day, and which scripts hold live scopes' data. Whole tables,
 * never an `IN` list, so no statement nears a Durable Object's parameter limit.
 */
export function readCostDirectory(sql: RedactionSql, day: string): CostDirectory {
  const start = `${assertUtcDay('day', day)}T00:00:00.000Z`;
  const end = new Date(Date.parse(start) + 86_400_000).toISOString();
  const objects = new Map<string, ScopeObjectRecord>();
  for (const r of sql(
    `SELECT object_id, scope_id, tenant_id, script, vertical, kind, version_id, preview_tag FROM _substrat_scope_objects`,
    [],
  ) as { object_id: string; scope_id: string; tenant_id: string; script: string; vertical: string; kind: string; version_id: string | null; preview_tag: string | null }[]) {
    objects.set(r.object_id, {
      scopeId: r.scope_id,
      tenantId: r.tenant_id,
      script: r.script,
      vertical: r.vertical,
      kind: r.kind === 'preview' ? 'preview' : 'live',
      versionId: r.version_id,
      previewTag: r.preview_tag,
    });
  }
  const slugByScript = new Map<string, string>();
  for (const v of sql('SELECT slug, serving_ref FROM verticals', []) as { slug: string; serving_ref: string | null }[]) {
    const stem = verticalScriptStem(v.slug);
    for (const name of [stem, `${stem}-eu`, `${stem}-us`]) slugByScript.set(name, v.slug);
    if (v.serving_ref) slugByScript.set(v.serving_ref, v.slug);
  }
  const versionByScript = new Map<string, { slug: string; versionId: string }>();
  const versionById = new Map<string, { slug: string; versionId: string }>();
  for (const v of sql('SELECT id, vertical_slug, deployment_ref FROM vertical_versions', []) as {
    id: string;
    vertical_slug: string;
    deployment_ref: string | null;
  }[]) {
    const version = { slug: v.vertical_slug, versionId: v.id };
    versionById.set(v.id.toUpperCase(), version);
    if (v.deployment_ref && !slugByScript.has(v.deployment_ref)) versionByScript.set(v.deployment_ref, version);
  }
  // Each slug's owner on the day: the latest period that overlaps it.
  const ownerBySlug = new Map<string, string | null>();
  for (const o of sql(
    `SELECT slug, owner FROM _substrat_vertical_owners
      WHERE since < ? AND (until IS NULL OR until > ?) ORDER BY since`,
    [end, start],
  ) as { slug: string; owner: string | null }[]) {
    ownerBySlug.set(o.slug, o.owner);
  }
  // A slug with no period (a directory older than the history) falls back to who owns it now.
  for (const v of sql('SELECT slug, owner_tenant FROM verticals', []) as { slug: string; owner_tenant: string | null }[]) {
    if (!ownerBySlug.has(v.slug)) ownerBySlug.set(v.slug, v.owner_tenant);
  }
  const liveScripts = new Set<string>();
  for (const r of sql(
    `SELECT DISTINCT COALESCE(s.serving_ref, vv.deployment_ref) AS script
       FROM scopes s LEFT JOIN vertical_versions vv ON vv.id = s.vertical_version_id
      WHERE COALESCE(s.kind, '') <> 'preview'`,
    [],
  ) as { script: string | null }[]) {
    if (r.script) liveScripts.add(r.script);
  }
  for (const r of sql('SELECT DISTINCT script FROM _substrat_scope_objects WHERE kind = ?', ['live']) as { script: string }[]) {
    liveScripts.add(r.script);
  }
  return { objects, slugByScript, versionByScript, versionById, ownerBySlug, liveScripts };
}

// -- the day ledger -----------------------------------------------------------

/**
 * Record one attempt. A successful read is attributed through the directory, replaces the day's
 * rows in the caller's transaction, and marks the day read. A failed one records only the attempt:
 * the day's rows and its last successful read stay as they were. The raw day is parsed, and every
 * row it attributes to, before anything is written. Returns how many rows were written.
 */
export function recordCostDayRows(sql: RedactionSql, input: CostDayReadInput): number {
  const day = assertUtcDay('day', input.day);
  const attemptedAt = new Date(input.attemptedAt).toISOString();
  if ('error' in input) {
    const count = input.failingCount ?? 1;
    if (!(Number.isInteger(count) && count >= 1)) {
      throw new Error(`failingCount must be a whole number, at least one, got ${String(count)}`);
    }
    sql(
      `INSERT INTO _substrat_cost_day_reads (day, attempted_at, read_at, row_count, error, failing_since, failing_count)
       VALUES (?, ?, NULL, NULL, ?, ?, ?)
       ON CONFLICT (day) DO UPDATE SET
         attempted_at = excluded.attempted_at, error = excluded.error,
         failing_since = excluded.failing_since, failing_count = excluded.failing_count`,
      [day, attemptedAt, input.error || 'the read failed', new Date(input.failingSince ?? attemptedAt).toISOString(), count],
    );
    return 0;
  }
  const usage = cloudflareUsageDay.parse(input.usage);
  if (usage.day !== day) throw new Error(`the usage is for ${usage.day}, not ${day}`);
  const rows = attributeCostDay(usage, readCostDirectory(sql, day)).map((r) => costDay.parse(r));
  sql('DELETE FROM _substrat_cost_days WHERE day = ?', [day]);
  insertCostRows(sql, day, rows);
  sql(
    `INSERT INTO _substrat_cost_day_reads (day, attempted_at, read_at, row_count, error, failing_since, failing_count)
     VALUES (?, ?, ?, ?, NULL, NULL, NULL)
     ON CONFLICT (day) DO UPDATE SET
       attempted_at = excluded.attempted_at, read_at = excluded.read_at, row_count = excluded.row_count,
       error = NULL, failing_since = NULL, failing_count = NULL`,
    [day, attemptedAt, attemptedAt, rows.length],
  );
  return rows.length;
}

function insertCostRows(sql: RedactionSql, day: string, rows: readonly CostDay[]): void {
  for (const r of rows) {
    sql(
      `INSERT INTO _substrat_cost_days
         (day, script, scope_id, object_class, object_id, dimension, attribution, tenant_id, vertical, kind, version_id, preview_tag, quantity, lower, upper)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        day,
        r.script,
        r.scopeId ?? '',
        r.objectClass ?? '',
        r.objectId ?? '',
        r.dimension,
        r.attribution,
        r.tenantId,
        r.vertical,
        r.kind,
        r.versionId,
        r.previewTag,
        r.quantity,
        r.lower,
        r.upper,
      ],
    );
  }
}

/** One day's container usage for `recordCostContainerRows`: the rows `CloudflareUsageDay.containers` carries. */
export interface CostContainersInput {
  day: string;
  containers: NonNullable<CloudflareUsageDay['containers']>;
}

/**
 * What `recordCostContainerRows` did: the rows it added, or why it added none. `not-read`: the
 * rollup has not read the day, and will read its containers itself. `already-recorded`: the day
 * has container rows, from its own read or an earlier backfill.
 */
export type CostContainersResult = { recorded: number } | { refused: 'not-read' | 'already-recorded' };

/**
 * Add a day's container rows to a day the rollup read before it read Containers (#3316), from a
 * snapshot taken while Cloudflare still kept them. Never touches the day's other rows, and never a
 * day it would read itself. Attribution is `attributeCostDay`'s, so a loaded row and a read one
 * cannot differ; the day's `row_count` grows by what was added.
 */
export function recordCostContainerRows(sql: RedactionSql, input: CostContainersInput): CostContainersResult {
  const day = assertUtcDay('day', input.day);
  const read = sql('SELECT read_at FROM _substrat_cost_day_reads WHERE day = ?', [day]) as { read_at: string | null }[];
  if (read[0]?.read_at == null) return { refused: 'not-read' };
  const held = sql('SELECT 1 FROM _substrat_cost_days WHERE day = ? AND object_class = ? LIMIT 1', [day, CONTAINER_OBJECT_CLASS]);
  if (held.length > 0) return { refused: 'already-recorded' };
  const usage = cloudflareUsageDay.parse({ day, workers: [], doInvocations: [], doObjects: [], namespaces: [], containers: input.containers });
  const empty: CostDirectory = { objects: new Map(), slugByScript: new Map(), versionByScript: new Map(), versionById: new Map(), ownerBySlug: new Map(), liveScripts: new Set() };
  const rows = attributeCostDay(usage, empty).map((r) => costDay.parse(r));
  insertCostRows(sql, day, rows);
  sql('UPDATE _substrat_cost_day_reads SET row_count = COALESCE(row_count, 0) + ? WHERE day = ?', [rows.length, day]);
  return { recorded: rows.length };
}

interface CostDayRow {
  day: string;
  script: string;
  scope_id: string;
  object_class: string;
  object_id: string;
  dimension: string;
  attribution: string;
  tenant_id: string | null;
  vertical: string | null;
  kind: string;
  version_id: string | null;
  preview_tag: string | null;
  quantity: string;
  lower: string | null;
  upper: string | null;
}

/** Read stored cost rows — see `CostDayFilter`. Every row is parsed on the way out. */
export function listCostDayRows(sql: RedactionSql, filter: CostDayFilter = {}): CostDay[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  for (const [column, value] of [
    ['tenant_id', filter.tenantId],
    ['scope_id', filter.scopeId],
    ['vertical', filter.vertical],
    ['attribution', filter.attribution],
  ] as const) {
    if (value === undefined) continue;
    where.push(`${column} = ?`);
    params.push(value);
  }
  pushDayWindow(filter, where, params);
  params.push(Math.min(assertRowLimit('limit', filter.limit ?? COST_ROLLUP_LIMIT_DEFAULT), COST_ROLLUP_LIMIT_MAX));
  const rows = sql(
    `SELECT day, script, scope_id, object_class, object_id, dimension, attribution, tenant_id, vertical, kind, version_id, preview_tag, quantity, lower, upper
       FROM _substrat_cost_days
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY day, script, scope_id, object_class, object_id, dimension LIMIT ?`,
    params,
  ) as CostDayRow[];
  return rows.map((r) =>
    costDay.parse({
      day: r.day,
      script: r.script,
      scopeId: r.scope_id === '' ? null : r.scope_id,
      objectClass: r.object_class === '' ? null : r.object_class,
      objectId: r.object_id === '' ? null : r.object_id,
      dimension: r.dimension,
      attribution: r.attribution,
      tenantId: r.tenant_id,
      vertical: r.vertical,
      kind: r.kind,
      versionId: r.version_id,
      previewTag: r.preview_tag,
      quantity: r.quantity,
      lower: r.lower,
      upper: r.upper,
    }),
  );
}

/** Filter for `sumCostDays`: an inclusive window of UTC days, optionally one tenant's rows. */
export interface CostDayTotalsFilter {
  tenantId?: TenantId;
  since: string;
  until: string;
}

/** One group's summed quantity: the rows of one (day, tenant, attribution, vertical, kind, dimension). */
export interface CostDayTotal {
  day: string;
  tenantId: string | null;
  attribution: CostAttribution;
  vertical: string | null;
  kind: 'live' | 'preview';
  dimension: CostDimension;
  quantity: string;
}

/** A scope the window's rows name, with the vertical and kind they attributed it to. */
export interface CostScope {
  scopeId: string;
  vertical: string | null;
  kind: 'live' | 'preview';
}

/** `sumCostDays`: the window's totals per group, and the scopes behind them. */
export interface CostDayTotals {
  totals: CostDayTotal[];
  scopes: CostScope[];
}

/**
 * The stored cost rows of a window, summed per (day, tenant, attribution, vertical, kind,
 * dimension) with `addDecimal` (#3316): what a priced read needs, without carrying every
 * per-object row across the RPC. Sums are exact; nothing is floated in SQL or here. Also the
 * distinct scopes the rows name, with their vertical and kind, so request and storage figures
 * kept per scope can be split the same way.
 */
export function sumCostDayRows(sql: RedactionSql, filter: CostDayTotalsFilter): CostDayTotals {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (filter.tenantId !== undefined) {
    where.push('tenant_id = ?');
    params.push(filter.tenantId);
  }
  pushDayWindow(filter, where, params);
  const clause = `WHERE ${where.join(' AND ')}`;
  const rows = sql(
    `SELECT day, tenant_id, attribution, vertical, kind, dimension, quantity FROM _substrat_cost_days ${clause}`,
    params,
  ) as { day: string; tenant_id: string | null; attribution: CostAttribution; vertical: string | null; kind: 'live' | 'preview'; dimension: CostDimension; quantity: string }[];
  const groups = new Map<string, CostDayTotal>();
  for (const r of rows) {
    const key = JSON.stringify([r.day, r.tenant_id, r.attribution, r.vertical, r.kind, r.dimension]);
    const held = groups.get(key);
    if (held) held.quantity = addDecimal(held.quantity, r.quantity);
    else
      groups.set(key, {
        day: r.day,
        tenantId: r.tenant_id,
        attribution: r.attribution,
        vertical: r.vertical,
        kind: r.kind,
        dimension: r.dimension,
        quantity: r.quantity,
      });
  }
  const scopes = sql(
    `SELECT scope_id, MAX(vertical) AS vertical, MAX(kind) AS kind FROM _substrat_cost_days ${clause} AND scope_id <> '' GROUP BY scope_id ORDER BY scope_id`,
    params,
  ) as { scope_id: string; vertical: string | null; kind: 'live' | 'preview' }[];
  const totals = [...groups.values()].sort(
    (a, b) =>
      a.day.localeCompare(b.day) ||
      (a.tenantId ?? '').localeCompare(b.tenantId ?? '') ||
      a.attribution.localeCompare(b.attribution) ||
      (a.vertical ?? '').localeCompare(b.vertical ?? '') ||
      a.kind.localeCompare(b.kind) ||
      a.dimension.localeCompare(b.dimension),
  );
  return { totals, scopes: scopes.map((s) => ({ scopeId: s.scope_id, vertical: s.vertical, kind: s.kind })) };
}

/** The rollup's record of each day it tried, in day order, in the request rollup's shape (never saturated). */
export function listCostRollupDayRows(sql: RedactionSql, filter: CostRollupDayFilter = {}): RequestRollupDay[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  pushDayWindow(filter, where, params);
  const rows = sql(
    `SELECT day, attempted_at, read_at, row_count, error, failing_since, failing_count
       FROM _substrat_cost_day_reads
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY day`,
    params,
  ) as {
    day: string;
    attempted_at: string;
    read_at: string | null;
    row_count: number | null;
    error: string | null;
    failing_since: string | null;
    failing_count: number | null;
  }[];
  return rows.map((r) =>
    requestRollupDay.parse({
      day: r.day,
      attemptedAt: r.attempted_at,
      readAt: r.read_at,
      rows: r.row_count,
      error: r.error,
      saturated: false,
      failingSince: r.failing_since,
      failingCount: r.failing_count,
    }),
  );
}

/** Delete at most `limit` cost rows past a retention of `months`, as `pruneRequestDayRows` does. */
export function pruneCostDayRows(sql: RedactionSql, nowMs: number, limit: number, months: number | null): number {
  return pruneBillingDays(sql, { rows: '_substrat_cost_days', records: '_substrat_cost_day_reads' }, nowMs, limit, months);
}

// -- scope object ids ---------------------------------------------------------

/** A scope whose Durable Object id is not recorded for the script that holds its data now. */
export interface ScopeObjectTarget {
  tenantId: TenantId;
  scopeId: ScopeId;
  /** The script that holds the scope's data: its serving ref, or its bound version's own script. */
  script: string;
  vertical: string;
  kind: 'live' | 'preview';
  /** The bound version, when the data lives in that version's own script (a preview, a legacy scope). */
  versionId: string | null;
  /** The tag that asked for a preview, from the scope's slug. */
  previewTag: string | null;
}

/** One answer for a target: its object id, or why it could not be read. */
export type ScopeObjectReadInput = ScopeObjectTarget & { attemptedAt: string } & ({ objectId: string } | { error: string });

const OBJECT_ID = /^[0-9a-f]{64}$/;

/**
 * The scopes whose object id is due, newest first (a preview fork is short-lived and the costliest
 * thing to lose): every scope with a vertical and a data script that has no object recorded for
 * that script, and no failed attempt within `retryMs`. A scope whose data moved to another script
 * is due again, because the new script holds a new object.
 */
export function scopeObjectsDueRows(sql: RedactionSql, input: { nowMs: number; retryMs: number; limit: number }): ScopeObjectTarget[] {
  const retryBefore = new Date(input.nowMs - input.retryMs).toISOString();
  const rows = sql(
    `SELECT t.* FROM (
       SELECT s.scope_id, s.tenant_id, s.vertical, s.kind, s.slug, s.vertical_version_id, s.serving_ref, s.created_at,
              COALESCE(s.serving_ref, vv.deployment_ref) AS script
         FROM scopes s LEFT JOIN vertical_versions vv ON vv.id = s.vertical_version_id
        WHERE s.vertical IS NOT NULL) t
      WHERE t.script IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM _substrat_scope_objects o WHERE o.scope_id = t.scope_id AND o.script = t.script)
        AND NOT EXISTS (SELECT 1 FROM _substrat_scope_object_reads r
                         WHERE r.scope_id = t.scope_id AND r.script = t.script AND r.attempted_at > ?)
      ORDER BY t.created_at DESC, t.scope_id LIMIT ?`,
    [retryBefore, assertRowLimit('limit', input.limit)],
  ) as {
    scope_id: string;
    tenant_id: string;
    vertical: string;
    kind: string | null;
    slug: string | null;
    vertical_version_id: string | null;
    serving_ref: string | null;
    script: string;
  }[];
  return rows.map((r) => {
    const preview = r.kind === 'preview';
    return {
      tenantId: r.tenant_id as TenantId,
      scopeId: r.scope_id as ScopeId,
      script: r.script,
      vertical: r.vertical,
      kind: preview ? 'preview' : 'live',
      versionId: preview || r.serving_ref === null ? r.vertical_version_id : null,
      previewTag: preview ? (r.slug?.split('--').at(-1) || null) : null,
    };
  });
}

/**
 * Record one target's answer. An object id replaces whatever the id was recorded as before (the
 * same id is the same object), clears the target's failed attempt, and attributes every cost row
 * already stored for that object that named no scope, so a day read before the id was known is not
 * left without its tenant. A failure records only the attempt, so the target waits `retryMs`. An id
 * that is not Cloudflare's 64-hex shape is refused.
 */
export function recordScopeObjectRow(sql: RedactionSql, input: ScopeObjectReadInput): void {
  const attemptedAt = new Date(input.attemptedAt).toISOString();
  if ('error' in input) {
    sql(
      `INSERT INTO _substrat_scope_object_reads (scope_id, script, attempted_at, error) VALUES (?, ?, ?, ?)
       ON CONFLICT (scope_id, script) DO UPDATE SET attempted_at = excluded.attempted_at, error = excluded.error`,
      [input.scopeId, input.script, attemptedAt, input.error || 'the read failed'],
    );
    return;
  }
  if (!OBJECT_ID.test(input.objectId)) {
    throw new Error(`a Durable Object id is 64 lowercase hex characters, got ${JSON.stringify(input.objectId)}`);
  }
  sql(
    `INSERT INTO _substrat_scope_objects (object_id, scope_id, tenant_id, script, vertical, kind, version_id, preview_tag, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (object_id) DO UPDATE SET
       scope_id = excluded.scope_id, tenant_id = excluded.tenant_id, script = excluded.script, vertical = excluded.vertical,
       kind = excluded.kind, version_id = excluded.version_id, preview_tag = excluded.preview_tag, recorded_at = excluded.recorded_at`,
    [input.objectId, input.scopeId, input.tenantId, input.script, input.vertical, input.kind, input.versionId, input.previewTag, attemptedAt],
  );
  sql('DELETE FROM _substrat_scope_object_reads WHERE scope_id = ? AND script = ?', [input.scopeId, input.script]);
  sql(
    `UPDATE _substrat_cost_days
        SET attribution = 'scope', scope_id = ?, tenant_id = ?, vertical = ?, kind = ?, version_id = ?, preview_tag = ?
      WHERE object_id = ? AND attribution IN ('unmapped', 'unknown')`,
    [input.scopeId, input.tenantId, input.vertical, input.kind, input.versionId, input.previewTag, input.objectId],
  );
}
