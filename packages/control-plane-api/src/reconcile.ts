/**
 * What a reconcile delivers, gathered in one place (#1172).
 *
 * Everything a scope is re-provisioned WITH is authoritative platform state, never the
 * caller's: the tenant's entitlements (#310), its identity links (#406), the connection
 * grants and sealing keys that belong to this scope's vertical (#592/#687). Three call
 * sites had already grown their own copy of this gather, and a fourth was about to —
 * which is how a reconcile triggered one way quietly stops delivering what the same
 * reconcile triggered another way does.
 *
 * The gather is here; what to DO with it stays at the call site, because the callers
 * genuinely differ — the repair route mints missing stores first, the drain settles an
 * intent, the sweep records a receipt.
 */
import type { PlatformActorId, ScopeId, TenantId } from '@substrat-run/contracts';
import type { HostAdmin } from '@substrat-run/kernel';
import { connectionGrantsForScope } from './vertical-client.js';

/** The slice of `HostAdmin` a gather needs. Narrow on purpose: this reads, never writes. */
export interface ReconcileGatherAdmin {
  listEntitlements: (actor: PlatformActorId, tenantId: TenantId) => Promise<unknown[]>;
  listIdentityLinks: (
    actor: PlatformActorId,
    tenantId: TenantId,
  ) => Promise<{ tenantId: TenantId }[]>;
  listConnectionGrants: (actor: PlatformActorId, tenantId: TenantId) => Promise<unknown[]>;
  connectionSealingKeys: (tenantId: TenantId, vertical: string) => Promise<unknown[]>;
}

export interface ReconcilePayload {
  entitlements: unknown[];
  identityLinks: unknown[];
  connectionGrants: unknown[];
  connectionKeys: unknown[];
}

/**
 * Gather what a reconcile of this scope must carry.
 *
 * `vertical` null ⇒ no connection material: grants and keys are per-vertical, and a scope
 * bound to nothing has none. The entitlements and links are still the tenant's.
 */
export async function reconcilePayloadFor(
  admin: ReconcileGatherAdmin,
  actor: PlatformActorId,
  scope: { tenantId: TenantId; id: ScopeId; vertical: string | null },
): Promise<ReconcilePayload> {
  const entitlements = await admin.listEntitlements(actor, scope.tenantId);
  // The tenant leg is dropped: the vertical is being told about links INTO this tenant,
  // and echoing the id it already knows back at it is noise on every delivery.
  const identityLinks = (await admin.listIdentityLinks(actor, scope.tenantId)).map(
    ({ tenantId: _tenantId, ...link }) => link,
  );
  const connectionGrants = scope.vertical
    ? connectionGrantsForScope(
        (await admin.listConnectionGrants(actor, scope.tenantId)) as never,
        scope.vertical,
        scope.id,
      )
    : [];
  const connectionKeys = scope.vertical
    ? await admin.connectionSealingKeys(scope.tenantId, scope.vertical)
    : [];
  return {
    entitlements,
    identityLinks,
    connectionGrants: connectionGrants as unknown[],
    connectionKeys,
  };
}

/**
 * Run a hosted reconcile, then put the directory's recorded OFF positions back (#1674).
 *
 * A reconcile runs in the vertical's own deployment, and its seat recreates the `system:`
 * grants a wiped scope lost (#1659), so the kill switch has to be re-asserted AFTER it —
 * from here, where the record is. Every caller of `reconcileInstance` goes through this, so
 * no reconcile path can forget it. A re-assert failure throws, so a caller that records a
 * receipt does not record one for a scope it left switched on.
 *
 * Its own narrow admin slice: unlike the gather above, this one writes.
 */
export async function reconcileThenReassert<T>(
  admin: Pick<HostAdmin, 'reassertSystemSwitches'>,
  actor: PlatformActorId,
  node: { tenantId: TenantId; scopeId: ScopeId },
  reconcile: () => Promise<T>,
): Promise<T> {
  const result = await reconcile();
  await admin.reassertSystemSwitches(actor, node);
  return result;
}
