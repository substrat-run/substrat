import {
  CAPABILITY_EXERCISED,
  CAPABILITY_MINTED,
  CAPABILITY_REVOKED,
  CAPABILITY_SECRET_PREFIX,
  CAPABILITY_SESSION_PREFIX,
  CAPABILITY_SESSION_TTL_MS,
  becomeCapabilityInput,
  capabilityAuthor,
  capabilityFilter,
  capabilityId as capabilityIdSchema,
  capabilityMintInput,
  capabilityRecord,
  permissionKey,
  principalId as principalIdSchema,
  substratError,
  type BecomeCapabilityInput,
  type CapabilityAuthor,
  type CapabilityExchange,
  type CapabilityExercisedPayload,
  type CapabilityFilter,
  type CapabilityId,
  type CapabilityMintInput,
  type CapabilityMintedPayload,
  type CapabilityRecord,
  type CapabilityRevokedPayload,
  type CheckSubject,
  type Decision,
  type DomainEventInput,
  type EntityRef,
  type Instant,
  type MintedCapability,
  type PermissionKey,
  type PlatformActorId,
  type PrincipalId,
} from '@substrat-run/contracts';
import { PermissionDenied } from './permission-checker.js';
import type { ScopedSql, SqlValue } from './scope-host.js';
import { ulid } from './ulid.js';

/**
 * The kernel half of capabilities (#1672) — the directory, the secret, and every decision
 * read off them, written ONCE for both adapters.
 *
 * `@substrat-run/contracts` owns the shapes (what may be minted, what a record and an
 * exchange look like); this owns the tables and the rules. The pure adapter and the
 * Durable-Object adapter each hand these functions a raw SQL seam over the scope's own
 * storage and their own `emit`, and nothing else — so "is this capability usable", "may
 * this secret be exchanged" and "what does a mint check" have one definition rather than
 * two that the contract suite has to keep in step. Same move `createTupleEvaluator` made
 * for the checker (#969), for the same reason.
 *
 * ## The directory is the scope's own spine
 *
 * A connection's directory row lives in the control plane because a connection is keyed
 * (tenant, vertical, provider) and reaches many scopes. A capability is minted by a
 * principal, inside one scope's operation, about one entity in that scope — and a hosted
 * vertical has no control plane to reach. So the row lives beside the entity: the mint
 * is transactional with the operation that makes it, a revoke is the very next read, the
 * checker (which runs inside the scope) reads it synchronously, and a secret presented to
 * another scope simply finds nothing.
 *
 * ## The secret
 *
 * 32 bytes from `crypto.getRandomValues` (256 bits), base64url, behind a recognisable
 * prefix so a secret scanner can flag a leaked one. Only its SHA-256 is stored, and every
 * lookup is an indexed equality on that hash inside SQL — no comparison of secrets ever
 * happens in JavaScript, so there is no timing channel to make constant-time. The session
 * token an exchange hands out is the same construction with its own prefix.
 */

// Declared locally so the kernel needs no platform type packages (§5.8) — the same
// posture `ulid.ts` and `sealed-box.ts` take.
declare const crypto: {
  getRandomValues<T extends Uint8Array>(array: T): T;
  subtle: { digest(algorithm: 'SHA-256', data: Uint8Array): Promise<ArrayBuffer> };
};
declare const TextEncoder: new () => { encode(input: string): Uint8Array };
declare const btoa: (input: string) => string;

/**
 * The two spine tables, kernel-owned so no vertical carries a migration for them. Shared by
 * both adapters' `KERNEL_DDL` (interpolated, like `IDEMPOTENCY_DDL`), so the shape
 * self-host builds and the shape production builds cannot part company.
 */
