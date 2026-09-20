import type { Scope, ScopeId } from '@substrat-run/contracts';
import { ControlPlaneError, type TenantNarrowedControlPlane } from './authority.js';

/**
 * The installs a vertical still backs — and what a builder may do about them (#1592).
 *
 * `DELETE /verticals/:slug` refuses while a scope is bound to the vertical, and the
 * refusal names a COUNT. This is the list that count is counting, with the two acts that
 * make it reach zero: **Move** (rebind the install onto another vertical this team owns —
 * the primary act, because the usual reason scopes are stranded is a rename that forked
 * the lineage, so they are live installs, not dead ones) and **Retire** (archive, then
 * wipe storage — the guarded act, armed by typing how many are being retired).
 *
 * Everything here is environment-free, over a plane it is handed, so the guards are
 * testable without a worker. The HTTP routes are thin: they resolve the caller, gate the
 * role, check the vertical is theirs, and call in.
 *
 * ## Why the narrowing lives here
 *
 * The dashboard reaches the plane over a staff-level service token, and the plane's
 * `rebind-vertical` and `reap` routes are staff routes — a builder is default-denied them
 * on the plane itself (`BUILDER_ROUTES`). The tenant narrowing is therefore this seam's,
 * and it has three parts, each held below:
 *
 * - a scope id is acted on only if it is in the pinned tenant's own bound list for this
 *   vertical (`pick`) — a foreign or unrelated id never reaches a mutating call;
 * - a Move target must be a vertical this tenant owns — never another team's, never a
 *   platform one;
 * - Retire refuses unless the caller typed the count of what they are retiring, checked
 *   HERE and before anything is read or written — the browser dialog arms its button on
 *   the same rule, but a button is not a guard.
 */

/** One install still bound to the vertical, as the vertical's page needs to show it. */
export interface BoundScope {
  id: string;
  slug: string;
  name: string;
  /** The scope's own status — `archived` is offline but still blocks the delete. */
  status: string;
  /** A preview/snapshot fork of another scope. Retiring deletes it; it is never moved. */
  fork: boolean;
  /** Whether Move applies: a fork cannot be rebound and an archived scope serves nothing. */
  movable: boolean;
  /** The version the scope is pinned to, or null when it follows the channel. */
  verticalVersionId: string | null;
  createdAt: string;
  /** Names that go offline first when this scope is retired. */
  hostnames: string[];
}

export interface BoundScopesView {
  /**
   * Scopes that are neither archived nor reaped — the number `still backs N scope(s)`
   * reports. The same partition the adapters' refusal makes, on purpose: the count on
   * screen must be the count in the message.
   */
  live: number;
  /** Archived scopes — what `still backs N archived scope(s)` reports once no live one remains. */
  archived: number;
  /** Live first, then archived; oldest first within each. `reaped` tombstones never appear. */
  scopes: BoundScope[];
}

/** A refusal this module makes itself, carrying the HTTP status it should surface as. */
export class BoundScopeError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = 'BoundScopeError';
  }
}

/**
 * Shape the tenant-pinned scope list (and the tenant's hostnames) into the view.
 * `reaped` is terminal history and never blocks a delete, so it is not shown.
 */
