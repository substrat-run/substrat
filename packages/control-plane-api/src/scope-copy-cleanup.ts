import { errorCodeOf, type PlatformActorId, type ScopeId, type TenantId } from '@substrat-run/contracts';
import { ControlPlaneError } from '@substrat-run/control-plane-client';
import { CARRIED_AWAY_KEY, SCOPE_COPY_LEASE_MS, isPrimaryScope, ulid, type HostAdmin, type ScopeScriptCopy } from '@substrat-run/kernel';
import type { VerticalClient } from './vertical-client.js';

export interface ScopeCopyCleanup {
  admin: HostAdmin;
  actor: PlatformActorId;
  resolveRef: (scriptRef: string) => Promise<VerticalClient | undefined>;
}

/** Do not discard the directory's last pointer to a copy when dispatch is unavailable. */
export async function assertNoUnreachableScopeCopies(
  admin: HostAdmin, actor: PlatformActorId, tenantId: TenantId, scopeId: ScopeId,
): Promise<void> {
  for (const state of ['pending', 'eligible', 'retained', 'kept'] as const) {
    if ((await admin.listScopeScriptCopies(actor, { tenantId, scopeId, state, limit: 1 })).length) {
      throw new Error(`scope ${scopeId} has a ${state} script copy, but script dispatch is unavailable`);
    }
  }
}

/** Stable keyset walk for a scope. Reap holds a claim; erasure checks the final
 * row count atomically, so a move recorded during this walk forces a retry. */
export async function listAllScopeScriptCopies(
  admin: HostAdmin, actor: PlatformActorId, tenantId: TenantId, scopeId: ScopeId,
): Promise<ScopeScriptCopy[]> {
  const copies: ScopeScriptCopy[] = [];
  let after: { scriptRef: string; moveId: string } | undefined;
  for (;;) {
    const page = await admin.listScopeScriptCopies(actor, { tenantId, scopeId, limit: 100, ...(after ? { after } : {}) });
    copies.push(...page);
    if (page.length < 100) return copies;
    const last = page[page.length - 1]!;
    after = { scriptRef: last.scriptRef, moveId: last.moveId };
  }
}

/** The directory's current routing decision, with no fallback to a different script. */
async function routeOf(input: ScopeCopyCleanup, tenantId: TenantId, scopeId: ScopeId): Promise<string | null> {
  const scope = await input.admin.getScopeRecord(input.actor, tenantId, scopeId);
  return scope ? routeOfScope(input, scope) : null;
}

/** `routeOf` for a scope record already read; `versionOf` lets a caller share its version reads. */
export async function routeOfScope(
  input: ScopeCopyCleanup,
  scope: Pick<NonNullable<Awaited<ReturnType<HostAdmin['getScopeRecord']>>>, 'servingRef' | 'vertical' | 'verticalVersionId'>,
  versionOf = (id: string, vertical: string) => input.admin.getVersion(input.actor, id, vertical),
): Promise<string | null> {
  if (scope.servingRef) return scope.servingRef;
  if (!scope.vertical || !scope.verticalVersionId) return null;
  return (await versionOf(scope.verticalVersionId, scope.vertical))?.deploymentRef ?? null;
}

/** Whether the scope's store in this script holds the tombstone a wipe leaves: proof it was wiped. */
export async function hasCarriedAwayTombstone(holder: VerticalClient, scopeId: ScopeId): Promise<boolean> {
  const meta = await holder.readScopeTable(scopeId, { table: '_substrat_meta', limit: 100, offset: 0 });
  const key = meta.columns.indexOf('key');
  return key >= 0 && meta.rows.some((r) => r[key] === CARRIED_AWAY_KEY);
}

