import type { SqlExec } from './introspect.js';

/**
 * Deleting what has expired (K-71's first half, `docs/rfc/tenant-scale.md` §10).
 *
 * Better Auth deletes a session or an OAuth token when somebody signs out, revokes or removes
 * a client, and nothing else does: a session that simply runs out, and every access and
 * refresh token an ordinary sign-in leaves behind, stay in the issuer's one Durable Object for
 * good. At a shared issuer that is the first of its two limits to arrive (§10: tokens alone
 * pass 10 GB within a year at 100,000 sign-ins a day). This module deletes them, in bounded
 * batches, from the object's own alarm (`auth-do.ts`).
 *
 * WHAT is deleted, each only once it is `grace` past its own `expires_at`:
 *
 *   - `oauth_access_token` — past expiry, introspection and `/userinfo` already answer
 *     inactive, so a deleted row and an expired one look the same to every caller.
 *   - `oauth_refresh_token` — the refresh grant refuses an expired token BEFORE it looks at
 *     `revoked`, so an expired one can neither refresh nor trigger family invalidation there.
 *     Kept while its rotation-replay window is open, and while any access token still names
 *     it (`refresh_id` has no `ON DELETE`, so deleting it would fail, or orphan the pointer).
 *   - `session` — kept while ANY OAuth token still names it. The tokens' `session_id` is
 *     `ON DELETE SET NULL`, and introspection reads a token with no session as one that is not
 *     session-bound: deleting an expired session would turn its tokens from inactive back to
 *     active. Tokens are deleted first, in the same run, so this waits only on live ones.
 *   - `verification` — sign-in challenges, authorization codes, parked BankID and GitHub
 *     steps, SMS cooldowns, and the reservation markers `reserveVerificationValue` writes.
 *     Every reader checks `expiresAt`, and Better Auth's own `findVerificationValue` already
 *     deletes every expired row on each call (one unbounded statement): this is the bounded
 *     backstop for an issuer nobody is calling, and the `expires_at` index makes Better Auth's
 *     own statement an index range instead of a table scan.
 *   - `oauth_client_assertion` — a `private_key_jwt` assertion's `jti`, kept to refuse a
 *     replay. Its `expires_at` is the assertion's own `exp`, after which the JWT is refused on
 *     its own.
 *
 * NOT deleted here: `oauth_consent` (a revoked consent is deleted by the plugin when it is
 * revoked; a granted one has no expiry), `account` (upstream tokens' expiries describe the
 * provider's tokens, not the link), `jwks` (a retired key still verifies tokens it signed), and
 * `sign_in_attempt`, which keeps its prune-on-write (`sign-in-log.ts`) as K-71 says.
 *
 * Every statement is bounded: a `DELETE … WHERE id IN (SELECT … ORDER BY expires_at LIMIT ?)`,
 * walking the `expires_at` index, never a statement over the whole table. Deleting twice is
 * deleting nothing, so a run interrupted anywhere is finished by the next.
 */

/** `off` touches nothing; `count` reads what `on` would delete and logs it; `on` deletes. */
export type PruneMode = 'off' | 'count' | 'on';

/** The declared key that turns the prune on (`manifest.ts`). Absent ⇒ `off`. */
export const PRUNE_EXPIRED = 'PRUNE_EXPIRED';
/** The declared key for how long a row is kept past its own expiry. */
export const PRUNE_GRACE_HOURS = 'PRUNE_GRACE_HOURS';

/**
 * The defaults. `graceHours` is a setting; the rest are the platform's bounds, options so a
 * test can shrink them and keep the ratios.
 */
export const PRUNE_DEFAULTS = {
  graceHours: 24,
  /** Rows per statement. */
  batch: 500,
  /** Statements per kind per run: 10,000 rows of each kind at most, before re-arming. */
  maxBatches: 20,
  /** The longest an active issuer goes between runs (the request path arms it). */
  intervalMs: 6 * 60 * 60_000,
  /** When a run stopped at `maxBatches`, the next starts this soon. */
  continueMs: 5_000,
  /** Never re-arm closer than this, so a row expiring every second cannot spin the alarm. */
  minGapMs: 60_000,
} as const;

export interface PruneSettings {
  mode: PruneMode;
  graceMs: number;
}

/** The two settings, read off the issuer's effective config. Anything unreadable is the default. */
export function pruneSettingsOf(cfg: Record<string, string | undefined>): PruneSettings {
  const raw = cfg[PRUNE_EXPIRED]?.trim().toLowerCase();
  const mode: PruneMode = raw === 'on' || raw === 'count' ? raw : 'off';
  const hours = Number(cfg[PRUNE_GRACE_HOURS]?.trim());
  const graceHours = cfg[PRUNE_GRACE_HOURS]?.trim() && Number.isFinite(hours) && hours >= 0 && hours <= 24 * 365
    ? hours
    : PRUNE_DEFAULTS.graceHours;
  return { mode, graceMs: graceHours * 60 * 60_000 };
}

