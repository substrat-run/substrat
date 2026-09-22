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
 *     once per isolate per team, and again on each load until a pass converges
 *     (`McpReconcileGate`). Existing installs converge the next time anyone on the team
 *     loads the dashboard, and no sooner. Nothing else knows which issuer an app chose: the
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

/** A team auth-server as the registration addresses it. */
export interface TeamIssuer {
  scopeId: ScopeId;
  /** `https://<hostname>` for every hostname it answers on, stored or live. */
  origins: ReadonlySet<string>;
}

/**
 * The team's auth-servers, hydrated from their LIVE bindings.
 *
 * The stored `hostname` column is a snapshot taken at install, and it can be null while the
 * router serves the app: a bind whose activation step threw leaves it that way, which is
 * why the Apps list re-reads live bindings at all. An auth-server found only through that
 * column would drop out of every registration, and no install bound to it would ever
 * converge. So each one's live bindings are read too, and every hostname it answers on is
 * an origin its issuer URL may carry (a custom domain included). A live read that fails
 * falls back to the stored column, never to nothing.
 */
export async function teamIssuers(
  apps: readonly DashboardAppRow[],
  isIssuer: (app: DashboardAppRow) => boolean,
  cp: Pick<TenantNarrowedControlPlane, 'listHostnames'>,
): Promise<TeamIssuer[]> {
  const issuers: TeamIssuer[] = [];
  for (const app of apps) {
    if (app.status !== 'active' || !isIssuer(app)) continue;
    const scopeId = scopeIdSchema.parse(app.app_scope_id);
    const live = await cp
      .listHostnames(scopeId)
      .then((rows) => rows.filter((h) => h.status === 'active').map((h) => h.hostname))
      .catch(() => [] as string[]);
    const hostnames = [...new Set([...(app.hostname ? [app.hostname] : []), ...live])];
    if (hostnames.length > 0) issuers.push({ scopeId, origins: new Set(hostnames.map((h) => `https://${h}`)) });
  }
  return issuers;
}

/**
 * The team auth-server a stored `substrat:auth` issuer names, if it names one.
 *
 * Matched on the issuer URL's origin, because that is all the stored choice records. The
 * dashboard writes a team auth-server's issuer as `https://<its hostname>`
 * (`resolveAuthChoice`). An issuer typed in by hand that happens to BE a team auth-server
 * counts too, since the vertical signs in there either way.
 */
