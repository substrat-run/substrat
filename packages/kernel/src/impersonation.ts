/**
 * The rules an impersonated session is held to (K-42, #868) — kernel-side, so
 * both adapters enforce the same ones.
 *
 * An adapter supplies storage and a clock. Everything that decides whether a
 * session may be opened, whether it may still be used, and what it may do lives
 * here: a rule implemented twice is a rule that will eventually be two rules,
 * and this is not a surface where the two versions may drift.
 *
 * What is deliberately NOT here: the permission evaluation. An impersonated
 * operation checks as the impersonated principal through the ordinary
 * `PermissionChecker`, with no override branch anywhere — the same discipline
 * that made `system:<moduleId>` a subject rather than a bypass (#383). A door
 * that grants authority by opening is a door nobody can audit.
 */
import {
  DEFAULT_IMPERSONATION_LIMIT,
  IMPERSONATION_DEFAULT_MINUTES,
  IMPERSONATION_MAX_MINUTES,
  beginImpersonationInput,
  impersonationFilter,
  impersonationSession,
  SubstratError,
  type BeginImpersonationInput,
  type ImpersonationFilter,
  type ImpersonationSession,
  type ImpersonationSessionId,
  type ImpersonationStamp,
  type Instant,
  type PlatformActorId,
  type ScopeId,
  type TenantId,
} from '@substrat-run/contracts';

/**
 * A session refused: expired, ended, pointed at the wrong scope, or asked to do
 * something a `read-only` session may not.
 *
 * `forbidden` rather than `permission_denied`, and the distinction is worth the
 * separate class: the principal being impersonated may well hold the permission,
 * and the check may well have passed. What refused is the SESSION. Recording
 * this in the denial log would put a row there about a permission nobody was
 * actually denied.
 */
export class ImpersonationRefused extends SubstratError {
  constructor(message: string) {
    super('forbidden', message);
    this.name = 'ImpersonationRefused';
  }
}

/**
 * Mint a session from a staff request. Pure: the caller supplies the id and the
 * instant, so a frozen clock produces a deterministic session (#812) and the
 * adapter keeps its one source of ULIDs.
 *
 * `minutes` is CAPPED BY THE SCHEMA rather than clamped here — a caller asking
 * for a day is refused with a parse error naming the ceiling, because silently
 * handing back a shorter session than was asked for is how somebody comes to
 * believe they have one that is still open.
 */
export function newImpersonationSession(
  id: string,
  actor: PlatformActorId,
  input: BeginImpersonationInput,
  now: Instant,
): ImpersonationSession {
  const parsed = beginImpersonationInput.parse(input);
  const minutes = parsed.minutes ?? IMPERSONATION_DEFAULT_MINUTES;
  const expiresAt = new Date(Date.parse(now) + minutes * 60_000).toISOString();
  return impersonationSession.parse({
    id,
    actor,
    principal: parsed.principal,
    tenantId: parsed.tenantId,
    scopeId: parsed.scopeId,
    reason: parsed.reason,
    mode: parsed.mode ?? 'read-only',
    startedAt: now,
    expiresAt,
    endedAt: null,
  });
}

/**
 * Is this session usable, right now, for this scope?
 *
 * Called at the DOOR and again on EVERY INVOKE. Twice deliberately: a stub is a
 * capability and nothing forces a caller to drop it, so a session checked only
 * when the stub was minted would be a session whose expiry meant nothing to the
 * one caller holding it — the exact shape of a time-box that is not one.
 *
 * Expiry is compared as ISO text, which sorts lexicographically, so neither
 * adapter parses a date to answer it.
 */
export function assertSessionUsable(
  session: ImpersonationSession,
  now: Instant,
  at?: { tenantId: TenantId; scopeId: ScopeId },
): void {
  if (session.endedAt !== null) {
    throw new ImpersonationRefused(
      `impersonation session ${session.id} was ended at ${session.endedAt}`,
    );
  }
  if (session.expiresAt <= now) {
    throw new ImpersonationRefused(
      `impersonation session ${session.id} expired at ${session.expiresAt} — open a new one`,
    );
  }
  if (at && (at.tenantId !== session.tenantId || at.scopeId !== session.scopeId)) {
    // K-3's fail-closed posture: a session names one scope, and a mismatched
    // pair resolves to nothing rather than to somebody else's data.
    throw new ImpersonationRefused(
      `impersonation session ${session.id} is for (${session.tenantId}, ${session.scopeId}), ` +
        `not (${at.tenantId}, ${at.scopeId})`,
    );
  }
}

/**
 * The effecting verbs a `read-only` session refuses, by name.
 *
 * Refusing at the verb is the half a person notices; the transaction being
 * rolled back rather than committed is the half that is actually load-bearing,
 * since `ctx.sql.exec` can write a row without going through any of these. Both
 * are needed: without the rollback the guarantee is a promise about which
 * functions module code happens to call, and without the refusal a support
 * engineer watches a save appear to succeed and silently vanish.
 */