export function deriveBoundScopes(
  scopes: readonly Scope[],
  hostnames: ReadonlyArray<{ hostname: string; scopeId: string }>,
): BoundScopesView {
  const rows = scopes
    .filter((s) => s.status !== 'reaped')
    .map((s): BoundScope => {
      const fork = s.forkedFrom !== null && s.forkedFrom !== undefined;
      return {
        id: s.id,
        slug: s.slug,
        name: s.name,
        status: s.status,
        fork,
        movable: !fork && s.status !== 'archived',
        verticalVersionId: s.verticalVersionId ?? null,
        createdAt: s.createdAt,
        hostnames: hostnames
          .filter((h) => h.scopeId === s.id)
          .map((h) => h.hostname)
          .sort(),
      };
    });
  const rank = (s: BoundScope) => (s.status === 'archived' ? 1 : 0);
  rows.sort((a, b) => rank(a) - rank(b) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const archived = rows.filter((s) => s.status === 'archived').length;
  return { live: rows.length - archived, archived, scopes: rows };
}

type ReadPlane = Pick<TenantNarrowedControlPlane, 'listScopes' | 'listTenantHostnames'>;

/** The tenant's own installs of one vertical. Both reads are pinned to the tenant by the seam. */
export async function readBoundScopes(cp: ReadPlane, vertical: string): Promise<BoundScopesView> {
  const [scopes, hostnames] = await Promise.all([cp.listScopes(vertical), cp.listTenantHostnames()]);
  return deriveBoundScopes(scopes, hostnames);
}

/**
 * The requested scopes, each resolved against the view — or a 404 naming the first that is
 * not bound to this vertical for this tenant. Duplicates collapse, so the count a caller
 * types is the count of distinct scopes acted on.
 */
function pick(view: BoundScopesView, ids: readonly string[]): BoundScope[] {
  const unique = [...new Set(ids)];
  if (unique.length === 0) throw new BoundScopeError(400, 'select at least one scope');
  return unique.map((id) => {
    const found = view.scopes.find((s) => s.id === id);
    if (!found) throw new BoundScopeError(404, `scope '${id}' is not bound to this vertical`);
    return found;
  });
}

/** What a Move did: the scopes now on the target, and the refusal that stopped the run, if any. */
export interface MoveOutcome {
  moved: string[];
  refusal: { scopeId: string; message: string } | null;
}

type MovePlane = ReadPlane & Pick<TenantNarrowedControlPlane, 'listVerticals' | 'rebindScopeVertical'>;

/**
 * Rebind the chosen installs onto another vertical this team owns.
 *
 * Validated whole before anything moves: a target that is not the team's own, the same
 * vertical, or a selection containing a fork or an archived scope is refused outright
 * rather than half-applied. Then one audited rebind per scope, in order, stopping at the
 * first refusal — the plane's digest gate names the acknowledgement it wants, and the
 * caller reads that and re-runs the remainder rather than half-acknowledging.
 */
export async function moveBoundScopes(
  cp: MovePlane,
  input: { vertical: string; scopeIds: readonly string[]; target: string; ackMigrations?: boolean },
): Promise<MoveOutcome> {
  if (input.target === input.vertical) {
    throw new BoundScopeError(400, 'choose a different vertical to move the installs onto');
  }
  const owned = await cp.listVerticals();
  if (!owned.some((v) => v.slug === input.target)) {
    throw new BoundScopeError(404, `vertical '${input.target}' is not one of your deployments`);
  }
  const chosen = pick(await readBoundScopes(cp, input.vertical), input.scopeIds);
  const stuck = chosen.filter((s) => !s.movable);
  if (stuck.length > 0) {
    throw new BoundScopeError(
      409,
      `${stuck.map((s) => s.slug).join(', ')} cannot be moved — a snapshot fork or an archived scope has no live install to rebind; retire it instead`,
    );
  }
  const moved: string[] = [];
  for (const s of chosen) {
    try {
      await cp.rebindScopeVertical(s.id as ScopeId, input.target, {
        ...(input.ackMigrations ? { ackMigrations: true } : {}),
      });
      moved.push(s.id);
    } catch (e) {
      // The plane's own sentence, verbatim — it says what to do (`re-run with ackMigrations`).
      if (e instanceof ControlPlaneError) return { moved, refusal: { scopeId: s.id, message: e.message } };
      throw e;
    }
  }
  return { moved, refusal: null };
}

/** What a Retire did: the scopes gone, and the failure that stopped the run, if any. */
export interface RetireOutcome {
  retired: string[];
  failure: { scopeId: string; message: string } | null;
}

type RetirePlane = ReadPlane &
  Pick<TenantNarrowedControlPlane, 'unbindScopeHostnames' | 'archiveScope' | 'reapScope' | 'deleteSnapshot'>;

/** The typed confirmation Retire demands: the number of scopes being retired, as digits. */
export function retireConfirmation(count: number): string {
  return String(count);
}

/**
 * Whether what was typed arms a retire of `count` scopes. The browser dialog enables its
 * button on this; `retireBoundScopes` re-checks the same rule server-side.
 */
export function isRetireArmed(typed: string, count: number): boolean {
  return count > 0 && typed.trim() === retireConfirmation(count);
}

/**
 * Retire the chosen installs: release their names, then archive and reap (a snapshot fork
 * is deleted outright). Storage is wiped and there is no restore, so:
 *
 * - **`confirm` must be the count.** Checked first — before the plane is read or written,
 *   so a missing or wrong confirmation is a refusal with no side effects to reason about.
 * - **Every id must be this tenant's, bound to this vertical**, resolved before the first
 *   write, so a bad id anywhere in the list retires nothing.
 * - **It stops at the first failure.** Each scope goes offline (names released, archived)
 *   before its reap is attempted, and a reap can refuse — no backup store, say. Carrying on
 *   would take the next scope offline into the same refusal; stopping leaves the rest live.
 */
export async function retireBoundScopes(
  cp: RetirePlane,
  input: { vertical: string; scopeIds: readonly string[]; confirm: string },
  /**
   * Told of each scope once it is gone, in order. The dashboard keeps its own row for an
   * app it installed, and a row left `active` over a reaped scope is a ghost in the Apps
   * list — the caller closes it here. Never called for a scope that failed to retire.
   */
  onRetired?: (scopeId: string) => Promise<void>,
): Promise<RetireOutcome> {
  const count = new Set(input.scopeIds).size;
  if (!isRetireArmed(input.confirm, count)) {
    throw new BoundScopeError(
      400,
      count === 0
        ? 'select at least one scope'
        : `retiring wipes storage and cannot be undone — type ${retireConfirmation(count)} to confirm retiring ${count} scope${count === 1 ? '' : 's'}`,
    );
  }
  const chosen = pick(await readBoundScopes(cp, input.vertical), input.scopeIds);
  const retired: string[] = [];
  for (const s of chosen) {
    const id = s.id as ScopeId;
    try {
      // Names first: the plane refuses to reap a scope that still resolves one, and a
      // still-serving install must never be wiped by accident.
      await cp.unbindScopeHostnames(id);
      if (s.fork) {
        await cp.deleteSnapshot(id);
      } else {
        if (s.status !== 'archived') await cp.archiveScope(id);
        await cp.reapScope(id);
      }
      retired.push(s.id);
    } catch (e) {
      if (e instanceof ControlPlaneError) return { retired, failure: { scopeId: s.id, message: e.message } };
      throw e;
    }
    await onRetired?.(s.id);
  }
  return { retired, failure: null };
}
