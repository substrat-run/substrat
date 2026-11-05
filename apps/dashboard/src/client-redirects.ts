import {
  CLIENT_REDIRECTS_CONFIG_PREFIX,
  MAX_CLIENT_REDIRECT_HOSTNAMES,
  scopeId as scopeIdSchema,
  type ScopeId,
} from '@substrat-run/contracts';
import type { TenantNarrowedControlPlane } from './authority.js';
import { discoverTeamIssuers, issuerFor, type TeamIssuer } from './mcp-resources.js';
import { PLACES_RECONCILE_EVERY_MS, PlacesReconcileGate, type PlacesAppAuth } from './places.js';
import type { DashboardAppRow } from './module.js';

/**
 * Keeping an app's OIDC client at its team auth-server in step with the hostnames the app
 * answers on (#2904).
 *
 * The app's relying party builds its callback and post-logout target from the Host it was
 * reached on, and the issuer matches both exactly. Install registers the default hostname
 * only, so a surface hostname or a custom domain bound later could not sign in or out. The
 * dashboard knows the app's bindings and the client it registered, so it tells the issuer,
 * through its platform-gated `/internal/configure`:
 *
 *     substrat:redirects:<app scope id>  =  {"clientId":"…","hostnames":[…]}   (or "" to clear)
 *
 * The issuer derives the URIs and changes only the ones it derived before
 * (`demos/auth-server/src/client-redirects.ts`).
 *
 * ## When
 *
 *   - **Install** and **Identity change**: delivered at the new issuer, cleared at the old one.
 *   - **A hostname added or removed** on the Domains tab, right after the bind or unbind.
 *   - **A custom domain going active**: the control plane's cron makes that change and does
 *     not know the app's issuer, so the Domains tab's read and the Apps list's pass deliver it.
 *     The pass is also how installs that predate this converge.
 *   - **Delete**: cleared.
 *
 * Every one is best-effort. A hostname binds whether or not its issuer answered; what did not
 * land is logged and delivered again by the next read.
 */

type RedirectsControlPlane = Pick<TenantNarrowedControlPlane, 'listHostnames' | 'configureInstance'>;

/** Where an app's client lives: the team auth-server and the client id it holds there. */
export interface ClientTarget {
  issuerScopeId: ScopeId;
  clientId: string;
}

/**
 * The value for an app's active bindings: sorted, so the same bindings always produce the same
 * delivery, and cut at what the issuer accepts (oldest-name-first is as good as any order, and
 * the same on every pass). `""` when the app answers on nothing.
 */
export function clientRedirectsValue(
  clientId: string,
  hostnames: ReadonlyArray<{ hostname: string; status: string }>,
): string {
  const active = [...new Set(hostnames.filter((h) => h.status === 'active').map((h) => h.hostname.toLowerCase()))]
    .sort()
    .slice(0, MAX_CLIENT_REDIRECT_HOSTNAMES);
  return active.length ? JSON.stringify({ clientId, hostnames: active }) : '';
}

/**
 * This isolate's memory of the last value that LANDED per (issuer, app). A value equal to it is
 * not sent again, so a Domains tab that is re-read while a domain verifies costs one delivery,
 * not one per read; a failed one is not remembered, so the next read retries it.
 */
export const redirectsSent = new Map<string, string>();

const memoKey = (issuerScopeId: string, appScopeId: string) => `${issuerScopeId}:${appScopeId}`;

/**
 * Deliver an app's current bindings to its client, or `""` with `clientId: null`. Returns
 * whether anything was sent.
 */
export async function deliverClientRedirects(
  cp: RedirectsControlPlane,
  input: { appScopeId: ScopeId; issuerScopeId: ScopeId; clientId: string | null },
  sent: Map<string, string> = redirectsSent,
): Promise<boolean> {
  const value = input.clientId ? clientRedirectsValue(input.clientId, await cp.listHostnames(input.appScopeId)) : '';
  const key = memoKey(input.issuerScopeId, input.appScopeId);
  if (sent.get(key) === value) return false;
  await cp.configureInstance(input.issuerScopeId, [{ key: `${CLIENT_REDIRECTS_CONFIG_PREFIX}${input.appScopeId}`, value }]);
  sent.set(key, value);
  return true;
}

