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
import type {
  ModuleId,
  PlatformActorId,
  ScopeId,
  SwitchedOffInUnit,
  TenantId,
} from '@substrat-run/contracts';
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
 * What a reconcile, provision or restore carries of the switch (#1742): the modules the
 * directory records OFF on this one scope. Spread into the call's body, so the deployment
 * switches them off again inside the unit that re-creates the scope's grants. Empty when
 * nothing is recorded off, so a body for a scope never switched off is unchanged.
 */
export interface SwitchCarry {
  switchedOff?: ModuleId[];
}

/**
 * Read the record for one scope, for `SwitchCarry`. The fleet read, narrowed to this scope
 * and `off`; access-logged like the gather's other reads.
 */
export async function switchCarryFor(
  admin: Pick<HostAdmin, 'listSystemSwitches'>,
  actor: PlatformActorId,
  node: { tenantId: TenantId; scopeId: ScopeId },
): Promise<SwitchCarry> {
  const rows = await admin.listSystemSwitches(actor, {
    position: 'off',
    tenantId: node.tenantId,
    scopeId: node.scopeId,
  });
  return rows.length ? { switchedOff: rows.map((r) => r.moduleId) } : {};
}

/**
 * Run a hosted reconcile or provision, then put the directory's recorded OFF positions back
 * (#1674, #1742).
 *
 * Both run in the vertical's own deployment, and its seat recreates the `system:` grants a
 * wiped scope lost (#1659). So the record is read first and CARRIED into the call (#1742):
 * the deployment switches those modules off inside the seat's own unit, and no sweep of its
 * own can land between the two. The re-assert after the call stays, as the fallback for a
 * deployment built before the field, and it is idempotent: it finds the carried modules
 * already off, and audits the moves the deployment reported instead (`appliedInUnit`).
 *
 * Every caller of `reconcileInstance`, and every `provisionInstance` whose directory row
 * already exists, goes through this, so no path can forget either half. A re-assert failure
 * throws, so a caller that records a receipt does not record one for a scope it left on.
 *
 * Its own narrow admin slice: unlike the gather above, this one writes.
 */
export async function reconcileThenReassert<T extends { switchedOff?: SwitchedOffInUnit[] } | 'unsupported'>(
  admin: Pick<HostAdmin, 'reassertSystemSwitches' | 'listSystemSwitches'>,
  actor: PlatformActorId,
  node: { tenantId: TenantId; scopeId: ScopeId },
  reconcile: (carry: SwitchCarry) => Promise<T>,
): Promise<T> {
  const result = await reconcile(await switchCarryFor(admin, actor, node));
  // What the deployment reported switching off in the unit, for the re-assert to audit.
  const appliedInUnit = result === 'unsupported' ? undefined : result.switchedOff;
  await admin.reassertSystemSwitches(actor, node, { appliedInUnit });
  return result;
}