export const CAPABILITY_DDL = `
  CREATE TABLE IF NOT EXISTS _substrat_capabilities (
    id TEXT PRIMARY KEY,
    -- #1672: SHA-256 hex of the secret. The secret itself is stored NOWHERE — it leaves
    -- the kernel once, in the mint's return value, and a lookup is this indexed equality.
    token_hash TEXT NOT NULL UNIQUE,
    -- 'act': the holder acts AS the capability ({ capability } on the spine), bounded by
    -- entity + permissions (+ operations). 'become': exchanging it yields \`principal\`.
    mode TEXT NOT NULL,
    label TEXT,
    entity_type TEXT,
    entity_id TEXT,
    -- JSON array of permission keys (act). The capability's whole authority: no
    -- \`capability:\` tuple is ever written, so none can be forged through the tuple table.
    permissions TEXT,
    -- JSON array of operation names, or NULL = any operation the keys allow (act).
    operations TEXT,
    principal TEXT,
    -- JSON capabilityAuthor: a principal id (a module minted it, and its authority is
    -- re-checked on every use) or {"platform": …} (HostAdmin minted it).
    minted_by TEXT NOT NULL,
    minted_at TEXT NOT NULL,
    expires_at TEXT,
    -- NULL = unlimited. A use is an EXCHANGE of the secret, never an invocation.
    max_uses INTEGER,
    uses INTEGER NOT NULL DEFAULT 0,
    last_used_at TEXT,
    -- Tombstone, never a delete: a capability that once admitted someone is evidence
    -- of why they were admitted (K-4, K-21).
    revoked_at TEXT,
    revoked_by TEXT
  );
  CREATE INDEX IF NOT EXISTS _substrat_capabilities_entity
    ON _substrat_capabilities (entity_type, entity_id);
  -- #1672: what an exchange hands out instead of the secret — a session token, of which
  -- again only the hash is kept. Each session acts as its capability until the earlier of
  -- its own expiry and the capability's; the capability is re-read on every invoke, so
  -- revoking it ends every session at once — a revoke touches only the capability row,
  -- and it is that per-invoke read, not a cascade here, that refuses the next call.
  -- Expired rows are pruned on exchange, at most CAPABILITY_SESSION_PRUNE_BATCH at a time,
  -- on the only path that adds one — so an exchange's write is bounded however many expired.
  CREATE TABLE IF NOT EXISTS _substrat_capability_sessions (
    token_hash TEXT PRIMARY KEY,
    capability_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS _substrat_capability_sessions_expiry
    ON _substrat_capability_sessions (expires_at);
`;

/** One capability row as the spine stores it — snake_case, because that is what both adapters `SELECT`. */
export interface CapabilityRow {
  id: string;
  mode: string;
  label: string | null;
  entity_type: string | null;
  entity_id: string | null;
  permissions: string | null;
  operations: string | null;
  principal: string | null;
  minted_by: string;
  minted_at: string;
  expires_at: string | null;
  max_uses: number | null;
  uses: number;
  last_used_at: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
}

/** Every column a read returns — everything but `token_hash`, which no reader has a use for. */
export const CAPABILITY_COLUMNS =
  'id, mode, label, entity_type, entity_id, permissions, operations, principal, minted_by, ' +
  'minted_at, expires_at, max_uses, uses, last_used_at, revoked_at, revoked_by';

/** The row the permission checker reads for a capability subject (`ScopeTupleReader.capability`). */
export function capabilityByIdQuery(id: string): { sql: string; params: SqlValue[] } {
  return {
    sql: `SELECT ${CAPABILITY_COLUMNS} FROM _substrat_capabilities WHERE id = ?`,
    params: [id],
  };
}

/**
 * Is this capability USABLE — not revoked, not expired? The ONE predicate for it: the
 * permission checker, the session door and the exchange all call this, so the three can
 * never disagree about whether a revoked or expired capability still acts. Same shape as
 * the evaluator's `live()` for tuples, and ISO instants compare lexically.
 */
export const capabilityLive = (
  row: Pick<CapabilityRow, 'revoked_at' | 'expires_at'>,
  now: string,
): boolean => row.revoked_at === null && (row.expires_at === null || row.expires_at > now);

/**
 * May this capability's secret be EXCHANGED now — usable, and under its use limit? The use
 * limit bounds exchanges only: a session handed out by an earlier exchange keeps acting
 * after the limit is reached, until the capability expires or is revoked.
 */
export const capabilityExchangeable = (
  row: Pick<CapabilityRow, 'revoked_at' | 'expires_at' | 'max_uses' | 'uses'>,
  now: string,
): boolean => capabilityLive(row, now) && (row.max_uses === null || row.uses < row.max_uses);

/**
 * What an `act` capability grants, decoded for the checker — or `null` for anything that
 * cannot act (a `become` capability, a row whose JSON does not decode). Null DENIES: a row
 * the checker cannot read in full grants nothing, rather than whatever part of it parsed.
 */
