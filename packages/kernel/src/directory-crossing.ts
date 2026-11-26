/**
 * A change that crosses two directory objects commits its intent first (K-68, directory split;
 * rfc/tenant-scale.md §7.3). K-64's rule — nothing crosses a Durable Object's boundary inside a
 * transaction — applied to the platform's own objects.
 *
 * Two tables, each in one object:
 *
 * - `_substrat_directory_crossings`, in the object that DECIDES (a tenant's directory object, or the
 *   registry for a change it decides itself): one row per crossing, written in the same transaction
 *   as the decision and its admin row. Its id is also the claim's id, so every later step is keyed by
 *   it and a retry repeats a step rather than doubling it.
 * - `_substrat_directory_claims`, in the registry: one row per key that must be unique across every
 *   tenant (a tenant id, a tenant slug, a hostname). A claim is `leased` until its crossing confirms
 *   it, `confirmed` after, and `tombstone` for a key that may never be claimed again (a reaped
 *   tenant's id).
 *
 * The steps, each its own transaction in its own object:
 *
 * 1. the deciding object records the crossing (`intent`);
 * 2. host code asks the registry to CLAIM the key with the crossing's id and a lease;
 * 3. the deciding object marks the crossing `claimed`;
 * 4. host code asks the registry to CONFIRM the claim, which refuses a lease that ran out or a claim
 *    another crossing superseded, and turns a live one permanent;
 * 5. the deciding object settles the crossing `done` (or `failed`, with the refusal).
 *
 * A crash between any two leaves a crossing in `intent` or `claimed`, and `runCrossing` resumes it
 * from there: a repeated claim with the same id returns the same claim, a repeated confirm of a
 * confirmed claim answers ok, and a settle is a compare-and-set from an open state. Nothing is half
 * done with nobody owning it: the open crossing is the owner, and the safety net finds it by
 * `openCrossingsIn`. A claim whose crossing never comes back is superseded by the next claimant once
 * its lease has run out.
 *
 * `adapter-sqlite` keeps ONE database (rfc §11): both tables live in it, and `runCrossingSync` runs
 * the same steps inside one transaction. The contract suite holds the end state on both adapters;
 * the Cloudflare adapter's own suite crashes between the halves.
 *
 * Step 3a of the migration order (rfc §12): nothing calls this yet. Hostname bind, tenant create and
 * tenant reap are wired onto it in the steps after.
 */
import type { SwitchSql } from './system-switch.js';

/** Interpolated into the registry's DDL (and a one-database directory's). */
export const DIRECTORY_CLAIMS_DDL = `
  CREATE TABLE IF NOT EXISTS _substrat_directory_claims (
    namespace    TEXT NOT NULL,
    claim_key    TEXT NOT NULL,
    claim_id     TEXT NOT NULL,
    holder       TEXT NOT NULL,
    scope_id     TEXT,
    jurisdiction TEXT,
    state        TEXT NOT NULL,
    lease_until  TEXT,
    claimed_at   TEXT NOT NULL,
    confirmed_at TEXT,
    PRIMARY KEY (namespace, claim_key)
  );
  CREATE INDEX IF NOT EXISTS _substrat_directory_claims_holder ON _substrat_directory_claims (holder, namespace);
`;

/** Interpolated into every deciding object's DDL: each tenant directory object, the registry. */
export const DIRECTORY_CROSSINGS_DDL = `
  CREATE TABLE IF NOT EXISTS _substrat_directory_crossings (
    crossing_id  TEXT PRIMARY KEY,
    owner        TEXT NOT NULL,
    kind         TEXT NOT NULL,
    namespace    TEXT NOT NULL,
    claim_key    TEXT NOT NULL,
    holder       TEXT NOT NULL,
    scope_id     TEXT,
    jurisdiction TEXT,
    payload      TEXT NOT NULL,
    lease_ms     INTEGER NOT NULL,
    state        TEXT NOT NULL,
    outcome      TEXT,
    attempts     INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS _substrat_directory_crossings_open
    ON _substrat_directory_crossings (owner, updated_at) WHERE state IN ('intent', 'claimed');
`;

