import type { MigrationProgress, MigrationStraggler, Scope } from '@substrat-run/contracts';
import type { MigrationFrontier } from './scope-host.js';

/**
 * The fleet migration-progress computation (kernel-design §5.3, #49) — one pure
 * function shared by the reconciliation sweep's report and the control-plane
 * API's ops view, so the two can never disagree about what "487/500 migrated,
 * 13 pending, 0 failed" means.
 *
 * Everything here reads the DIRECTORY projection (`schemaVersion`,
 * `migrationFailure`) against the host's registered frontier — §5.4's "fleet
 * questions never fan out" made concrete: no scope is woken to answer it.
 */

/**
 * Consecutive failures after which a scope is FLAGGED — the "pages past a
 * threshold" line in §5.3. The sweep keeps retrying past it (recovery is a
 * patched forward release, which arrives on its own schedule); flagging is the
 * signal that a human should now be looking.
 */
export const MIGRATION_FLAG_THRESHOLD = 3;

/** Cap on the straggler detail list. The counts always carry the whole truth. */
const STRAGGLER_LIST_MAX = 50;

export type ScopeMigrationState = 'migrated' | 'pending' | 'failed';

/**
 * Classify one scope against the frontier, from the directory row alone.
 * A recorded failure wins: its `schemaVersion` is the count that landed before
 * the rollback, so it is behind by construction, and "failed" is the state an
 * operator must act on.
 */
export function scopeMigrationState(
  scope: Pick<Scope, 'schemaVersion' | 'migrationFailure'>,
  frontier: MigrationFrontier,
): ScopeMigrationState {
  if (scope.migrationFailure) return 'failed';
  return Number(scope.schemaVersion) >= frontier.total ? 'migrated' : 'pending';
}

/**
 * The scopes the sweep and the progress view consider: live primaries.
 * Suspended/archived scopes are deliberate states the sweep must not disturb
 * (they re-migrate lazily if ever restored), and forks are ephemeral copies
 * pinned at their source's frontier — proactively migrating an archive would
 * change the very bytes it exists to preserve.
 */
export function migrationFleet(scopes: readonly Scope[]): Scope[] {
  return scopes.filter(
    (s) => (s.status === 'active' || s.status === 'provisioning') && s.forkedFrom === null,
  );
}

export function migrationSummary(p: {
  release: string;
  total: number;
  migrated: number;
  pending: number;
  failed: number;
}): string {
  return `release ${p.release}: ${p.migrated}/${p.total} migrated, ${p.pending} pending, ${p.failed} failed`;
}

function straggler(
  scope: Scope,
  state: 'pending' | 'failed',
  flagThreshold: number,
): MigrationStraggler {
  return {
    tenantId: scope.tenantId,
    scopeId: scope.id,
    slug: scope.slug,
    vertical: scope.vertical,
    schemaVersion: scope.schemaVersion,
    state,
    failure: scope.migrationFailure,
    flagged: (scope.migrationFailure?.attempts ?? 0) >= flagThreshold,
  };
}

/**
 * "release N: X/Y migrated, P pending, F failed" over the given directory
 * listing. `release` is the frontier total — the same count `schemaVersion`
 * holds, so the label and the comparison can never drift apart. Callers pass
 * the raw `listScopes` result; the live-primary filter is applied here so every
 * consumer counts the same fleet.
 */
export function migrationProgress(
  frontier: MigrationFrontier,
  scopes: readonly Scope[],
  opts?: { flagThreshold?: number },
): MigrationProgress {
  const flagThreshold = opts?.flagThreshold ?? MIGRATION_FLAG_THRESHOLD;
  const fleet = migrationFleet(scopes);
  const pending: Scope[] = [];
  const failed: Scope[] = [];
  let migrated = 0;
  for (const s of fleet) {
    const state = scopeMigrationState(s, frontier);
    if (state === 'migrated') migrated += 1;
    else if (state === 'pending') pending.push(s);
    else failed.push(s);
  }
  // Failed first — the actionable ones — then pending, capped. Counts stay whole.
  const stragglers = [
    ...failed.map((s) => straggler(s, 'failed', flagThreshold)),
    ...pending.map((s) => straggler(s, 'pending', flagThreshold)),
  ].slice(0, STRAGGLER_LIST_MAX);
  const p = {
    release: String(frontier.total),
    total: fleet.length,
    migrated,
    pending: pending.length,
    failed: failed.length,
  };
  return {
    ...p,
    complete: migrated === fleet.length,
    stragglers,
    summary: migrationSummary(p),
  };
}