/** One eligible source. A changed store is kept, never discarded to satisfy the ledger. */
export async function retryScopeScriptCopy(input: ScopeCopyCleanup, copy: ScopeScriptCopy): Promise<'done' | 'kept' | 'skipped'> {
  if (copy.state !== 'eligible') return 'skipped';
  const scope = await input.admin.getScopeRecord(input.actor, copy.tenantId, copy.scopeId);
  if (!scope) return 'skipped'; // a reap must drain before it removes the row
  const route = await routeOf(input, copy.tenantId, copy.scopeId);
  if (!route || route === copy.scriptRef) return 'skipped';
  const holder = await input.resolveRef(copy.scriptRef);
  if (!holder) throw new Error(`copy script '${copy.scriptRef}' cannot be reached`);
  const result = await holder.wipeCarriedCopy({
    scopeId: copy.scopeId,
    expectLoadStamp: copy.loadStamp,
    expectRevision: copy.revision,
    protectIfChanged: true,
    carriedTo: route,
    at: new Date().toISOString(),
    ...(!isPrimaryScope(scope) ? { markCopy: { kind: scope.kind, forkedFrom: scope.forkedFrom } } : {}),
  });
  if (result === 'unfenced') throw new Error(`copy script '${copy.scriptRef}' has no fenced wipe`);
  if (!result.wiped) {
    // An earlier wipe may have committed and only the ledger receipt failed. Its tombstone is
    // proof of deletion, whereas a changed store with no tombstone must be kept for review.
    const alreadyWiped = await hasCarriedAwayTombstone(holder, copy.scopeId);
    await input.admin.settleScopeScriptCopy(input.actor, copy.tenantId, copy.scopeId, copy.scriptRef, copy.moveId,
      alreadyWiped ? 'done' : 'kept', { loadStamp: copy.loadStamp, revision: copy.revision });
    return alreadyWiped ? 'done' : 'kept';
  }
  await input.admin.settleScopeScriptCopy(input.actor, copy.tenantId, copy.scopeId, copy.scriptRef, copy.moveId,
    'done', { loadStamp: copy.loadStamp, revision: copy.revision });
  return 'done';
}

/** Bounded scheduled pass. Failures stay eligible and are retried on the next pass. */
export async function retryScopeScriptCopies(input: ScopeCopyCleanup, limit = 100): Promise<{ tried: number; done: number; failed: number }> {
  const copies = await input.admin.listScopeScriptCopies(input.actor, { state: 'eligible', limit });
  let done = 0;
  let failed = 0;
  for (const copy of copies) {
    try {
      if (await retryScopeScriptCopy(input, copy) === 'done') done++;
    } catch {
      failed++;
      await input.admin.touchScopeScriptCopy(input.actor, copy.tenantId, copy.scopeId, copy.scriptRef, copy.moveId);
    }
  }
  return { tried: copies.length, done, failed };
}

/**
 * Crash recovery (#1722): settle the pending entries of moves whose lease ran out, a carry, adopt
 * or rebind that died between recording its copies and confirming its bind. Bounded, idempotent,
 * and never racing a live move: an entry is claimed only once its lease has run out, and a move
 * past its lease can no longer confirm a bind, so whichever claims it acts alone.
 *
 * An expired entry has no confirmed bind (the confirmation settles every entry of the move in
 * the bind's own write). So for each one:
 * - the scope routes to its script: that store is live, and the route reaches it (`done`);
 * - a destination the scope does not route to: its restore, if it ever landed, is wiped, fenced
 *   on the load stamp the move recorded before restoring. The wipe loads the tombstone over the
 *   whole store, so nothing of the scope, an erased subject's rows included, is left in it, and
 *   its new load stamp refuses a late restore that still expects the store it read (`done`). A
 *   refused fence, or a deployment with no fenced wipe, keeps the entry (`retained`, still
 *   reached by reap and erasure): the restore may not have landed yet;
 * - a source the scope no longer routes to (another move took the route since): `retained`.
 *
 * A failure leaves the entry claimed until the sweep's lease runs out, and a later pass takes it
 * again. Until then erasure and reap answer retry-later, as they do for any pending move.
 */
export async function settleExpiredScopeScriptCopies(
  input: ScopeCopyCleanup, opts: { now?: Date; limit?: number } = {},
): Promise<{ claimed: number; settled: number; failed: number }> {
  const now = opts.now ?? new Date();
  const owner = `sweep:${ulid()}`;
  const claimed = await input.admin.claimExpiredScopeScriptCopies(input.actor, {
    now: now.toISOString(),
    leaseUntil: new Date(now.getTime() + SCOPE_COPY_LEASE_MS).toISOString(),
    owner,
    limit: opts.limit ?? 50,
  });
  let settled = 0;
  let failed = 0;
  for (const copy of claimed) {
    try {
      const state = await settledStateOf(input, copy);
      if (await input.admin.settleScopeScriptCopy(input.actor, copy.tenantId, copy.scopeId, copy.scriptRef, copy.moveId,
        state, undefined, { claimedBy: owner })) settled++;
    } catch {
      failed++;
    }
  }
  return { claimed: claimed.length, settled, failed };
}