/** What must be unique across every tenant, and so is claimed in the registry. */
export const CLAIM_NAMESPACES = ['tenant-id', 'tenant-slug', 'hostname'] as const;
export type ClaimNamespace = (typeof CLAIM_NAMESPACES)[number];

/** The registry's owner name, and a tenant directory object's (the `owner` column, rfc §7.1). */
export const REGISTRY_OWNER = 'registry';
export const tenantOwnerOf = (tenantId: string): string => `tenant:${tenantId}`;

/** The default lease on a claim: long enough for host code to make two calls, short enough that a
 *  crossing whose caller died does not hold a hostname for long. */
export const DEFAULT_CLAIM_LEASE_MS = 5 * 60 * 1000;

export type ClaimState = 'leased' | 'confirmed' | 'tombstone';

export interface ClaimRow {
  namespace: ClaimNamespace;
  claimKey: string;
  claimId: string;
  holder: string;
  scopeId: string | null;
  jurisdiction: string | null;
  state: ClaimState;
  leaseUntil: string | null;
  claimedAt: string;
  confirmedAt: string | null;
}

export interface ClaimInput {
  namespace: ClaimNamespace;
  key: string;
  /** The crossing's id. A repeated claim with the same id is the same claim. */
  claimId: string;
  /** The tenant the key is claimed for. */
  holder: string;
  scopeId?: string | null;
  /** On a `tenant-id` claim: the jurisdiction of the tenant's directory object (K-7), fixed here. */
  jurisdiction?: string | null;
  leaseMs: number;
}

export type ClaimOutcome =
  | { ok: true; claim: ClaimRow }
  | { ok: false; reason: 'held'; holder: string }
  | { ok: false; reason: 'tombstone'; holder: string };

export interface ConfirmInput {
  namespace: ClaimNamespace;
  key: string;
  claimId: string;
}

export type ConfirmOutcome = { ok: true; claim: ClaimRow } | { ok: false; reason: 'expired' | 'superseded' | 'missing' };

export interface ReleaseInput {
  namespace: ClaimNamespace;
  key: string;
  claimId: string;
  /** Keep the key held for good (a reaped tenant's id is never reused, rfc §7.3). */
  tombstone?: boolean;
}

export type CrossingState = 'intent' | 'claimed' | 'done' | 'failed';

export interface CrossingRow {
  crossingId: string;
  owner: string;
  kind: string;
  namespace: ClaimNamespace;
  claimKey: string;
  holder: string;
  scopeId: string | null;
  jurisdiction: string | null;
  payload: unknown;
  leaseMs: number;
  state: CrossingState;
  outcome: string | null;
  attempts: number;
  createdAt: string;
  updatedAt: string;
}

export interface CrossingInput {
  crossingId: string;
  kind: string;
  namespace: ClaimNamespace;
  key: string;
  holder: string;
  scopeId?: string | null;
  jurisdiction?: string | null;
  /** What the second half needs, as JSON. */
  payload?: unknown;
  leaseMs?: number;
}

export interface SettleInput {
  state: 'done' | 'failed';
  outcome?: string | null;
}

const iso = (ms: number): string => new Date(ms).toISOString();

function assertNamespace(namespace: string): asserts namespace is ClaimNamespace {
  if (!(CLAIM_NAMESPACES as readonly string[]).includes(namespace)) {
    throw new Error(`not a directory claim namespace: ${JSON.stringify(namespace)}`);
  }
}

function claimOf(r: Record<string, unknown>): ClaimRow {
  return {
    namespace: r.namespace as ClaimNamespace,
    claimKey: r.claim_key as string,
    claimId: r.claim_id as string,
    holder: r.holder as string,
    scopeId: (r.scope_id as string | null) ?? null,
    jurisdiction: (r.jurisdiction as string | null) ?? null,
    state: r.state as ClaimState,
    leaseUntil: (r.lease_until as string | null) ?? null,
    claimedAt: r.claimed_at as string,
    confirmedAt: (r.confirmed_at as string | null) ?? null,
  };
}

const CLAIM_COLUMNS = 'namespace, claim_key, claim_id, holder, scope_id, jurisdiction, state, lease_until, claimed_at, confirmed_at';

