import {
  CLIENT_REDIRECTS_CONFIG_PREFIX,
  PLACES_CONFIG_PREFIX,
  type PlatformActorId,
  type Scope,
  type ScopeId,
  type TenantId,
} from '@substrat-run/contracts';
import type { ScopeHost } from '@substrat-run/kernel';
import { ControlPlaneError } from '@substrat-run/control-plane-client';
import type { VerticalClient } from './vertical-client.js';

/**
 * The end of a MANAGED tenant's sign-in at its manager's team auth-servers (#3202, D-72, #3261).
 *
 * A tenant a manager provisioned with `instance.signIn` signs in at one of the manager's team
 * auth-servers, as a client the platform registered there, and is a place there under its own
 * key, so a person's account page lists it (`provision-tenant`, `platform-drain.ts`). Nothing in
 * the tenant's scope knows to undo that, and the dashboard, which keeps its own team's places in
 * step, never sees another team's tenant. So the platform undoes it where the tenant ends:
 *
 *   - **`unlistManagedTenant`** — the tenant entered `deleting`. Its place goes from every one of
 *     the manager's auth-servers, so nobody's list shows a business being deleted. The client
 *     stays: `deleting` is reversible, and an un-deleted tenant must still sign in.
 *   - **`removeManagedSignIn`** — one of the tenant's scopes is being reaped, by the staff tenant
 *     or scope reap or the retention sweep. Its client, its place and its redirect record go
 *     (`DELETE /internal/managed-client`, keyed by the scope).
 *
 * ## Where to look
 *
 * Every active scope of the MANAGER's tenant (the directory's `provisionedByTenant`, never anything
 * the tenant or a vertical says) whose vertical provides `oidc-issuer`. The tenant's own record
 * says which one it signed in at only inside its delivered `substrat:auth`, which the platform
 * never reads back, so every one of them is asked; each removes only what it holds under the
 * managed tenant's key and scope, and an issuer that holds nothing answers that it removed
 * nothing. A tenant no manager provisioned has nothing at any team's issuer, and is skipped.
 *
 * ## Failure
 *
 * Every issuer is tried, and then any that could not be reached are named in one throw
 * (`ManagedSignInIncomplete`). The callers do not swallow it: a reap stops before it wipes
 * anything and is retried (the sweep's next pass, or the staff route again), and a status change
 * answers an error saying the place may still be listed. Both operations are idempotent, so a
 * retry repeats nothing that landed.
 */

export interface ManagedSignInDeps {
  admin: Pick<ScopeHost['admin'], 'getTenant' | 'listScopes' | 'listVerticals'>;
  actor: PlatformActorId;
  /** The deployment serving a scope, or undefined when none is bound. */
  resolveVerticalForScope: (scope: Scope) => Promise<VerticalClient | undefined>;
}

/** Some of the manager's auth-servers could not be told; each is named with why. */
export class ManagedSignInIncomplete extends Error {
  constructor(
    readonly tenantId: TenantId,
    readonly failed: ReadonlyArray<{ issuerScopeId: ScopeId; reason: string }>,
  ) {
    super(
      `managed tenant ${tenantId}: its sign-in could not be removed at ${failed.length} of its manager's auth-servers ` +
        `(${failed.map((f) => `${f.issuerScopeId}: ${f.reason}`).join('; ')})`,
    );
    this.name = 'ManagedSignInIncomplete';
  }
}

/** What a pass did: the issuers it reached, and, for a removal, the clients they deleted. */
export interface ManagedSignInOutcome {
  /** The managing tenant, or null when the tenant is not a managed one (nothing was asked). */
  manager: TenantId | null;
  reached: ScopeId[];
  removedClients: string[];
}

const reasonOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

interface Issuer {
  scope: Scope;
  client: VerticalClient | undefined;
}