/** The app's client target, from its stored identity, if it signs in at one of the team's auth-servers. */
export function clientTargetOf(auth: PlacesAppAuth | null, issuers: readonly TeamIssuer[]): ClientTarget | null {
  const issuer = issuerFor(auth?.issuer, issuers);
  return issuer && auth?.clientId ? { issuerScopeId: issuer.scopeId, clientId: auth.clientId } : null;
}

/** `deliverClientRedirects` for a caller that must not fail on it: logged, and left to the next read. */
export async function settleClientRedirects(
  cp: RedirectsControlPlane,
  input: { appScopeId: ScopeId; issuerScopeId: ScopeId; clientId: string | null },
): Promise<void> {
  await deliverClientRedirects(cp, input).catch((e: unknown) =>
    console.error('dashboard: client redirect delivery failed', {
      appScopeId: input.appScopeId,
      issuerScopeId: input.issuerScopeId,
      reason: e instanceof Error ? e.message : String(e),
    }),
  );
}

/** What one pass did: the apps it delivered for, and the ones it could not. */
export interface RedirectsReconcileOutcome {
  delivered: string[];
  failed: Array<{ appScopeId: string; reason: string }>;
  /** Set when the pass delivered nothing, and why. */
  aborted?: string;
}

/** Did the pass converge? One that did not is run again by the next load. */
export const redirectsConverged = (o: RedirectsReconcileOutcome): boolean => !o.aborted && o.failed.length === 0;

/** The Apps list's gate for the pass (one per isolate, like the places gate). */
export const redirectsReconcile = new PlacesReconcileGate<RedirectsReconcileOutcome>(
  PLACES_RECONCILE_EVERY_MS,
  Date.now,
  redirectsConverged,
);

/**
 * Deliver every app's bindings to its client at the team auth-server it signs in with. Run by
 * the Apps list through a `PlacesReconcileGate` of its own (fingerprint plus every few minutes),
 * which is what catches a custom domain the cron activated. Each delivery settles on its own;
 * an app whose identity cannot be read is skipped and retried, since its key touches nothing
 * else. Not repaired here: a clear at an issuer an app LEFT, which only the Identity change
 * that left it delivers.
 */
export async function reconcileClientRedirects(deps: {
  tenantId: string;
  apps: readonly DashboardAppRow[];
  isIssuer: (app: DashboardAppRow) => boolean;
  authOf: (appScopeId: string) => Promise<PlacesAppAuth | null>;
  controlPlane: RedirectsControlPlane;
  sent?: Map<string, string>;
  log?: (line: string) => void;
}): Promise<RedirectsReconcileOutcome> {
  const outcome: RedirectsReconcileOutcome = { delivered: [], failed: [] };
  const { issuers, unresolved } = await discoverTeamIssuers(deps.apps, deps.isIssuer, deps.controlPlane);
  if (unresolved.length > 0) {
    outcome.aborted = `auth-server hostnames could not be read: ${unresolved.join(', ')}`;
  } else {
    await Promise.all(
      deps.apps
        .filter((app) => app.status === 'active' && !deps.isIssuer(app))
        .map(async (app) => {
          const appScopeId = scopeIdSchema.parse(app.app_scope_id);
          try {
            const target = clientTargetOf(await deps.authOf(appScopeId), issuers);
            if (!target) return;
            if (await deliverClientRedirects(deps.controlPlane, { appScopeId, ...target }, deps.sent)) {
              outcome.delivered.push(appScopeId);
            }
          } catch (e) {
            outcome.failed.push({ appScopeId, reason: e instanceof Error ? e.message : String(e) });
          }
        }),
    );
  }
  if (!redirectsConverged(outcome)) {
    (deps.log ?? ((line) => console.error(line)))(
      `dashboard: client redirect reconcile left work undone ${JSON.stringify({ tenant: deps.tenantId, ...outcome })}`,
    );
  }
  return outcome;
}