async function settledStateOf(input: ScopeCopyCleanup, copy: ScopeScriptCopy): Promise<'done' | 'retained'> {
  const scope = await input.admin.getScopeRecord(input.actor, copy.tenantId, copy.scopeId);
  if (!scope) return 'retained';
  const route = await routeOf(input, copy.tenantId, copy.scopeId);
  if (route === copy.scriptRef) return 'done';
  if (copy.role !== 'destination' || !copy.loadStamp) return 'retained';
  const holder = await input.resolveRef(copy.scriptRef);
  if (!holder) throw new Error(`copy script '${copy.scriptRef}' cannot be reached`);
  const result = await holder.wipeCarriedCopy({
    scopeId: copy.scopeId,
    expectLoadStamp: copy.loadStamp,
    carriedTo: route ?? copy.scriptRef,
    at: new Date().toISOString(),
    ...(!isPrimaryScope(scope) ? { markCopy: { kind: scope.kind, forkedFrom: scope.forkedFrom } } : {}),
  });
  // Only a wipe that ran ends this copy. A refused fence may mean the restore has not landed
  // YET: a move that is slow rather than dead can still restore after its lease ran out, and
  // the entry must then still name the script for reap and erasure.
  return result !== 'unfenced' && result.wiped ? 'done' : 'retained';
}

/** The scheduled pass over the ledger: crashed moves first, then the eligible sources' wipes. */
export async function sweepScopeScriptCopies(input: ScopeCopyCleanup): Promise<{ expired: number; retried: number; failed: number }> {
  const expired = await settleExpiredScopeScriptCopies(input);
  const retried = await retryScopeScriptCopies(input);
  return { expired: expired.claimed, retried: retried.tried, failed: expired.failed + retried.failed };
}

/**
 * The ops record of storage a reap left in place (#1722): a script that predates
 * `/internal/delete-scope` answered 501. Every reap path that strands writes it, before the
 * directory row can go, so the bytes left behind stay visible once the row is gone. `where`
 * names the deployment (a script ref, quoted, or how it was resolved).
 */
export async function recordStrandedStorage(
  admin: HostAdmin, actor: PlatformActorId, tenantId: TenantId, scopeId: ScopeId, where: string,
): Promise<void> {
  await admin.recordOpsFailure({
    actor,
    operation: 'scope.reap',
    stage: 'storage-stranded',
    tenantId,
    scopeId,
    status: 501,
    message: `scope ${scopeId}'s storage in ${where} was left in place: that script predates /internal/delete-scope, ` +
      'so its bytes go only when the script itself is removed (#1722)',
  });
}

/**
 * A destructive reap reaches every named script before the directory forgets the scope.
 * `storageStranded` when a script answered 501 to its delete: it predates the verb, so its bytes
 * are unreachable through every platform verb and die with the script at orphan cleanup (#248).
 * The reap goes on (a 501 must never pin a directory row forever), but never silently: each
 * stranded script is recorded (`recordStrandedStorage`) first, for every caller (the reap
 * routes, the preview reap and the GC sweep's reaps), so the bytes left behind stay visible after
 * the row is gone. A record that cannot be written fails the reap, which is then retried. The
 * reap routes' slug fallback (`reapScopeStorage`) records what it strands the same way.
 */
export async function reapScopeScriptCopies(
  input: ScopeCopyCleanup, tenantId: TenantId, scopeId: ScopeId,
): Promise<{ storageStranded: boolean }> {
  // The directory claim and new move records serialize on one store. A carry that
  // already began keeps this reap retryable; one starting later cannot restore bytes
  // after the scripts have been drained and the row removed.
  await input.admin.beginScopeScriptReap(input.actor, tenantId, scopeId).catch((error: unknown) => {
    if (errorCodeOf(error) === 'precondition_failed') {
      throw new ControlPlaneError(412, error instanceof Error ? error.message : String(error));
    }
    throw error;
  });
  const copies = await listAllScopeScriptCopies(input.admin, input.actor, tenantId, scopeId);
  const current = await routeOf(input, tenantId, scopeId);
  const refs = new Set(copies.filter((c) => c.state !== 'done').map((c) => c.scriptRef));
  if (current) refs.add(current);
  let storageStranded = false;
  for (const ref of refs) {
    const client = await input.resolveRef(ref);
    if (!client) throw new Error(`copy script '${ref}' cannot be reached for reap`);
    try {
      await client.deleteScope({ tenantId, scopeId });
    } catch (e) {
      if (!(e instanceof ControlPlaneError && e.status === 501)) throw e;
      await recordStrandedStorage(input.admin, input.actor, tenantId, scopeId, `'${ref}'`);
      storageStranded = true;
    }
  }
  for (const copy of copies) {
    if (copy.state !== 'done') {
      await input.admin.settleScopeScriptCopy(input.actor, tenantId, scopeId, copy.scriptRef, copy.moveId, 'done');
    }
  }
  return { storageStranded };
}