export function readClaimIn(sql: SwitchSql, namespace: ClaimNamespace, key: string): ClaimRow | null {
  const [row] = sql.all(`SELECT ${CLAIM_COLUMNS} FROM _substrat_directory_claims WHERE namespace = ? AND claim_key = ?`, namespace, key);
  return row ? claimOf(row) : null;
}

/** A leased claim whose lease has run out is nobody's: the next claimant supersedes it. */
const leaseLive = (claim: ClaimRow, nowMs: number): boolean => claim.state !== 'leased' || (claim.leaseUntil !== null && claim.leaseUntil > iso(nowMs));

/**
 * Claim `key` for `holder`, keyed by the crossing's id. Refuses a key another crossing holds
 * (confirmed, or leased and still live) and a tombstone. A repeated claim with the same id answers
 * the same claim (a lease that ran out meanwhile is leased afresh, since nobody superseded it).
 * Run it inside the registry's transaction.
 */
export function claimIn(sql: SwitchSql, input: ClaimInput & { nowMs: number }): ClaimOutcome {
  assertNamespace(input.namespace);
  if (!Number.isFinite(input.leaseMs) || input.leaseMs < 0) throw new Error(`not a lease: ${input.leaseMs}`);
  const now = iso(input.nowMs);
  const leaseUntil = iso(input.nowMs + input.leaseMs);
  const existing = readClaimIn(sql, input.namespace, input.key);
  if (existing) {
    if (existing.state === 'tombstone') return { ok: false, reason: 'tombstone', holder: existing.holder };
    if (existing.claimId === input.claimId) {
      if (leaseLive(existing, input.nowMs)) return { ok: true, claim: existing };
      sql.run(
        `UPDATE _substrat_directory_claims SET lease_until = ?, claimed_at = ? WHERE namespace = ? AND claim_key = ? AND claim_id = ?`,
        leaseUntil, now, input.namespace, input.key, input.claimId,
      );
      return { ok: true, claim: readClaimIn(sql, input.namespace, input.key)! };
    }
    if (leaseLive(existing, input.nowMs)) return { ok: false, reason: 'held', holder: existing.holder };
    // An expired lease of another crossing: superseded. Its confirm will refuse.
    sql.run(`DELETE FROM _substrat_directory_claims WHERE namespace = ? AND claim_key = ?`, input.namespace, input.key);
  }
  sql.run(
    `INSERT INTO _substrat_directory_claims (${CLAIM_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, 'leased', ?, ?, NULL)`,
    input.namespace, input.key, input.claimId, input.holder, input.scopeId ?? null, input.jurisdiction ?? null, leaseUntil, now,
  );
  return { ok: true, claim: readClaimIn(sql, input.namespace, input.key)! };
}

/**
 * Turn a live claim permanent. Refuses one another crossing superseded (or a tombstone), one never
 * made, and one whose lease ran out — which it also deletes, so its key is free at once rather than
 * held until the next claimant supersedes it. Confirming a confirmed claim answers ok.
 */
export function confirmClaimIn(sql: SwitchSql, input: ConfirmInput & { nowMs: number }): ConfirmOutcome {
  assertNamespace(input.namespace);
  const existing = readClaimIn(sql, input.namespace, input.key);
  if (!existing) return { ok: false, reason: 'missing' };
  if (existing.claimId !== input.claimId || existing.state === 'tombstone') return { ok: false, reason: 'superseded' };
  if (existing.state === 'confirmed') return { ok: true, claim: existing };
  if (!leaseLive(existing, input.nowMs)) {
    sql.run(`DELETE FROM _substrat_directory_claims WHERE namespace = ? AND claim_key = ? AND claim_id = ?`, input.namespace, input.key, input.claimId);
    return { ok: false, reason: 'expired' };
  }
  sql.run(
    `UPDATE _substrat_directory_claims SET state = 'confirmed', lease_until = NULL, confirmed_at = ?
      WHERE namespace = ? AND claim_key = ? AND claim_id = ?`,
    iso(input.nowMs), input.namespace, input.key, input.claimId,
  );
  return { ok: true, claim: readClaimIn(sql, input.namespace, input.key)! };
}

