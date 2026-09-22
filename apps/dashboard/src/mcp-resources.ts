import { MCP_RESOURCES_CONFIG_PREFIX, mcpResourceOf, scopeId as scopeIdSchema, type ScopeId } from '@substrat-run/contracts';
import type { TenantNarrowedControlPlane } from './authority.js';
import type { DashboardAppRow } from './module.js';

/**
 * Registering a vertical's MCP endpoint at the team auth-server it signs in with (#1619).
 *
 * Every vertical mounts an MCP endpoint and names its issuer in its protected-resource
 * document, so a client discovers everything on its own. It then asks that issuer for a
 * token for the endpoint (RFC 8707 `resource`). A team auth-server mints only for
 * resources it has a row for, so without one the answer was `invalid_target`, before any
 * login page. The dashboard is the only party that knows both halves: which hostnames an
 * app answers on, and which of the team's issuers it was bound to. So it is the one that
 * tells the issuer.
 *
 * ## The delivery
 *
 * One entry through the issuer's ordinary `/internal/configure`, platform-gated and
 * tenant-narrowed like every other delivery:
 *
 *     substrat:resources:<app scope id>  =  ["https://<hostname>/api/mcp", …]
 *
 * The value is the app's WHOLE set, so a repeat is a no-op and a hostname that went away
 * drops out. `""` is the un-registration. The auth-server's half, which turns it into rows,
 * is `demos/auth-server/src/resources.ts`.
 *
 * ## When
 *
 *   - **Install**: the identity step, right after the app's `substrat:auth` is delivered.
 *   - **Identity change**: registered at the new issuer, cleared at the old one.
 *   - **Delete**: cleared, before the scope goes offline.
 *   - **Everything that predates this**: `reconcileMcpResources`, run from the Apps list
 *     once per isolate. Existing installs converge the next time anyone on the team loads
 *     the dashboard, and no sooner. Nothing else knows which issuer an app chose: the
 *     control plane's reconcile sweep reaches the vertical, and the vertical cannot reach
 *     the issuer.
 *
 * Each is best-effort, and deliberately so. An install whose login works must not fail
 * because the MCP registration hiccuped. The read path re-asserts it, and a registration
 * that is missing costs `invalid_target` at one client's authorize, never a sign-in.
 *
 * ## What it does not cover
 *
 * The resource is derived from the platform's convention alone (`mcpResourceOf`, the same
 * function vertical-host publishes it with). A vertical that mounts its endpoint somewhere
 * other than `/api/mcp`, or pins a different `resource`, advertises a string this does not
 * register, and its clients still meet `invalid_target`.
 */

type ResourceControlPlane = Pick<TenantNarrowedControlPlane, 'listHostnames' | 'configureInstance'>;

/**
 * The resources an app IS: one MCP endpoint per hostname it actively answers on (the
 * default mint, every surface, every live custom domain). The identifier is the URL a client
 * reached, so each hostname is its own resource. Sorted, so the same bindings always
 * produce the same delivery.
 */
export function mcpResourcesFor(hostnames: ReadonlyArray<{ hostname: string; status: string }>): string[] {
  return [
    ...new Set(hostnames.filter((h) => h.status === 'active').map((h) => mcpResourceOf(`https://${h.hostname}`))),
  ].sort();
}

/**
 * The team auth-server app a stored `substrat:auth` issuer names, if it names one.
 *
 * Matched on the issuer URL, because that is all the stored choice records. The dashboard
 * writes a team auth-server's issuer as `https://<its hostname>` (`resolveAuthChoice`), so
 * the match is exact for everything it bound. An issuer typed in by hand that happens to BE
 * a team auth-server counts too, since the vertical signs in there either way.
 */
export function issuerAppFor(
  issuer: string | null | undefined,
  issuers: readonly DashboardAppRow[],
): DashboardAppRow | undefined {
  if (!issuer) return undefined;
  let origin: string;
  try {
    origin = new URL(issuer).origin;
  } catch {
    return undefined;
  }
  return issuers.find((a) => a.hostname && `https://${a.hostname}` === origin);
}

