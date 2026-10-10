import {
  storedScopeLifecycle,
  type LifecycleDelivery,
  type LifecycleRevision,
  type ScopeLifecycle,
  type StoredScopeLifecycle,
} from '@substrat-run/contracts';
import type { SwitchSql } from './system-switch.js';

/**
 * A scope's lifecycle, held in the scope's own storage (#1713).
 *
 * A CP-less hosted vertical has no directory. The router refuses a suspended scope's requests
 * (#1730), but a deployment's own timer, retries and background work never pass the router, so
 * the deployment needs the lifecycle in storage it can read. The platform pushes it on every
 * transition (`/internal/lifecycle`), and its heal sweep re-pushes any scope whose last delivered
 * state differs from the directory. That way a missed push converges instead of failing open.
 *
 * One `_substrat_meta` row, as JSON. No row means `active`: a scope this has never reached, and
 * every scope from before it, runs as it always did.
 *
 * Deliveries are ordered by the directory's revisions, never by a clock (`supersedes`): two
 * transitions' deliveries can overlap, and the later transition's must win whichever lands last.
 *
 * The row travels with a dump onto the same scope (a carry onto a new version lands in a fresh
 * store). A load keeps the NEWER of the store's row and the dump's (`lifecycleAfterLoad`), so a
 * restore of a backup taken before a suspension does not lift it. A copy (a fork, a snapshot, a
 * preview) never takes the source's row: it has a directory row of its own, and its own pushes.
 */
const SCOPE_LIFECYCLE_KEY = 'scope_lifecycle';

/**
 * The one statement that stores a delivered lifecycle, with its key written in. A delivery changes
 * what the store may run and none of its data, so the scope DO lets this statement through its
 * bookkeeping path without advancing the write revision a carry fences on (`isLifecycleWrite`),
 * as it does the copy marker. The key is a literal so that path cannot write any other row.
 */
export const WRITE_LIFECYCLE_SQL = `INSERT OR REPLACE INTO _substrat_meta (key, value) VALUES ('${SCOPE_LIFECYCLE_KEY}', ?)`;

/** Whether a statement is `WRITE_LIFECYCLE_SQL`, whitespace aside. */
export const isLifecycleWrite = (sql: string): boolean => sql.trim().replace(/\s+/g, ' ') === WRITE_LIFECYCLE_SQL;

/** The stored lifecycle, or null when none was delivered. A row that does not parse reads as none. */
export function readLifecycle(sql: SwitchSql): StoredScopeLifecycle | null {
  const row = sql.all('SELECT value FROM _substrat_meta WHERE key = ?', SCOPE_LIFECYCLE_KEY)[0];
  return row ? parseLifecycle(row.value) : null;
}

/** A stored or dumped value as a lifecycle, or null when it is absent or does not parse. */
export function parseLifecycle(value: unknown): StoredScopeLifecycle | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed = storedScopeLifecycle.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** What a lifecycle held before revisions existed counts as: older than every revisioned one. */
const UNREVISED: LifecycleRevision = { epoch: -1, scope: -1, tenant: -1 };

/**
 * Whether `next` replaces `current`. A newer epoch always does: it is a later history of the
 * directory (a restore), whose counters may be lower than the ones the replaced history reached.
 * Within one epoch, `next` must be strictly newer on at least one counter and older on neither.
 * An equal revision is the same directory state delivered again, and refused, so that no two
 * deliveries can tie. Counters that disagree (newer on one, older on the other) cannot come from
 * one directory read and are refused too.
 */
function supersedes(next: StoredScopeLifecycle, current: StoredScopeLifecycle | null): boolean {
  if (current === null) return true;
  const n = next.revision ?? UNREVISED;
  const c = current.revision ?? UNREVISED;
  if (n.epoch !== c.epoch) return n.epoch > c.epoch;
  return n.scope >= c.scope && n.tenant >= c.tenant && (n.scope > c.scope || n.tenant > c.tenant);
}

/**
 * Store a delivered lifecycle, unless the store already holds one as new or newer. `applied` says whether
 * this delivery is now the stored state, and `changed` whether the gate's answer moved with it.
 */
export function writeLifecycle(sql: SwitchSql, next: ScopeLifecycle): LifecycleDelivery {
  const current = readLifecycle(sql);
  if (!supersedes(next, current)) return { applied: false, changed: false, lifecycle: current! };
  sql.run(WRITE_LIFECYCLE_SQL, JSON.stringify(next));
  const changed = (lifecycleRefusal(current) === null) !== (lifecycleRefusal(next) === null);
  return { applied: true, changed, lifecycle: next };
}

/**
 * The row a load leaves (#1713): the store's own when the load is a copy, otherwise the newer of
 * the store's and the dump's. Null means no row.
 */
export function lifecycleAfterLoad(
  before: StoredScopeLifecycle | null,
  dumped: StoredScopeLifecycle | null,
  copy: boolean,
): StoredScopeLifecycle | null {
  if (copy || dumped === null) return before;
  return supersedes(dumped, before) ? dumped : before;
}

/**
 * Settle the row after a load replaced `_substrat_meta` wholesale (#1713): `lifecycleAfterLoad` of
 * the row read before the load (`before`) and the one the dump brought, put in place or removed.
 */
export function settleLifecycleAfterLoad(sql: SwitchSql, before: StoredScopeLifecycle | null, copy: boolean): void {
  const keep = lifecycleAfterLoad(before, readLifecycle(sql), copy);
  if (keep) sql.run(WRITE_LIFECYCLE_SQL, JSON.stringify(keep));
  else sql.run('DELETE FROM _substrat_meta WHERE key = ?', SCOPE_LIFECYCLE_KEY);
}

/**
 * THE lifecycle gate (#1713): null when the scope may run, or the refusal's message. Both halves must be
 * `active`, the tenant judged first, exactly as the directory's `scopeAccessRefusal` judges them,
 * so a CP-less deployment and a CP-backed one refuse the same scope in the same words. No stored
 * lifecycle passes.
 */
export function lifecycleRefusal(
  state: Pick<ScopeLifecycle, 'scope' | 'tenant'> | null,
  ids?: { tenantId: string; scopeId: string },
): string | null {
  if (!state) return null;
  if (state.tenant !== 'active') return `tenant not active (status: ${state.tenant})${ids ? `: ${ids.tenantId}` : ''}`;
  if (state.scope !== 'active') return `scope not active (status: ${state.scope})${ids ? `: ${ids.scopeId}` : ''}`;
  return null;
}

/**
 * The directory's record of what a deployment last acknowledged, compared with the directory's
 * own lifecycle by the heal sweep: the statuses AND the full revision, so a restore that left the
 * statuses as they were still reads as drift, and the scope is brought onto the new epoch. Never
 * `at`, so a re-read of an unchanged directory is not drift. A lifecycle stored before revisions
 * has none, and reads as drift against any directory.
 */
export const lifecycleReceipt = (state: Pick<StoredScopeLifecycle, 'scope' | 'tenant' | 'revision'>): string =>
  `${state.scope}/${state.tenant}` +
  (state.revision ? `@${state.revision.epoch}.${state.revision.scope}.${state.revision.tenant}` : '');