/** The managing tenant and its active team auth-servers, or null for a tenant no manager provisioned. */
async function managerIssuersOf(deps: ManagedSignInDeps, tenantId: TenantId): Promise<{ manager: TenantId; issuers: Issuer[] } | null> {
  const tenant = await deps.admin.getTenant(deps.actor, tenantId);
  const manager = tenant?.provisionedByTenant;
  if (!manager) return null;
  const slugs = (await deps.admin.listVerticals(deps.actor)).filter((v) => v.provides?.includes('oidc-issuer')).map((v) => v.slug);
  const issuers: Issuer[] = [];
  for (const vertical of slugs) {
    for (const scope of await deps.admin.listScopes(deps.actor, { tenantId: manager, status: 'active', vertical })) {
      issuers.push({ scope, client: await deps.resolveVerticalForScope(scope) });
    }
  }
  return { manager, issuers };
}

async function eachIssuer(
  deps: ManagedSignInDeps,
  tenantId: TenantId,
  act: (issuer: { scope: Scope; client: VerticalClient }, manager: TenantId) => Promise<string | null>,
): Promise<ManagedSignInOutcome> {
  const found = await managerIssuersOf(deps, tenantId);
  if (!found) return { manager: null, reached: [], removedClients: [] };
  const outcome: ManagedSignInOutcome = { manager: found.manager, reached: [], removedClients: [] };
  const failed: Array<{ issuerScopeId: ScopeId; reason: string }> = [];
  for (const { scope, client } of found.issuers) {
    // An auth-server with no deployment to reach may still hold the place, so it is a failure,
    // not a skip: the caller retries rather than reporting the place gone.
    if (!client) {
      failed.push({ issuerScopeId: scope.id, reason: 'no deployment is bound for it' });
      continue;
    }
    try {
      const removed = await act({ scope, client }, found.manager);
      outcome.reached.push(scope.id);
      if (removed) outcome.removedClients.push(removed);
    } catch (e) {
      failed.push({ issuerScopeId: scope.id, reason: reasonOf(e) });
    }
  }
  if (failed.length) throw new ManagedSignInIncomplete(tenantId, failed);
  return outcome;
}

/**
 * The managed tenant entered `deleting`: take its place off every one of its manager's
 * auth-servers (`substrat:places:<tenant>` = `""`, the whole set under its own key). The client
 * and its redirects stay, so an un-delete still signs in. A tenant no manager provisioned is a
 * no-op.
 */
export function unlistManagedTenant(deps: ManagedSignInDeps, tenantId: TenantId): Promise<ManagedSignInOutcome> {
  return eachIssuer(deps, tenantId, async ({ scope, client }, manager) => {
    await client.configureInstance({
      tenantId: manager,
      scopeId: scope.id,
      entries: [{ key: `${PLACES_CONFIG_PREFIX}${tenantId}`, value: '' }],
    });
    return null;
  });
}

/**
 * One of the managed tenant's scopes is being reaped: remove its client, its place and its
 * redirect record at every one of its manager's auth-servers. An auth-server deployed before the
 * keyed verb answers 501; it cannot hold a keyed client, so it is told the un-registrations a
 * plain delivery can say (the place under the tenant's key, the scope's redirects), and the
 * client it was registered by open registration (#3249) stays there, listed by nothing.
 */
export function removeManagedSignIn(deps: ManagedSignInDeps, tenantId: TenantId, scopeId: ScopeId): Promise<ManagedSignInOutcome> {
  return eachIssuer(deps, tenantId, async ({ scope, client }, manager) => {
    try {
      const removed = await client.removeManagedClient({ tenantId: manager, scopeId: scope.id, appTenantId: tenantId, appScopeId: scopeId });
      return removed.removed;
    } catch (e) {
      if (!(e instanceof ControlPlaneError && e.status === 501)) throw e;
      await client.configureInstance({
        tenantId: manager,
        scopeId: scope.id,
        entries: [
          { key: `${CLIENT_REDIRECTS_CONFIG_PREFIX}${scopeId}`, value: '' },
          { key: `${PLACES_CONFIG_PREFIX}${tenantId}`, value: '' },
        ],
      });
      return null;
    }
  });
}