export function assertImpersonationWrites(
  session: ImpersonationSession | undefined,
  verb: string,
): void {
  if (!session || session.mode === 'write') return;
  throw new ImpersonationRefused(
    `${verb} is refused under a read-only impersonation session (${session.id}): ` +
      'open the session with mode \'write\' if acting is the intent',
  );
}

/** What the kernel stamps on a record raised under this session. */
export function impersonationStampOf(session: ImpersonationSession): ImpersonationStamp {
  return { session: session.id, by: session.actor };
}

/** Every column of `_substrat_impersonations`, in the order `mapImpersonationRow` expects. */
export const IMPERSONATION_COLUMNS =
  'id, actor, principal, tenant_id, scope_id, reason, mode, started_at, expires_at, ended_at';

/** The raw row shape, as either adapter hands it back. */
export interface ImpersonationRow {
  id: string;
  actor: string;
  principal: string;
  tenant_id: string;
  scope_id: string;
  reason: string;
  mode: string;
  started_at: string;
  expires_at: string;
  ended_at: string | null;
}

export function mapImpersonationRow(row: ImpersonationRow): ImpersonationSession {
  return impersonationSession.parse({
    id: row.id,
    actor: row.actor,
    principal: row.principal,
    tenantId: row.tenant_id,
    scopeId: row.scope_id,
    reason: row.reason,
    mode: row.mode,
    startedAt: row.started_at,
    expiresAt: row.expires_at,
    endedAt: row.ended_at ?? null,
  });
}

export function impersonationRowValues(session: ImpersonationSession): (string | null)[] {
  return [
    session.id,
    session.actor,
    session.principal,
    session.tenantId,
    session.scopeId,
    session.reason,
    session.mode,
    session.startedAt,
    session.expiresAt,
    session.endedAt,
  ];
}

/** Read one session by id — the door's own lookup, shared so both adapters spell it once. */
export function impersonationByIdQuery(id: ImpersonationSessionId | string): {
  sql: string;
  params: string[];
} {
  return {
    sql: `SELECT ${IMPERSONATION_COLUMNS} FROM _substrat_impersonations WHERE id = ?`,
    params: [String(id)],
  };
}

/**
 * A bounded page of sessions, newest first. `active` is resolved against the
 * caller's `now` rather than a stored flag: a session becomes inactive by the
 * clock moving, and a flag would need somebody to come and set it.
 */
export function impersonationListQuery(
  filter: ImpersonationFilter | undefined,
  now: Instant,
): { sql: string; params: (string | number)[] } {
  const f = impersonationFilter.parse(filter ?? {});
  const parts: string[] = [];
  const params: (string | number)[] = [];
  if (f.tenantId !== undefined) {
    parts.push('tenant_id = ?');
    params.push(f.tenantId);
  }
  if (f.scopeId !== undefined) {
    parts.push('scope_id = ?');
    params.push(f.scopeId);
  }
  if (f.actor !== undefined) {
    parts.push('actor = ?');
    params.push(f.actor);
  }
  if (f.principal !== undefined) {
    parts.push('principal = ?');
    params.push(f.principal);
  }
  if (f.active === true) {
    parts.push('ended_at IS NULL AND expires_at > ?');
    params.push(now);
  } else if (f.active === false) {
    parts.push('(ended_at IS NOT NULL OR expires_at <= ?)');
    params.push(now);
  }
  const where = parts.length ? ` WHERE ${parts.join(' AND ')}` : '';
  return {
    sql: `SELECT ${IMPERSONATION_COLUMNS} FROM _substrat_impersonations${where} ORDER BY id DESC LIMIT ?`,
    params: [...params, f.limit ?? DEFAULT_IMPERSONATION_LIMIT],
  };
}

/** The DDL both adapters create the session store from — one spelling, one shape. */
export const IMPERSONATION_DDL = `
  CREATE TABLE IF NOT EXISTS _substrat_impersonations (
    id          TEXT PRIMARY KEY,
    -- The REAL actor. Never a principal: a platform actor is branded apart from
    -- one precisely so a staff member can never read as a person in a trail.
    actor       TEXT NOT NULL,
    principal   TEXT NOT NULL,
    tenant_id   TEXT NOT NULL,
    scope_id    TEXT NOT NULL,
    reason      TEXT NOT NULL,
    mode        TEXT NOT NULL,
    started_at  TEXT NOT NULL,
    expires_at  TEXT NOT NULL,
    -- Explicitly closed, as distinct from expired. Never deleted (K-21): a
    -- session that once existed is why some rows carry the stamp they do.
    ended_at    TEXT
  );
  CREATE INDEX IF NOT EXISTS _substrat_impersonations_tenant ON _substrat_impersonations (tenant_id, id);
  CREATE INDEX IF NOT EXISTS _substrat_impersonations_actor ON _substrat_impersonations (actor, id);
`;