export type PruneKind = 'oauth_access_token' | 'oauth_refresh_token' | 'session' | 'verification' | 'oauth_client_assertion';

interface KindRule {
  kind: PruneKind;
  /** What else must be true of `t` before it may go, beyond `t.expires_at < cut`. */
  guard: string;
  /** How many more times the guard binds the cut. */
  guardCuts: number;
}

/**
 * In this order, and the order is load-bearing: an access token goes before the refresh token
 * it names, and both before the session they name, so each guard sees only live dependants.
 */
const RULES: KindRule[] = [
  { kind: 'oauth_access_token', guard: '', guardCuts: 0 },
  {
    kind: 'oauth_refresh_token',
    guard: `AND (t.rotation_replay_expires_at IS NULL OR t.rotation_replay_expires_at < ?)
            AND NOT EXISTS (SELECT 1 FROM oauth_access_token a WHERE a.refresh_id = t.id)`,
    guardCuts: 1,
  },
  {
    kind: 'session',
    guard: `AND NOT EXISTS (SELECT 1 FROM oauth_access_token a WHERE a.session_id = t.id)
            AND NOT EXISTS (SELECT 1 FROM oauth_refresh_token r WHERE r.session_id = t.id)`,
    guardCuts: 0,
  },
  { kind: 'verification', guard: '', guardCuts: 0 },
  { kind: 'oauth_client_assertion', guard: '', guardCuts: 0 },
];

/** Plain `?` placeholders: better-sqlite3 does not bind `?NNN` positionally. */
const candidates = (r: KindRule): string =>
  `SELECT t.id FROM ${r.kind} t WHERE t.expires_at < ? ${r.guard} ORDER BY t.expires_at LIMIT ?`;
const bindings = (r: KindRule, cut: number, limit: number): number[] => [cut, ...Array<number>(r.guardCuts).fill(cut), limit];

export interface PruneOptions {
  mode: Exclude<PruneMode, 'off'>;
  graceMs: number;
  batch?: number;
  maxBatches?: number;
}

export interface PruneResult {
  /** Rows deleted (`on`) or that would be (`count`), per kind. A count is at most `batch × maxBatches`. */
  counts: Record<PruneKind, number>;
  /** A kind stopped at its bound with rows left: run again soon. */
  more: boolean;
}

/** Delete (or count) what is `graceMs` past its expiry at `now`, in bounded statements. */
export function pruneExpired(sql: SqlExec, now: number, opts: PruneOptions): PruneResult {
  const batch = opts.batch ?? PRUNE_DEFAULTS.batch;
  const maxBatches = opts.maxBatches ?? PRUNE_DEFAULTS.maxBatches;
  const cut = now - opts.graceMs;
  const counts = {} as Record<PruneKind, number>;
  let more = false;
  for (const rule of RULES) {
    if (opts.mode === 'count') {
      const cap = batch * maxBatches;
      const row = sql.exec(`SELECT count(*) AS n FROM (${candidates(rule)})`, ...bindings(rule, cut, cap)).toArray()[0];
      counts[rule.kind] = Number(row?.n ?? 0);
      continue;
    }
    let total = 0;
    let full = false;
    for (let i = 0; i < maxBatches; i++) {
      // `RETURNING` gives the count on both drivers; a DO cursor's `rowsWritten` would not.
      const deleted = sql.exec(`DELETE FROM ${rule.kind} WHERE id IN (${candidates(rule)}) RETURNING id`, ...bindings(rule, cut, batch)).toArray().length;
      total += deleted;
      full = deleted === batch;
      if (!full) break;
    }
    counts[rule.kind] = total;
    if (full) more = true;
  }
  return { counts, more };
}

/**
 * When the next row becomes deletable, or null when nothing here will ever expire. Only rows
 * not yet past the cut are read: a row past it that a guard still holds is waiting on a token
 * or a replay window whose own time is in this minimum, so it is reached when that is.
 * One indexed `min` per column.
 */
export function nextPruneDue(sql: SqlExec, now: number, graceMs: number): number | null {
  const cut = now - graceMs;
  const columns: [string, string][] = [
    ...RULES.map((r): [string, string] => [r.kind, 'expires_at']),
    ['oauth_refresh_token', 'rotation_replay_expires_at'],
  ];
  let earliest: number | null = null;
  for (const [table, column] of columns) {
    const row = sql.exec(`SELECT min(${column}) AS at FROM ${table} WHERE ${column} >= ?`, cut).toArray()[0];
    const at = row?.at == null ? null : Number(row.at);
    if (at !== null && (earliest === null || at < earliest)) earliest = at;
  }
  return earliest === null ? null : earliest + graceMs;
}

/** Where the alarm goes after a run: soon when a bound stopped it, else the next due row. */
export function nextPruneAlarm(sql: SqlExec, now: number, graceMs: number, more: boolean): number | null {
  if (more) return now + PRUNE_DEFAULTS.continueMs;
  const due = nextPruneDue(sql, now, graceMs);
  return due === null ? null : Math.max(due, now + PRUNE_DEFAULTS.minGapMs);
}
