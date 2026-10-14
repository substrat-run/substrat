import type { PlatformActorId, Scope } from '@substrat-run/contracts';
import type { HostAdmin } from './scope-host.js';

/**
 * Which scope is the real install, and which version its code runs (#1653, #2005):
 * the questions every door, both adapters and the fleet sweep ask the same way.
 * Split out of `platform-sweep.ts` (#1978).
 */

/**
 * A scope the platform may treat as the REAL install, rather than a copy of one (#1172,
 * #1653). The directory is the only oracle for this, and it takes BOTH tests, not one.
 *
 * A fork is an archive or a preview of somebody else's data, and re-provisioning one
 * runs the vertical's install-side hook against a copy, minting a second set of whatever
 * it mints — or, since #1656, putting a copy of production on a sweeper that reaps and
 * assigns. But a CLEAN-ROOM preview (#509) is an empty scope with no source to copy, so
 * it carries `kind: 'preview'` and NO `forkedFrom` — the reap sweep keys on `kind` for
 * exactly that reason. Filtering on lineage alone would let those through, which is the
 * one shape of scope where the hook's effects are least wanted.
 */
export function isPrimaryScope(scope: Pick<Scope, 'forkedFrom' | 'kind'>): boolean {
  return !scope.forkedFrom && scope.kind !== 'preview';
}

/**
 * `isPrimaryScope` over a raw directory row, in the snake_case both adapters store (#2005) —
 * so a reader holding a row asks the same one rule rather than restating it. No row is not
 * primary: the answer that runs effects with platform authority is the one to be proven.
 */
export function isPrimaryScopeRow(row: { kind: string | null; forked_from: string | null } | undefined): boolean {
  return row !== undefined && isPrimaryScope({ kind: row.kind ?? '', forkedFrom: row.forked_from as Scope['forkedFrom'] });
}

/**
 * Why an effect a NON-primary scope asked for was settled without running (#2005). A fork,
 * a snapshot and a preview of either kind are inert: they cause no outbound effects, so
 * whatever they queue — a platform intent, an executor or connector delivery — is journaled
 * as not executed, with this reason, rather than left pending forever or run off a copy.
 * One string for every door, so a reader who has seen it once recognizes it everywhere.
 */
export const INERT_SCOPE_REASON =
  'not executed: this scope is a preview or a fork, and those cause no outbound effects';

/** What a vertical's stable serving script runs (#286) — `Vertical.servingRef`/`servingVersionId`. */
export interface ServingPointer {
  ref: string;
  versionId: string;
}

/**
 * The version whose code actually executes for `scope` (#1653) — which is not always the
 * one it is bound to.
 *
 * A scope on its vertical's stable serving script (`servingRef`, #286) runs whatever that
 * script serves, and a promote re-uploads the script in place: the code changes under
 * the scope at that moment, whatever its version pointer says. For a PRIVATE vertical
 * the promote moves the pointer too, so the two agree. For a LISTED one it does not —
 * the pointer is the tenant's, and moves only on their Update — so an install can run
 * version N+1 with its provision state still at N. Measuring against the running version
 * is what lets the reconcile follow the code instead of the pointer.
 *
 * Falls back to the bound version whenever the serving script cannot be named: a scope
 * with no `servingRef` (legacy per-version dispatch, where the bound version's own
 * script IS what runs), a vertical with nothing served in place yet, or a `servingRef`
 * that is not the vertical's current one. The fallback is exactly the pre-#1653 answer,
 * so an unknown never manufactures a reconcile.
 */
export function runningVersionOf(
  scope: Pick<Scope, 'verticalVersionId' | 'servingRef'>,
  serving: ServingPointer | null | undefined,
): string | null {
  if (scope.servingRef && serving && scope.servingRef === serving.ref) return serving.versionId;
  return scope.verticalVersionId;
}

/**
 * Every vertical's serving pointer, for `runningVersionOf` — one `listVerticals` read, and only
 * when some scope is actually on a serving script, since nothing else can differ from its
 * binding. Shared by the provision reconcile (#1653) and the cross-vertical narrowing (#1705).
 */
export async function servingPointersFor(
  admin: Pick<HostAdmin, 'listVerticals'>,
  actor: PlatformActorId,
  scopes: readonly Pick<Scope, 'servingRef'>[],
): Promise<Map<string, ServingPointer>> {
  const serving = new Map<string, ServingPointer>();
  if (!scopes.some((s) => s.servingRef)) return serving;
  for (const v of await admin.listVerticals(actor)) {
    if (v.servingRef && v.servingVersionId) serving.set(v.slug, { ref: v.servingRef, versionId: v.servingVersionId });
  }
  return serving;
}