export interface CapabilityGrantView {
  entity: EntityRef;
  permissions: PermissionKey[];
  /** Null when a platform actor minted it — which an `act` capability never is. */
  mintedBy: PrincipalId | null;
}

export function capabilityGrantOf(row: CapabilityRow): CapabilityGrantView | null {
  if (row.mode !== 'act' || row.entity_type === null || row.entity_id === null) return null;
  try {
    const permissions = (JSON.parse(row.permissions ?? 'null') as unknown[]).map((p) =>
      permissionKey.parse(p),
    );
    const author = capabilityAuthor.parse(JSON.parse(row.minted_by));
    return {
      entity: { entityType: row.entity_type, entityId: row.entity_id },
      permissions,
      mintedBy: typeof author === 'string' ? author : null,
    };
  } catch {
    return null;
  }
}

/** The record a caller reads back — never the secret, never its hash. */
export function capabilityRecordOf(row: CapabilityRow): CapabilityRecord {
  const common = {
    id: row.id,
    label: row.label,
    mintedBy: JSON.parse(row.minted_by),
    mintedAt: row.minted_at,
    expiresAt: row.expires_at,
    maxUses: row.max_uses,
    uses: row.uses,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    revokedBy: row.revoked_by === null ? null : JSON.parse(row.revoked_by),
  };
  return capabilityRecord.parse(
    row.mode === 'become'
      ? { mode: 'become', ...common, principal: row.principal }
      : {
          mode: 'act',
          ...common,
          entity: { entityType: row.entity_type, entityId: row.entity_id },
          permissions: JSON.parse(row.permissions ?? '[]'),
          operations: row.operations === null ? null : JSON.parse(row.operations),
        },
  );
}

