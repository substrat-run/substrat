import type { PlatformActorId, TenantId } from '@substrat-run/contracts';
import { runningVersionOf, type ServingPointer } from '@substrat-run/kernel';
import type { VerticalClient } from './vertical-client.js';

/**
 * Which rung of the serving-ref → bound-version → slug ladder reached a scope (#1653).
 *
 * Both ladders that pick a scope's deployment — the control-plane API's `verticalForScope`
 * and the control plane's sweep resolver — say which rung chose the client, so that what
 * a reconcile records is a fact about the client it used rather than a separate read.
 */
export type ScopeDeploymentVia = 'serving-script' | 'bound-version' | 'slug';

/** A scope's deployment, and the rung that chose it. */
export interface ScopeDeployment {
  client: VerticalClient;
  via: ScopeDeploymentVia;
}

/**
 * The version the deployment chosen for `scope` runs — the one a provision receipt may
 * name after a reconcile through it (#1653).
 *
 * - `serving-script`: what the vertical's serving script serves (`runningVersionOf`), or
 *   the bound version when the pointer names another script or could not be read.
 * - `bound-version`: the bound version — that deployment IS it. This is where a serving
 *   ref that does not resolve falls to, and why the answer has to come from here: the
 *   hook that ran is the bound version's, and a receipt naming the served one would mark
 *   the scope repaired while the served version's hook never ran.
 * - `slug`: the bound version. A static binding or a slug's deployment runs whatever it
 *   runs, and the platform cannot name it; this is the answer every receipt gave before
 *   #1653, kept so a scope reached only this way is not asked again on every pass.
 */
export function versionReachedAt(
  via: ScopeDeploymentVia,
  scope: { verticalVersionId: string | null; servingRef?: string | null },
  serving: ServingPointer | null | undefined,
): string | null {
  return via === 'serving-script' ? runningVersionOf(scope, serving) : scope.verticalVersionId;
}

/**
 * The resolvers the serving-ref → bound-version → slug ladder climbs, and the two registry reads
 * its #417 retry needs. The control-plane API supplies them from its options; the control plane
 * worker supplies the same functions to a reach that must land where the API's reads land (#1686:
 * the operator's capability revoke), so a scope whose capabilities can be listed can be revoked.
 */
export interface ScopeDeploymentLadder {
  verticals?: Record<string, VerticalClient>;
  resolveVertical?: (slug: string, actor: PlatformActorId) => Promise<VerticalClient | undefined>;
  resolveVerticalVersion?: (slug: string, versionId: string, actor: PlatformActorId) => Promise<VerticalClient | undefined>;
  resolveVerticalRef?: (ref: string) => Promise<VerticalClient | undefined>;
  /** The registry's owner of a slug, or `undefined` when no vertical is registered under it. */
  ownerOf: (actor: PlatformActorId, slug: string) => Promise<TenantId | null | undefined>;
  /** The tenant's own slug, or null when it cannot be read. */
  tenantSlugOf: (actor: PlatformActorId, tenantId: TenantId) => Promise<string | null>;
}

/**
 * The deployment serving `scope`, and the rung that chose it — the ONE ladder the API's
 * delegated reads and writes climb.
 *
 * A scope on the stable serving script (#286) is reached THERE, whatever the bound version or the
 * prod channel say. Then the bound version's deployment, then the slug's. On a miss only (#417),
 * a scope bound to a BARE slug that is not registered, while the owning tenant's prefixed
 * registration of the same name exists, is addressing the prefixed lineage under its bare
 * spelling: retried once under the registry id. A resolved scope never pays for those reads.
 */
export async function scopeDeployment(
  ladder: ScopeDeploymentLadder,
  actor: PlatformActorId,
  scope: { tenantId?: TenantId; vertical: string | null; verticalVersionId: string | null; servingRef?: string | null },
): Promise<ScopeDeployment | undefined> {
  if (!scope.vertical) return undefined;
  if (scope.servingRef && ladder.resolveVerticalRef) {
    const serving = await ladder.resolveVerticalRef(scope.servingRef);
    if (serving) return { client: serving, via: 'serving-script' };
  }
  const bySlug = async (slug: string): Promise<ScopeDeployment | undefined> => {
    if (scope.verticalVersionId && ladder.resolveVerticalVersion) {
      const bound = await ladder.resolveVerticalVersion(slug, scope.verticalVersionId, actor);
      if (bound) return { client: bound, via: 'bound-version' };
    }
    const bySlugClient = ladder.verticals?.[slug] ?? (await ladder.resolveVertical?.(slug, actor));
    return bySlugClient ? { client: bySlugClient, via: 'slug' } : undefined;
  };
  const direct = await bySlug(scope.vertical);
  if (direct) return direct;
  if (scope.tenantId && !scope.vertical.includes('/') && (await ladder.ownerOf(actor, scope.vertical)) === undefined) {
    const tenantSlug = await ladder.tenantSlugOf(actor, scope.tenantId);
    const prefixed = tenantSlug ? `${tenantSlug}/${scope.vertical}` : null;
    if (prefixed && (await ladder.ownerOf(actor, prefixed)) !== undefined) return bySlug(prefixed);
  }
  return undefined;
}