export function issuerFor(issuer: string | null | undefined, issuers: readonly TeamIssuer[]): TeamIssuer | undefined {
  if (!issuer) return undefined;
  let origin: string;
  try {
    origin = new URL(issuer).origin;
  } catch {
    return undefined;
  }
  return issuers.find((i) => i.origins.has(origin));
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
  | {
      appScopeId: string;
      /** The issuer it is registered at, or null when its identity names none of the team's. */
      registeredAt: string | null;
      resources: string[];
      clearedAt: string[];
      /** Deliveries that did not land, each on its own. Every other one still went out. */
      failed: Array<{ issuerScopeId: string; reason: string }>;
    }
  | { appScopeId: string; skipped: string };

/** Did a pass converge everything it touched? A caller that did not must run it again. */
export function reconcileConverged(outcomes: readonly McpReconcileOutcome[]): boolean {
  return outcomes.every((o) => !('skipped' in o) && o.failed.length === 0);
}

const reasonOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Converge every app of a team onto the right registrations: registered at the team
 * auth-server its identity names, and cleared at every other team auth-server. The second
 * half is what repairs an Identity change whose clear did not land. A DELETED app is not in
 * the list, so a delete's clear is not repaired here: its row names a hostname that no
 * longer routes, and the next app bound to that hostname takes it over. Idempotent,
 * since each delivery is a whole set, so running it again costs deliveries and never
 * changes a registry that is already right.
 *
 * Every delivery for an app settles on its own. An auth-server that is down must not keep
 * the app from being registered at the healthy one it actually signs in with. Otherwise a
 * single unreachable issuer would stop every install on the team from converging, pass after
 * pass. What failed is reported per issuer, and `reconcileConverged` says whether the pass
 * has to run again.
 */
export async function reconcileMcpResources(deps: {
  apps: readonly DashboardAppRow[];
  /** Is this app a team auth-server (a vertical that provides `oidc-issuer`)? */
  isIssuer: (app: DashboardAppRow) => boolean;
  /** The issuer the app's stored `substrat:auth` names, or null for none. */
  issuerOf: (appScopeId: string) => Promise<string | null>;
  controlPlane: ResourceControlPlane;
}): Promise<McpReconcileOutcome[]> {
  const issuers = await teamIssuers(deps.apps, deps.isIssuer, deps.controlPlane);
  if (issuers.length === 0) return [];
  const outcomes: McpReconcileOutcome[] = [];
  for (const app of deps.apps) {
    if (app.status !== 'active' || deps.isIssuer(app)) continue;
    const appScopeId = scopeIdSchema.parse(app.app_scope_id);
    let named: string | null;
    try {
      named = await deps.issuerOf(app.app_scope_id);
    } catch (e) {
      outcomes.push({ appScopeId: app.app_scope_id, skipped: reasonOf(e) });
      continue;
    }
    const current = issuerFor(named, issuers);
    const others = issuers.filter((i) => i !== current);
    const [registered, ...cleared] = await Promise.allSettled([
      current
        ? registerAppMcpResources(deps.controlPlane, { appScopeId, issuerScopeId: current.scopeId })
        : Promise.resolve([] as string[]),
      ...others.map((i) => clearAppMcpResources(deps.controlPlane, { appScopeId, issuerScopeId: i.scopeId })),
    ]);
    const failed: Array<{ issuerScopeId: string; reason: string }> = [];
    if (current && registered!.status === 'rejected') {
      failed.push({ issuerScopeId: current.scopeId, reason: reasonOf(registered!.reason) });
    }
    const clearedAt: string[] = [];
    cleared.forEach((result, i) => {
      if (result.status === 'fulfilled') clearedAt.push(others[i]!.scopeId);
      else failed.push({ issuerScopeId: others[i]!.scopeId, reason: reasonOf(result.reason) });
    });
    outcomes.push({
      appScopeId: app.app_scope_id,
      registeredAt: current && registered!.status === 'fulfilled' ? current.scopeId : null,
      resources: registered!.status === 'fulfilled' ? registered!.value : [],
      clearedAt,
      failed,
    });
  }
  return outcomes;
}

/**
 * The Apps list's once-per-isolate gate for the reconcile above, keyed by TEAM.
 *
 * Per team, not per principal. Every member role holds `dashboard:read`, which is all the
 * pass needs, so gating by principal did not skip viewers. It only ran the whole pass once
 * per member, multiplying the same deliveries by team size. Any member's load may trigger
 * it, and that is not an escalation: the pass writes nothing the member asked for. It
 * re-asserts registrations the team's own stored configuration already implies, through the
 * platform's own channel, and it is idempotent. "Existing installs converge on the next
 * load by anyone on the team" is the promise this keeps.
 *
 * Marked done only once a pass has CONVERGED, the way `account.ts` marks its self-heal only
 * after it succeeds. A pass that threw, or that left a delivery undelivered, is run again
 * by the next load instead of being skipped for the life of the isolate. A pass that is
 * still running is not started twice.
 */
export class McpReconcileGate {
  private readonly converged = new Set<string>();
  private readonly running = new Map<string, Promise<void>>();

  /** Start the pass for this team unless it converged here already or is running now. */
  run(tenantId: string, pass: () => Promise<boolean>): Promise<void> | null {
    if (this.converged.has(tenantId) || this.running.has(tenantId)) return null;
    const started = pass()
      .then((done) => {
        if (done) this.converged.add(tenantId);
      })
      .finally(() => this.running.delete(tenantId));
    this.running.set(tenantId, started);
    return started;
  }
}