const b64url = (bytes: Uint8Array): string => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/** A fresh capability secret: 256 bits, base64url, prefixed. Only its hash is ever stored. */
export function mintCapabilitySecret(): string {
  return CAPABILITY_SECRET_PREFIX + b64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** A fresh session token — the same construction, its own prefix. */
export function mintCapabilitySessionToken(): string {
  return CAPABILITY_SESSION_PREFIX + b64url(crypto.getRandomValues(new Uint8Array(32)));
}

/**
 * SHA-256 hex of a secret or session token (Web Crypto — the same call in workerd, node and
 * browsers). Unkeyed on purpose: with 256 bits of entropy there is no dictionary to defend
 * against, and a key would be one more secret to hold and rotate.
 */
export async function capabilityTokenHash(token: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  let hex = '';
  for (const b of new Uint8Array(buf)) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/**
 * How many expired sessions one exchange prunes, at most. An unlimited link can hand out any
 * number of sessions, so pruning every expired row at once would make one visitor's request
 * an unbounded write — and a Durable Object's transaction a large one. A fixed batch keeps
 * each exchange's cost constant, and the table still drains: every exchange takes another
 * batch, and an expired session acts as nobody whether or not it has been pruned yet.
 */
export const CAPABILITY_SESSION_PRUNE_BATCH = 100;

/** A secret or token that cannot be one of ours is refused before it is ever hashed. */
const TOKEN_MAX_LENGTH = 128;
const plausible = (token: unknown, prefix: string): token is string =>
  typeof token === 'string' && token.startsWith(prefix) && token.length <= TOKEN_MAX_LENGTH;

// ---------------------------------------------------------------------------
// The minting invocation's secrets — a tripwire, not a boundary.
// ---------------------------------------------------------------------------
//
// **What this guard is, and what it is not.** It catches a module ACCIDENTALLY persisting
// the secret it just minted — writing the link it built into its own table, putting it on
// an event, keying a map by it, handing it to an intent. Those are the mistakes an honest
// vertical makes, and each would leave a plaintext credential in a row the platform keeps
// forever, undoing "only the hash is stored" without anyone noticing.
//
// It is **not** a boundary against a module that MEANS to leak one. Module code holds the
// secret in memory and can transform it before writing (base64 it, reverse it, split it
// across two rows) and no scan of what reaches storage can recognise every encoding. That
// is a statement about module code, which is trusted with the secret it minted by
// construction: the secret has to be returned through it. The kernel's own guarantee is
// narrower and holds absolutely — nothing the KERNEL writes carries the secret, only its
// hash — and this tripwire extends it, best-effort, to what module code writes by accident.

// Declared locally for the same reason `TextEncoder` is above.
declare const TextDecoder: new () => { decode(input: Uint8Array): string };

const decodeBytes = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/**
 * The text a value would persist as — ONE serialization of the COMPLETE record, keys
 * included, byte values decoded as UTF-8. The guard scans this rather than walking chosen
 * fields, so a secret used as an entity id, a request kind, an object key or a BLOB
 * parameter is found exactly as one in a payload value is: there is no field list to
 * forget a field from. The secret's alphabet (base64url behind `sbcap_`) contains nothing
 * JSON escapes, so the serialization contains the secret exactly when the value does.
 */
export function persistedText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return decodeBytes(value);
  return (
    JSON.stringify(value, (_key, v: unknown) =>
      v instanceof Uint8Array ? decodeBytes(v) : typeof v === 'bigint' ? v.toString() : v,
    ) ?? ''
  );
}

/** Does `value`, serialized as it would persist (`persistedText`), contain any of `secrets`? */
export function carriesSecret(value: unknown, secrets: readonly string[]): boolean {
  if (secrets.length === 0) return false;
  const text = persistedText(value);
  return secrets.some((s) => text.includes(s));
}

/** What a recorded response carries in place of a minted secret. */
export const WITHHELD_SECRET = '[capability secret withheld]';

/**
 * `value` with every minted secret replaced by `WITHHELD_SECRET` — what an idempotency
 * recording stores. A replayed mint therefore returns the placeholder, never the secret:
 * the caller that lost the first response mints again, which is the honest outcome, since
 * the alternative is a plaintext secret in a spine table for a day.
 *
 * Done on the serialization, like the guard, so a secret in a key is withheld as surely as
 * one in a value. The recording is JSON already, so round-tripping through it changes
 * nothing the recording would have kept — and a value carrying no secret is returned as is.
 */
export function redactSecrets<T>(value: T, secrets: readonly string[]): T {
  if (value === undefined || !carriesSecret(value, secrets)) return value;
  let text = persistedText(value);
  for (const s of secrets) text = text.split(s).join(WITHHELD_SECRET);
  return JSON.parse(text) as T;
}

/**
 * The tripwire (see above): refuse a write whose COMPLETE record, as it would persist,
 * carries a secret this invocation minted. Thrown from `ctx.emit` (the whole parsed event),
 * `ctx.requestPlatform` (the whole parsed request) and `ctx.sql` (the statement and every
 * parameter, bytes decoded) while the minting invocation runs.
 */
export function assertNoSecret(where: string, record: unknown, secrets: readonly string[]): void {
  if (carriesSecret(record, secrets)) {
    throw substratError(
      'forbidden',
      `${where} would store a capability secret. Only its hash is ever kept — return the ` +
        'secret to the caller once, and never write it to a row or an event.',
      { reason: 'capability_secret' },
    );
  }
}

/** `ctx.sql` with every statement — its text and all its parameters — held to `assertNoSecret`. */
export function guardSecrets(inner: ScopedSql, secrets: readonly string[]): ScopedSql {
  return {
    query: (sql, params) => {
      assertNoSecret('ctx.sql', [sql, ...(params ?? [])], secrets);
      return inner.query(sql, params);
    },
    exec: (sql, params) => {
      assertNoSecret('ctx.sql', [sql, ...(params ?? [])], secrets);
      return inner.exec(sql, params);
    },
  };
}

// ---------------------------------------------------------------------------
// ctx.capabilities — mint, revoke, list, from inside an operation.
// ---------------------------------------------------------------------------

/** What an operation handler sees as `ctx.capabilities`. Nothing here checks a permission for the caller — the operation's own `assertAllowed` comes first. */
export interface CapabilityVerbs {
  /**
   * Mint an `act` capability over one entity and return its secret — the only time the
   * secret exists outside the caller's hands. Build the link from it (as a URL FRAGMENT,
   * so it never reaches a server log or a `Referer`) and return it once.
   *
   * **Delegation, never elevation, and on every use.** Every key is re-checked here on the
   * entity with the operation's own check, so a principal can only mint what they hold
   * there; and the checker re-checks the minter on every later use, so a capability never
   * grants more than its minter holds NOW. Revoke the minter's access and their links stop
   * granting it.
   *
   * Only a principal may mint — a capability, connection or schedule cannot delegate.
   * Transactional with the operation: a mint whose operation throws never happened.
   */
  mint(input: CapabilityMintInput): Promise<MintedCapability>;
  /**
   * Revoke an `act` capability. Takes effect on the very next check, for every session it
   * handed out. Allowed to anyone who could have minted it — every key it carries, held on
   * its entity — which is `ctx.revoke`'s rule. Idempotent on an already-revoked one.
   */
  revoke(id: CapabilityId): Promise<void>;
  /** This scope's capabilities, newest first. Revoked ones only when asked for. */
  list(filter?: CapabilityFilter): CapabilityRecord[];
}

export interface CapabilityVerbDeps {
  /** RAW spine access inside the operation's own transaction — not the guarded `ctx.sql`. */
  sql: ScopedSql;
  /** Who is minting. */
  subject: CheckSubject;
  /** The operation's instant. */
  now: Instant;
  /** The operation's OWN check — the same one `ctx.check` and `ctx.grant` use. */
  check: (permission: PermissionKey, entity?: EntityRef) => Promise<Decision>;
  /** `ctx.emit` — stamps the minter as actor, K-34 authorization, the operation. */
  emit: (event: DomainEventInput) => void;
  /** Is this an operation registered on this host? An allowlist naming none is a typo. */
  isOperation: (name: string) => boolean;
  /** K-42's read-only refusal, for the effecting verbs. */
  assertWrites: (verb: string) => void;
  /** This invocation's minted secrets — appended to by `mint`, read by the secret guards. */
  minted: string[];
}

const refToString = (e: EntityRef): string => `${e.entityType}:${e.entityId}`;

function principalOf(subject: CheckSubject, verb: string): PrincipalId {
  if (subject.kind !== 'principal') {
    throw substratError(
      'forbidden',
      `${verb}: only a principal may ${verb.endsWith('mint') ? 'mint' : 'revoke'} a capability — ` +
        `a ${subject.kind} actor cannot delegate authority it holds on someone else's behalf`,
      { reason: 'capability_delegation' },
    );
  }
  return subject.id;
}

export function createCapabilityVerbs(deps: CapabilityVerbDeps): CapabilityVerbs {
  const readRow = (id: string): CapabilityRow | undefined => {
    const q = capabilityByIdQuery(id);
    return deps.sql.query<CapabilityRow>(q.sql, q.params)[0];
  };

  return {
    async mint(raw) {
      deps.assertWrites('ctx.capabilities.mint');
      const minter = principalOf(deps.subject, 'ctx.capabilities.mint');
      const input = capabilityMintInput.parse(raw);
      const permissions = [...new Set(input.permissions)];
      const operations = input.operations ? [...new Set(input.operations)] : null;
      for (const op of operations ?? []) {
        if (!deps.isOperation(op)) {
          throw substratError(
            'validation_failed',
            `ctx.capabilities.mint: '${op}' is not an operation on this host — an allowlist ` +
              'naming nothing would read as a narrowing and narrow nothing',
          );
        }
      }
      if (input.expiresAt !== undefined && input.expiresAt <= deps.now) {
        throw substratError(
          'validation_failed',
          `ctx.capabilities.mint: expiresAt ${input.expiresAt} is not in the future`,
        );
      }
      // Delegation, never elevation — the SAME check the operation passes, per key, on the
      // entity. A plain `PermissionDenied` with no detail, like `ctx.grant`'s refusal: it is
      // the module's attempt that failed, and K-35 records enforced checks, not this.
      for (const permission of permissions) {
        const held = await deps.check(permission, input.entity);
        if (!held.allowed) {
          throw new PermissionDenied(
            `cannot mint a capability carrying '${permission}' on ${refToString(input.entity)} — ` +
              'the caller does not hold it there (a capability delegates, it never elevates)',
          );
        }
      }
      const id = capabilityIdSchema.parse(ulid());
      const secret = mintCapabilitySecret();
      const tokenHash = await capabilityTokenHash(secret);
      deps.sql.exec(
        `INSERT INTO _substrat_capabilities
           (id, token_hash, mode, label, entity_type, entity_id, permissions, operations,
            principal, minted_by, minted_at, expires_at, max_uses, uses)
         VALUES (?, ?, 'act', ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 0)`,
        [
          id,
          tokenHash,
          input.label ?? null,
          input.entity.entityType,
          input.entity.entityId,
          JSON.stringify(permissions),
          operations === null ? null : JSON.stringify(operations),
          JSON.stringify(minter),
          deps.now,
          input.expiresAt ?? null,
          input.maxUses ?? null,
        ],
      );
      deps.minted.push(secret);
      const payload: CapabilityMintedPayload = {
        capabilityId: id,
        entity: input.entity,
        permissions,
        operations,
        expiresAt: input.expiresAt ?? null,
        maxUses: input.maxUses ?? null,
        label: input.label ?? null,
        mintedBy: minter,
      };
      deps.emit({
        type: CAPABILITY_MINTED,
        schemaVersion: 1,
        entity: input.entity,
        piiClass: 'none',
        payload,
      });
      return { id, secret, expiresAt: input.expiresAt ?? null };
    },

    async revoke(rawId) {
      deps.assertWrites('ctx.capabilities.revoke');
      const revoker = principalOf(deps.subject, 'ctx.capabilities.revoke');
      const id = capabilityIdSchema.parse(rawId);
      const row = readRow(id);
      if (!row) throw substratError('not_found', `no capability ${id} in this scope`);
      const grant = capabilityGrantOf(row);
      if (!grant) {
        throw substratError(
          'forbidden',
          `capability ${id} was minted by the platform and is revoked through HostAdmin`,
          { reason: 'capability_platform_minted' },
        );
      }
      if (row.revoked_at !== null) return;
      for (const permission of grant.permissions) {
        const held = await deps.check(permission, grant.entity);
        if (!held.allowed) {
          throw new PermissionDenied(
            `cannot revoke capability ${id} — the caller does not hold '${permission}' on ` +
              `${refToString(grant.entity)} (a revoke is open to whoever could have minted it)`,
          );
        }
      }
      deps.sql.exec(
        `UPDATE _substrat_capabilities SET revoked_at = ?, revoked_by = ?
         WHERE id = ? AND revoked_at IS NULL`,
        [deps.now, JSON.stringify(revoker), id],
      );
      const payload: CapabilityRevokedPayload = {
        capabilityId: id,
        entity: grant.entity,
        revokedBy: revoker,
      };
      deps.emit({
        type: CAPABILITY_REVOKED,
        schemaVersion: 1,
        entity: grant.entity,
        piiClass: 'none',
        payload,
      });
    },

    list(raw) {
      const filter = capabilityFilter.parse(raw ?? {});
      const where: string[] = [];
      const params: SqlValue[] = [];
      if (filter.entity) {
        where.push('entity_type = ? AND entity_id = ?');
        params.push(filter.entity.entityType, filter.entity.entityId);
      }
      if (!filter.includeRevoked) where.push('revoked_at IS NULL');
      params.push(filter.limit ?? 50);
      const rows = deps.sql.query<CapabilityRow>(
        `SELECT ${CAPABILITY_COLUMNS} FROM _substrat_capabilities
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY id DESC LIMIT ?`,
        params,
      );
      return rows.map(capabilityRecordOf);
    },
  };
}

// ---------------------------------------------------------------------------
// The host-level verbs: exchange, the session door, and the platform's mint/revoke.
// ---------------------------------------------------------------------------

/** The pseudo-operation an exchange's spine event names, on `attachments.upload`'s pattern. */
export const CAPABILITY_EXCHANGE_OPERATION = 'capabilities.exchange';

/**
 * Trade a secret for what it grants — ONE counted use. Runs inside the scope's
 * serialization domain and a transaction the adapter opened; `emit` writes the
 * `capability.exercised` event with the capability as its actor.
 *
 * The use is taken with an `UPDATE … WHERE uses = ?` on the row just read, so it is atomic
 * even without the scope's single-writer guarantee: two exchanges racing for a single-use
 * capability cannot both see `uses = 0` and both win.
 *
 * `null` for an unknown, expired, revoked or used-up secret — one answer for all four, so
 * a caller probing for secrets learns nothing it can act on. Refused exchanges are not
 * recorded: their volume is whatever an attacker chooses, and with 256 bits of entropy
 * there is nothing a record of guesses would ever show (#130 is the rate control).
 */
export async function exchangeCapability(
  deps: {
    sql: ScopedSql;
    now: Instant;
    emit: (capability: CapabilityId, event: DomainEventInput) => void;
  },
  secret: unknown,
  /**
   * The only mode the caller can handle. A secret of the OTHER mode answers `null` without
   * taking a use: a claim link pasted into a share-link exchange must not be spent by a
   * route that would then throw away the principal it yielded.
   */
  mode?: 'act' | 'become',
): Promise<CapabilityExchange | null> {
  if (!plausible(secret, CAPABILITY_SECRET_PREFIX)) return null;
  const tokenHash = await capabilityTokenHash(secret);
  const row = deps.sql.query<CapabilityRow>(
    `SELECT ${CAPABILITY_COLUMNS} FROM _substrat_capabilities WHERE token_hash = ?`,
    [tokenHash],
  )[0];
  if (!row || !capabilityExchangeable(row, deps.now)) return null;
  if (mode !== undefined && row.mode !== mode) return null;
  const taken = deps.sql.exec(
    `UPDATE _substrat_capabilities SET uses = uses + 1, last_used_at = ?
     WHERE id = ? AND uses = ?`,
    [deps.now, row.id, row.uses],
  );
  if (taken.changes !== 1) return null;
  const id = capabilityIdSchema.parse(row.id);
  const uses = row.uses + 1;

  if (row.mode === 'become') {
    const principal = principalIdSchema.parse(row.principal);
    const payload: CapabilityExercisedPayload = {
      capabilityId: id,
      mode: 'become',
      uses,
      maxUses: row.max_uses,
      sessionExpiresAt: null,
      principal,
    };
    deps.emit(id, {
      type: CAPABILITY_EXERCISED,
      schemaVersion: 1,
      entity: { entityType: 'capability', entityId: id },
      piiClass: 'none',
      payload,
    });
    return { kind: 'principal', capabilityId: id, principal };
  }

  const grant = capabilityGrantOf(row);
  if (!grant) return null;
  const ttlEnd = new Date(Date.parse(deps.now) + CAPABILITY_SESSION_TTL_MS).toISOString();
  const expiresAt = (row.expires_at !== null && row.expires_at < ttlEnd
    ? row.expires_at
    : ttlEnd) as Instant;
  const sessionToken = mintCapabilitySessionToken();
  // Bounded (see CAPABILITY_SESSION_PRUNE_BATCH) — a subquery LIMIT rather than
  // `DELETE … LIMIT`, which SQLite accepts only when built with an option neither host
  // promises. The expiry index makes the inner select a range seek.
  deps.sql.exec(
    `DELETE FROM _substrat_capability_sessions WHERE token_hash IN (
       SELECT token_hash FROM _substrat_capability_sessions WHERE expires_at <= ? LIMIT ?)`,
    [deps.now, CAPABILITY_SESSION_PRUNE_BATCH],
  );
  deps.sql.exec(
    `INSERT INTO _substrat_capability_sessions (token_hash, capability_id, created_at, expires_at)
     VALUES (?, ?, ?, ?)`,
    [await capabilityTokenHash(sessionToken), id, deps.now, expiresAt],
  );
  const payload: CapabilityExercisedPayload = {
    capabilityId: id,
    mode: 'act',
    uses,
    maxUses: row.max_uses,
    sessionExpiresAt: expiresAt,
    principal: null,
  };
  deps.emit(id, {
    type: CAPABILITY_EXERCISED,
    schemaVersion: 1,
    entity: grant.entity,
    piiClass: 'none',
    payload,
  });
  return { kind: 'session', capabilityId: id, sessionToken, expiresAt, entity: grant.entity };
}

/**
 * The session door's decision, re-made on EVERY invoke inside the operation's transaction
 * (impersonation's per-invoke re-read, for the same reason): a stub is a capability of its
 * own and nothing takes it away, so a revocation checked only when the stub was minted
 * would stop everyone except the one caller holding it.
 *
 * Refuses an unknown or expired session and a revoked or expired capability as
 * `unauthenticated` — the credential no longer works, and re-opening a live link is the
 * remedy — and an operation outside the capability's allowlist as `forbidden`. None of
 * these is a K-35 denial: no permission key was checked, and the denial log records
 * enforced checks. The handler's own checks, once it runs, are.
 */
export function resolveCapabilitySession(
  sql: ScopedSql,
  sessionHash: string,
  now: Instant,
  operation: string,
): CapabilityId {
  const session = sql.query<{ capability_id: string; expires_at: string }>(
    `SELECT capability_id, expires_at FROM _substrat_capability_sessions WHERE token_hash = ?`,
    [sessionHash],
  )[0];
  if (!session || session.expires_at <= now) {
    throw substratError('unauthenticated', 'capability session is unknown or has expired');
  }
  const q = capabilityByIdQuery(session.capability_id);
  const row = sql.query<CapabilityRow>(q.sql, q.params)[0];
  if (!row || row.mode !== 'act' || !capabilityLive(row, now)) {
    throw substratError('unauthenticated', 'capability has been revoked or has expired');
  }
  if (row.operations !== null) {
    const allowed = JSON.parse(row.operations) as string[];
    if (!allowed.includes(operation)) {
      throw substratError(
        'forbidden',
        `capability ${row.id} may not invoke '${operation}' — it is not on the capability's ` +
          'operation list',
        { reason: 'capability_operation' },
      );
    }
  }
  return capabilityIdSchema.parse(row.id);
}

/** Is `token` shaped like a session token at all? Checked before it is hashed or sent anywhere. */
export const plausibleSessionToken = (token: unknown): token is string =>
  plausible(token, CAPABILITY_SESSION_PREFIX);

/**
 * The platform's mint (`HostAdmin.mintCapability`) — a `become` capability, which is the
 * only kind the platform mints and the only way one is minted in this first cut (see
 * `becomeCapabilityInput`). No spine event: a platform actor's act is the admin log's to
 * record, and the adapter records it there.
 */
/**
 * A platform mint's input, parsed and held to its one rule beyond the shape: an expiry in
 * the future. Its own function so a host whose storage sits across an RPC boundary can run
 * it on the near side, where a typed refusal still reaches the caller as one — the same
 * check `mintBecomeCapability` makes, not a second copy of it.
 */
export function checkBecomeInput(raw: BecomeCapabilityInput, now: Instant): BecomeCapabilityInput {
  const input = becomeCapabilityInput.parse(raw);
  if (input.expiresAt <= now) {
    throw substratError(
      'validation_failed',
      `mintCapability: expiresAt ${input.expiresAt} is not in the future`,
    );
  }
  return input;
}

export async function mintBecomeCapability(
  sql: ScopedSql,
  raw: BecomeCapabilityInput,
  actor: PlatformActorId,
  now: Instant,
): Promise<MintedCapability> {
  const input = checkBecomeInput(raw, now);
  const id = capabilityIdSchema.parse(ulid());
  const secret = mintCapabilitySecret();
  const author: CapabilityAuthor = { platform: actor };
  sql.exec(
    `INSERT INTO _substrat_capabilities
       (id, token_hash, mode, label, entity_type, entity_id, permissions, operations,
        principal, minted_by, minted_at, expires_at, max_uses, uses)
     VALUES (?, ?, 'become', ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?, 0)`,
    [
      id,
      await capabilityTokenHash(secret),
      input.label ?? null,
      input.principal,
      JSON.stringify(author),
      now,
      input.expiresAt,
      input.maxUses,
    ],
  );
  return { id, secret, expiresAt: input.expiresAt };
}

/**
 * The platform's revoke (`HostAdmin.revokeCapability`) — of any capability in the scope,
 * the operator's lever for a leaked link. Returns the row as it stood before, for the admin
 * log, or `undefined` when there is no such capability. Idempotent.
 */
export function revokeCapabilityAsPlatform(
  sql: ScopedSql,
  rawId: string,
  actor: PlatformActorId,
  now: Instant,
): CapabilityRecord | undefined {
  const id = capabilityIdSchema.parse(rawId);
  const q = capabilityByIdQuery(id);
  const row = sql.query<CapabilityRow>(q.sql, q.params)[0];
  if (!row) return undefined;
  const author: CapabilityAuthor = { platform: actor };
  sql.exec(
    `UPDATE _substrat_capabilities SET revoked_at = ?, revoked_by = ?
     WHERE id = ? AND revoked_at IS NULL`,
    [now, JSON.stringify(author), id],
  );
  return capabilityRecordOf(row);
}