/** Release a claim this crossing holds, or keep it as a tombstone. A claim another crossing holds is left alone. */
export function releaseClaimIn(sql: SwitchSql, input: ReleaseInput): { released: boolean } {
  assertNamespace(input.namespace);
  const existing = readClaimIn(sql, input.namespace, input.key);
  if (!existing || existing.claimId !== input.claimId) return { released: false };
  if (input.tombstone) {
    sql.run(
      `UPDATE _substrat_directory_claims SET state = 'tombstone', lease_until = NULL WHERE namespace = ? AND claim_key = ? AND claim_id = ?`,
      input.namespace, input.key, input.claimId,
    );
  } else {
    sql.run(`DELETE FROM _substrat_directory_claims WHERE namespace = ? AND claim_key = ? AND claim_id = ?`, input.namespace, input.key, input.claimId);
  }
  return { released: true };
}

const CROSSING_COLUMNS =
  'crossing_id, owner, kind, namespace, claim_key, holder, scope_id, jurisdiction, payload, lease_ms, state, outcome, attempts, created_at, updated_at';

function crossingOf(r: Record<string, unknown>): CrossingRow {
  return {
    crossingId: r.crossing_id as string,
    owner: r.owner as string,
    kind: r.kind as string,
    namespace: r.namespace as ClaimNamespace,
    claimKey: r.claim_key as string,
    holder: r.holder as string,
    scopeId: (r.scope_id as string | null) ?? null,
    jurisdiction: (r.jurisdiction as string | null) ?? null,
    payload: JSON.parse(r.payload as string),
    leaseMs: Number(r.lease_ms),
    state: r.state as CrossingState,
    outcome: (r.outcome as string | null) ?? null,
    attempts: Number(r.attempts),
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

export function crossingIn(sql: SwitchSql, owner: string, crossingId: string): CrossingRow | null {
  const [row] = sql.all(`SELECT ${CROSSING_COLUMNS} FROM _substrat_directory_crossings WHERE owner = ? AND crossing_id = ?`, owner, crossingId);
  return row ? crossingOf(row) : null;
}

/**
 * Record a crossing's intent. Call it inside the deciding object's transaction, beside the decision
 * and its admin row. Recording the same id again returns the row already there (and refuses one
 * that names a different key), so a caller retrying its own request does not start a second.
 */
export function recordCrossingIn(sql: SwitchSql, owner: string, input: CrossingInput & { nowMs: number }): CrossingRow {
  assertNamespace(input.namespace);
  const existing = crossingIn(sql, owner, input.crossingId);
  if (existing) {
    if (existing.namespace !== input.namespace || existing.claimKey !== input.key || existing.holder !== input.holder) {
      throw new Error(`crossing ${input.crossingId} is already recorded for ${existing.namespace} ${existing.claimKey}`);
    }
    return existing;
  }
  const now = iso(input.nowMs);
  sql.run(
    `INSERT INTO _substrat_directory_crossings (${CROSSING_COLUMNS})
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'intent', NULL, 0, ?, ?)`,
    input.crossingId, owner, input.kind, input.namespace, input.key, input.holder, input.scopeId ?? null,
    input.jurisdiction ?? null, JSON.stringify(input.payload ?? null), input.leaseMs ?? DEFAULT_CLAIM_LEASE_MS, now, now,
  );
  return crossingIn(sql, owner, input.crossingId)!;
}

/** `intent` → `claimed`, once the registry answered the claim. False when it had already moved. */
export function markCrossingClaimedIn(sql: SwitchSql, owner: string, crossingId: string, nowMs: number): boolean {
  const before = crossingIn(sql, owner, crossingId);
  if (!before || before.state !== 'intent') return false;
  sql.run(
    `UPDATE _substrat_directory_crossings SET state = 'claimed', attempts = attempts + 1, updated_at = ?
      WHERE owner = ? AND crossing_id = ? AND state = 'intent'`,
    iso(nowMs), owner, crossingId,
  );
  return true;
}

/**
 * Settle an open crossing `done` or `failed`. A compare-and-set from `intent` or `claimed`: a
 * second settle (two runners racing) answers false and changes nothing. In steps 3b on, the
 * deciding object applies the crossing's effect in this same transaction.
 */
export function settleCrossingIn(sql: SwitchSql, owner: string, crossingId: string, settle: SettleInput & { nowMs: number }): boolean {
  const before = crossingIn(sql, owner, crossingId);
  if (!before || (before.state !== 'intent' && before.state !== 'claimed')) return false;
  sql.run(
    `UPDATE _substrat_directory_crossings SET state = ?, outcome = ?, updated_at = ?
      WHERE owner = ? AND crossing_id = ? AND state IN ('intent', 'claimed')`,
    settle.state, settle.outcome ?? null, iso(settle.nowMs), owner, crossingId,
  );
  return true;
}

/** Open crossings last touched before `updatedBefore`: what the safety net resumes (rfc §7.3). */
export function openCrossingsIn(sql: SwitchSql, owner: string, query: { updatedBefore: string; limit: number }): CrossingRow[] {
  return sql
    .all(
      `SELECT ${CROSSING_COLUMNS} FROM _substrat_directory_crossings
        WHERE owner = ? AND state IN ('intent', 'claimed') AND updated_at < ?
        ORDER BY updated_at, crossing_id LIMIT ?`,
      owner, query.updatedBefore, query.limit,
    )
    .map(crossingOf);
}

/** The registry's half, as host code reaches it (an RPC stub on Cloudflare, the one database on SQLite). */
export interface DirectoryClaimsPort {
  claim(input: ClaimInput): Promise<ClaimOutcome>;
  confirmClaim(input: ConfirmInput): Promise<ConfirmOutcome>;
  releaseClaim(input: ReleaseInput): Promise<{ released: boolean }>;
  readClaim(namespace: ClaimNamespace, key: string): Promise<ClaimRow | null>;
}

/** A deciding object's ledger, as host code reaches it. */
export interface CrossingLedgerPort {
  /** `registry`, or `tenant:<id>`. */
  readonly owner: string;
  recordCrossing(input: CrossingInput): Promise<CrossingRow>;
  crossing(crossingId: string): Promise<CrossingRow | null>;
  markCrossingClaimed(crossingId: string): Promise<boolean>;
  settleCrossing(crossingId: string, settle: SettleInput): Promise<boolean>;
  openCrossings(query: { updatedBefore: string; limit: number }): Promise<CrossingRow[]>;
}

/**
 * The seam the contract suites are written against (rfc §11): the directory's objects as host code
 * reaches them. The Cloudflare adapter answers with a registry object and one directory object per
 * tenant; `adapter-sqlite` with one database behind every port.
 */
export interface DirectoryObjects {
  registry(): DirectoryClaimsPort & CrossingLedgerPort;
  tenant(tenantId: string): CrossingLedgerPort;
  /**
   * Drive a crossing recorded in `ledger`'s object to its end, and answer its row. On Cloudflare,
   * `runCrossing` across the two objects; on one database, `runCrossingSync` in one transaction.
   */
  complete(ledger: CrossingLedgerPort, crossingId: string): Promise<CrossingRow>;
}

const refusalText = (r: Exclude<ClaimOutcome, { ok: true }>): string => (r.reason === 'held' ? `held by ${r.holder}` : `tombstone of ${r.holder}`);

/**
 * Drive one crossing from wherever it stopped to `done` or `failed`. Every step is its own
 * transaction in its own object, so this is host code, never called inside a transaction. Safe to
 * run again after a crash at any point, and safe to run twice at once: each step is keyed by the
 * crossing's id and each move is a compare-and-set.
 */
export async function runCrossing(ledger: CrossingLedgerPort, claims: DirectoryClaimsPort, crossingId: string): Promise<CrossingRow> {
  let crossing = await ledger.crossing(crossingId);
  if (!crossing) throw new Error(`no crossing ${crossingId} in ${ledger.owner}`);
  if (crossing.state === 'intent') {
    const claimed = await claims.claim({
      namespace: crossing.namespace, key: crossing.claimKey, claimId: crossing.crossingId, holder: crossing.holder,
      scopeId: crossing.scopeId, jurisdiction: crossing.jurisdiction, leaseMs: crossing.leaseMs,
    });
    if (!claimed.ok) {
      await ledger.settleCrossing(crossingId, { state: 'failed', outcome: refusalText(claimed) });
      return (await ledger.crossing(crossingId))!;
    }
    await ledger.markCrossingClaimed(crossingId);
    crossing = (await ledger.crossing(crossingId))!;
  }
  if (crossing.state === 'claimed') {
    const confirmed = await claims.confirmClaim({ namespace: crossing.namespace, key: crossing.claimKey, claimId: crossing.crossingId });
    await ledger.settleCrossing(crossingId, confirmed.ok ? { state: 'done' } : { state: 'failed', outcome: confirmed.reason });
    crossing = (await ledger.crossing(crossingId))!;
  }
  return crossing;
}

/**
 * The same steps over ONE database, for a directory whose registry and tenant rows share it
 * (`adapter-sqlite`, rfc §11). The caller runs it inside one transaction, so a crossing there never
 * has an intermediate state anybody can read.
 */
export function runCrossingSync(sql: SwitchSql, owner: string, crossingId: string, nowMs: number): CrossingRow {
  let crossing = crossingIn(sql, owner, crossingId);
  if (!crossing) throw new Error(`no crossing ${crossingId} in ${owner}`);
  if (crossing.state === 'intent') {
    const claimed = claimIn(sql, {
      namespace: crossing.namespace, key: crossing.claimKey, claimId: crossing.crossingId, holder: crossing.holder,
      scopeId: crossing.scopeId, jurisdiction: crossing.jurisdiction, leaseMs: crossing.leaseMs, nowMs,
    });
    if (!claimed.ok) {
      settleCrossingIn(sql, owner, crossingId, { state: 'failed', outcome: refusalText(claimed), nowMs });
      return crossingIn(sql, owner, crossingId)!;
    }
    markCrossingClaimedIn(sql, owner, crossingId, nowMs);
    crossing = crossingIn(sql, owner, crossingId)!;
  }
  if (crossing.state === 'claimed') {
    const confirmed = confirmClaimIn(sql, { namespace: crossing.namespace, key: crossing.claimKey, claimId: crossing.crossingId, nowMs });
    settleCrossingIn(sql, owner, crossingId, confirmed.ok ? { state: 'done', nowMs } : { state: 'failed', outcome: confirmed.reason, nowMs });
    crossing = crossingIn(sql, owner, crossingId)!;
  }
  return crossing;
}

/**
 * The seam over one database: every port reads and writes the same `sql`, and `complete` runs the
 * whole crossing in one `transaction`. `now` is the host's clock (an injected one in a test).
 */
export function oneDatabaseDirectoryObjects(sql: SwitchSql, options: { now: () => number; transaction: <T>(fn: () => T) => T }): DirectoryObjects {
  const { now, transaction } = options;
  const ledger = (owner: string): CrossingLedgerPort => ({
    owner,
    recordCrossing: async (input) => transaction(() => recordCrossingIn(sql, owner, { ...input, nowMs: now() })),
    crossing: async (id) => crossingIn(sql, owner, id),
    markCrossingClaimed: async (id) => transaction(() => markCrossingClaimedIn(sql, owner, id, now())),
    settleCrossing: async (id, settle) => transaction(() => settleCrossingIn(sql, owner, id, { ...settle, nowMs: now() })),
    openCrossings: async (query) => openCrossingsIn(sql, owner, query),
  });
  const registry = {
    ...ledger(REGISTRY_OWNER),
    claim: async (input: ClaimInput) => transaction(() => claimIn(sql, { ...input, nowMs: now() })),
    confirmClaim: async (input: ConfirmInput) => transaction(() => confirmClaimIn(sql, { ...input, nowMs: now() })),
    releaseClaim: async (input: ReleaseInput) => transaction(() => releaseClaimIn(sql, input)),
    readClaim: async (namespace: ClaimNamespace, key: string) => readClaimIn(sql, namespace, key),
  };
  return {
    registry: () => registry,
    tenant: (tenantId) => ledger(tenantOwnerOf(tenantId)),
    complete: async (port, id) => transaction(() => runCrossingSync(sql, port.owner, id, now())),
  };
}
