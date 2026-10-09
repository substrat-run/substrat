import type { PlatformActorId, ScopeId, TenantId } from '@substrat-run/contracts';
import { CARRIED_AWAY_KEY, isPrimaryScope, type HostAdmin, type ScopeScriptCopy } from '@substrat-run/kernel';
import type { VerticalClient } from './vertical-client.js';

export interface ScopeCopyCleanup {
  admin: HostAdmin;
  actor: PlatformActorId;
  resolveRef: (scriptRef: string) => Promise<VerticalClient | undefined>;
}

/** The directory's current routing decision, with no fallback to a different script. */
async function routeOf(input: ScopeCopyCleanup, tenantId: TenantId, scopeId: ScopeId): Promise<string | null> {
  const scope = await input.admin.getScopeRecord(input.actor, tenantId, scopeId);
  if (!scope) return null;
  if (scope.servingRef) return scope.servingRef;
  if (!scope.vertical || !scope.verticalVersionId) return null;
  return (await input.admin.getVersion(input.actor, scope.verticalVersionId, scope.vertical))?.deploymentRef ?? null;
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
    const meta = await holder.readScopeTable(copy.scopeId, { table: '_substrat_meta', limit: 100, offset: 0 });
    const key = meta.columns.indexOf('key');
    const alreadyWiped = key >= 0 && meta.rows.some((r) => r[key] === CARRIED_AWAY_KEY);
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
    }
  }
  return { tried: copies.length, done, failed };
}

/** A destructive reap reaches every named script before the directory forgets the scope. */
export async function reapScopeScriptCopies(input: ScopeCopyCleanup, tenantId: TenantId, scopeId: ScopeId): Promise<void> {
  const copies = await input.admin.listScopeScriptCopies(input.actor, { tenantId, scopeId, limit: 1001 });
  if (copies.length === 1001) throw new Error(`scope ${scopeId} has more copies than one reap batch can verify`);
  const current = await routeOf(input, tenantId, scopeId);
  const refs = new Set(copies.filter((c) => c.state !== 'done').map((c) => c.scriptRef));
  if (current) refs.add(current);
  for (const ref of refs) {
    const client = await input.resolveRef(ref);
    if (!client) throw new Error(`copy script '${ref}' cannot be reached for reap`);
    await client.deleteScope({ tenantId, scopeId });
  }
  for (const copy of copies) {
    if (copy.state !== 'done') {
      await input.admin.settleScopeScriptCopy(input.actor, tenantId, scopeId, copy.scriptRef, copy.moveId, 'done');
    }
  }
}