/** The value the auth-server reads: the set as JSON, or `""` for none. */
function valueOf(resources: readonly string[]): string {
  return resources.length > 0 ? JSON.stringify(resources) : '';
}

/**
 * Register an app's MCP endpoints at a team auth-server — its current bindings, as the set.
 * Returns what was delivered.
 */
export async function registerAppMcpResources(
  cp: ResourceControlPlane,
  input: { appScopeId: ScopeId; issuerScopeId: ScopeId },
): Promise<string[]> {
  const resources = mcpResourcesFor(await cp.listHostnames(input.appScopeId));
  await cp.configureInstance(input.issuerScopeId, [
    { key: `${MCP_RESOURCES_CONFIG_PREFIX}${input.appScopeId}`, value: valueOf(resources) },
  ]);
  return resources;
}

/** Un-register every MCP endpoint of an app at a team auth-server. */
export async function clearAppMcpResources(
  cp: ResourceControlPlane,
  input: { appScopeId: ScopeId; issuerScopeId: ScopeId },
): Promise<void> {
  await cp.configureInstance(input.issuerScopeId, [
    { key: `${MCP_RESOURCES_CONFIG_PREFIX}${input.appScopeId}`, value: '' },
  ]);
}

/** One app's outcome in a reconcile pass, for a caller that logs it and a test that pins it. */
export type McpReconcileOutcome =
  | { appScopeId: string; registeredAt: string; resources: string[]; clearedAt: string[] }
  | { appScopeId: string; skipped: string };

/**
 * Converge every app of a team onto the right registrations: registered at the team
 * auth-server its identity names, and cleared at every other team auth-server. The second
 * half is what repairs an Identity change whose clear did not land. A DELETED app is not in
 * the list, so a delete's clear is not repaired here: its row names a hostname that no
 * longer routes, and the next app bound to that hostname takes it over. Idempotent,
 * since each delivery is a whole set, so running it on every isolate costs deliveries and
 * never changes a registry that is already right.
 *
 * Per app and best-effort: a caller who may not read an app's identity (a viewer) skips
 * that app, and it converges on an owner's visit instead, as the Apps list's other heals do.
 */
export async function reconcileMcpResources(deps: {
  apps: readonly DashboardAppRow[];
  /** Is this app a team auth-server (a vertical that provides `oidc-issuer`)? */
  isIssuer: (app: DashboardAppRow) => boolean;
  /** The issuer the app's stored `substrat:auth` names, or null for none. */
  issuerOf: (appScopeId: string) => Promise<string | null>;
  controlPlane: ResourceControlPlane;
}): Promise<McpReconcileOutcome[]> {
  const issuers = deps.apps.filter((a) => a.status === 'active' && a.hostname && deps.isIssuer(a));
  if (issuers.length === 0) return [];
  const outcomes: McpReconcileOutcome[] = [];
  for (const app of deps.apps) {
    if (app.status !== 'active' || deps.isIssuer(app)) continue;
    const appScopeId = scopeIdSchema.parse(app.app_scope_id);
    try {
      const current = issuerAppFor(await deps.issuerOf(app.app_scope_id), issuers);
      const clearedAt: string[] = [];
      for (const other of issuers) {
        if (other === current) continue;
        await clearAppMcpResources(deps.controlPlane, {
          appScopeId,
          issuerScopeId: scopeIdSchema.parse(other.app_scope_id),
        });
        clearedAt.push(other.app_scope_id);
      }
      if (!current) {
        outcomes.push({ appScopeId: app.app_scope_id, skipped: 'no team auth-server' });
        continue;
      }
      const resources = await registerAppMcpResources(deps.controlPlane, {
        appScopeId,
        issuerScopeId: scopeIdSchema.parse(current.app_scope_id),
      });
      outcomes.push({ appScopeId: app.app_scope_id, registeredAt: current.app_scope_id, resources, clearedAt });
    } catch (e) {
      outcomes.push({ appScopeId: app.app_scope_id, skipped: e instanceof Error ? e.message : String(e) });
    }
  }
  return outcomes;
}
