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
  -- Expired rows are pruned on exchange (bounded work, on the only path that adds one).
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

/** A secret or token that cannot be one of ours is refused before it is ever hashed. */
const TOKEN_MAX_LENGTH = 128;
const plausible = (token: unknown, prefix: string): token is string =>
  typeof token === 'string' && token.startsWith(prefix) && token.length <= TOKEN_MAX_LENGTH;

// ---------------------------------------------------------------------------
// The minting invocation's secrets — kept out of every stored row.
// ---------------------------------------------------------------------------

/**
 * Does `value` carry any of `secrets`, anywhere? A deep walk over what JSON can hold, so a
 * secret nested in an event payload, or spliced into a link inside a string, is found.
 */
export function carriesSecret(value: unknown, secrets: readonly string[]): boolean {
  if (secrets.length === 0) return false;
  if (typeof value === 'string') return secrets.some((s) => value.includes(s));
  if (Array.isArray(value)) return value.some((v) => carriesSecret(v, secrets));
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some((v) => carriesSecret(v, secrets));
  }
  return false;
}

/** What a recorded response carries in place of a minted secret. */
export const WITHHELD_SECRET = '[capability secret withheld]';

/**
 * `value` with every minted secret replaced by `WITHHELD_SECRET` — what an idempotency
 * recording stores. A replayed mint therefore returns the placeholder, never the secret:
 * the caller that lost the first response mints again, which is the honest outcome, since
 * the alternative is a plaintext secret in a spine table for a day.
 */
export function redactSecrets<T>(value: T, secrets: readonly string[]): T {
  if (secrets.length === 0) return value;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      let out = v;
      for (const s of secrets) out = out.split(s).join(WITHHELD_SECRET);
      return out;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]),
      );
    }
    return v;
  };
  return walk(value) as T;
}

/**
 * Refuse a write that would put a minted secret into storage. Thrown from `ctx.emit`,
 * `ctx.requestPlatform` and `ctx.sql` while the minting invocation runs: the kernel stores
 * only the secret's hash, and a module that wrote the secret into its own table or onto an
 * event would undo that in a row the platform keeps forever.
 */
export function assertNoSecret(where: string, value: unknown, secrets: readonly string[]): void {
  if (carriesSecret(value, secrets)) {
    throw substratError(
      'forbidden',
      `${where} would store a capability secret. Only its hash is ever kept — return the ` +
        'secret to the caller once, and never write it to a row or an event.',
      { reason: 'capability_secret' },
    );
  }
}

/** `ctx.sql` with every statement's text and parameters held to `assertNoSecret`. */
export function guardSecrets(inner: ScopedSql, secrets: readonly string[]): ScopedSql {
  return {
    query: (sql, params) => {
      assertNoSecret('ctx.sql', [sql, ...(params ?? [])].map(String), secrets);
      return inner.query(sql, params);
    },
    exec: (sql, params) => {
      assertNoSecret('ctx.sql', [sql, ...(params ?? [])].map(String), secrets);
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
): Promise<CapabilityExchange | null> {
  if (!plausible(secret, CAPABILITY_SECRET_PREFIX)) return null;
  const tokenHash = await capabilityTokenHash(secret);
  const row = deps.sql.query<CapabilityRow>(
    `SELECT ${CAPABILITY_COLUMNS} FROM _substrat_capabilities WHERE token_hash = ?`,
    [tokenHash],
  )[0];
  if (!row || !capabilityExchangeable(row, deps.now)) return null;
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
  deps.sql.exec('DELETE FROM _substrat_capability_sessions WHERE expires_at <= ?', [deps.now]);
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
