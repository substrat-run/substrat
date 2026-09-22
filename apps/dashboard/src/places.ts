import {
  MAX_PLACE_REGISTRATIONS,
  PLACES_CONFIG_PREFIX,
  placeRegistration,
  scopeId as scopeIdSchema,
  type PlaceRegistration,
} from '@substrat-run/contracts';
import type { TenantNarrowedControlPlane } from './authority.js';
import { discoverTeamIssuers, issuerFor } from './mcp-resources.js';
import type { DashboardAppRow } from './module.js';

/**
 * Registering a team's apps as PLACES at the team auth-servers they sign in with (#1670).
 *
 * A login's places — where it holds a principal, across every app signing in at one identity
 * pool — are listed on that pool's own origin, by the team auth-server that minted the `sub`.
 * The pool keeps the index; the vertical reports who is bound in its scope. What neither of
 * them may say is which apps are places at all, and under what tenant, hostname and name: a
 * vertical that could say that could put "Your Bank" into a user's list. So the platform says
 * it, and the dashboard is the part of the platform that knows both halves — the app's client
 * at the issuer (it registered it) and the hostname it answers on.
 *
 * ## The delivery
 *
 * One entry per team auth-server, through its ordinary platform-gated `/internal/configure`:
 *
 *     substrat:places:<tenant id>  =  [{ appScopeId, clientId, hostname, name }, …]
 *
 * The value is the team's WHOLE set of apps signing in at THAT issuer, and every team issuer
 * gets one, empty or not. So an app the team deleted, or moved to another issuer, simply drops
 * out of the next delivery, and the issuer drops its entries with it. There is no separate
 * clear on delete to lose. The auth-server's half is `demos/auth-server/src/places.ts`.
 *
 * ## When
 *
 * From the Apps list, after the response, through `PlacesReconcileGate`: once per isolate per
 * team, again whenever the first page of apps changed (an install lands at its top), and at
 * least every `PLACES_RECONCILE_EVERY_MS` otherwise, which is how an Identity change converges.
 * A delivery that did not land is retried by the next pass. Only what changed since this
 * isolate last delivered is sent.
 *
 * ## What it does not cover
 *
 * Apps of OTHER teams signing in at this team's issuer. The dashboard is tenant-narrowed and
 * delivers only its own team's apps, so a managed tenant provisioned through the platform-
 * request drain, or an app whose identity was typed in by hand to name another team's
 * auth-server, is not registered by anything yet. Listed on #1670 as open.
 */

/** How often an unchanged team is reconciled again, at most, per isolate. */
export const PLACES_RECONCILE_EVERY_MS = 5 * 60_000;

/** The stored identity of an app, as far as places need it. */
export interface PlacesAppAuth {
  issuer?: string | null;
  clientId?: string | null;
}

/** An app left out of every delivery, and why. */
export interface PlacesSkip {
  appScopeId: string;
  reason: string;
}

/**
 * The registration an app contributes, or why it contributes none. Parsed through the
 * contracts schema here rather than at the issuer, so one app with an unusable name drops
 * out on its own instead of getting the whole team's delivery refused.
 */
export function placeRegistrationOf(app: DashboardAppRow, auth: PlacesAppAuth | null): PlaceRegistration | PlacesSkip {
  if (!auth?.clientId) return { appScopeId: app.app_scope_id, reason: 'no client at its issuer' };
  if (!app.hostname) return { appScopeId: app.app_scope_id, reason: 'no hostname yet' };
  const parsed = placeRegistration.safeParse({
    appScopeId: app.app_scope_id,
    clientId: auth.clientId,
    hostname: app.hostname.toLowerCase(),
    name: app.name,
  });
  return parsed.success ? parsed.data : { appScopeId: app.app_scope_id, reason: parsed.error.issues[0]?.message ?? 'invalid' };
}

/** The value the auth-server reads: the set as JSON, or `""` for none. */
function valueOf(registrations: readonly PlaceRegistration[]): string {
  return registrations.length > 0 ? JSON.stringify(registrations) : '';
}

/** What one pass did, for the log line and the tests. */
export interface PlacesReconcileOutcome {
  /** Per team issuer: the apps it was told are places there (possibly none). */
  delivered: Array<{ issuerScopeId: string; apps: string[] }>;
  /** Deliveries not sent because this isolate already sent exactly that value. */
  unchanged: string[];
  failed: Array<{ issuerScopeId: string; reason: string }>;
  skipped: PlacesSkip[];
  /** Set when the pass stopped before delivering anything, and why. */
  aborted?: string;
}

const reasonOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Did a pass converge everything it touched? One that did not is run again by the next load. */
export function placesConverged(outcome: PlacesReconcileOutcome): boolean {
  return !outcome.aborted && outcome.failed.length === 0;
}

/** What a places pass needs. */
export interface PlacesReconcileDeps {
  tenantId: string;
  apps: readonly DashboardAppRow[];
  /** Is this app a team auth-server (a vertical that provides `oidc-issuer`)? */
  isIssuer: (app: DashboardAppRow) => boolean;
  /** The app's stored `substrat:auth`, or null for none. */
  authOf: (appScopeId: string) => Promise<PlacesAppAuth | null>;
  controlPlane: Pick<TenantNarrowedControlPlane, 'listHostnames' | 'configureInstance'>;
  sent?: Map<string, string>;
  /** Where a pass that left anything undone says so. The worker's error log by default. */
  log?: (line: string) => void;
}

/**
 * Tell every team auth-server exactly which of the team's apps sign in there. Each delivery
 * settles on its own, so an issuer that is down does not keep the others from converging.
 *
 * `sent` is this isolate's memory of the last value that LANDED per issuer. A value equal to
 * it is not sent again; a failed one is not remembered, so the next pass retries it.
 *
 * A pass that left anything undone — a delivery that failed, a pass that aborted, or an app
 * skipped, the over-the-cap ones included — says so on `log`, here rather than at the call
 * site, so a pass that converged everything it delivered but left an app out is never silent.
 */
export async function reconcilePlaces(deps: PlacesReconcileDeps): Promise<PlacesReconcileOutcome> {
  const outcome = await placesPass(deps);
  if (!placesConverged(outcome) || outcome.skipped.length) {
    (deps.log ?? ((line) => console.error(line)))(
      `dashboard: places reconcile left work undone ${JSON.stringify({ tenant: deps.tenantId, ...outcome })}`,
    );
  }
  return outcome;
}

async function placesPass(deps: PlacesReconcileDeps): Promise<PlacesReconcileOutcome> {
  const outcome: PlacesReconcileOutcome = { delivered: [], unchanged: [], failed: [], skipped: [] };
  // The same discovery, and the same rule, as the MCP pass (#1683): an auth-server whose
  // origins cannot be read this pass is NOT "the team has no such issuer". Every app bound to
  // it would match no issuer and drop out of the sets, so nothing is delivered and the pass
  // reports itself unconverged, to be retried by the next load. An EMPTY set is a real
  // answer: with no team auth-server there is nowhere to deliver.
  const { issuers, unresolved } = await discoverTeamIssuers(deps.apps, deps.isIssuer, deps.controlPlane);
  if (unresolved.length > 0) {
    outcome.aborted = `auth-server hostnames could not be read: ${unresolved.join(', ')}`;
    return outcome;
  }
  if (issuers.length === 0) return outcome;

  const byIssuer = new Map<string, PlaceRegistration[]>(issuers.map((i) => [i.scopeId, []]));
  for (const app of deps.apps) {
    if (app.status !== 'active' || deps.isIssuer(app)) continue;
    let auth: PlacesAppAuth | null;
    try {
      auth = await deps.authOf(app.app_scope_id);
    } catch (e) {
      // An app whose identity cannot be read this pass must not be dropped from the set on
      // that account — a delivery without it would clear its entries. So the whole pass
      // stops here, delivers nothing, and is retried.
      outcome.aborted = `reading ${app.app_scope_id}'s identity: ${reasonOf(e)}`;
      return outcome;
    }
    const issuer = issuerFor(auth?.issuer, issuers);
    if (!issuer) continue;
    // The stored hostname is a snapshot that can be null while the router serves the app (the
    // Apps list heals it the same way); a place without one would be dropped from the set.
    const hostname =
      app.hostname ??
      (
        await deps.controlPlane
          .listHostnames(scopeIdSchema.parse(app.app_scope_id))
          .catch(() => [] as Array<{ hostname: string; status: string }>)
      ).find((h) => h.status === 'active')?.hostname ??
      null;
    const registration = placeRegistrationOf({ ...app, hostname }, auth);
    if ('reason' in registration) {
      outcome.skipped.push(registration);
      continue;
    }
    byIssuer.get(issuer.scopeId)!.push(registration);
  }

  const key = `${PLACES_CONFIG_PREFIX}${deps.tenantId}`;
  await Promise.all(
    [...byIssuer].map(async ([issuerScopeId, registrations]) => {
      // At most `MAX_PLACE_REGISTRATIONS` per issuer, which is what the issuer's parse accepts:
      // one more and the WHOLE delivery would be refused, leaving the issuer on a stale set and
      // every later pass repeating the refused call. Sorted by scope id (a ULID, so oldest
      // first), the cut is the same on every pass, and every app past it is a named skip.
      const sorted = [...registrations].sort((a, b) => a.appScopeId.localeCompare(b.appScopeId));
      const kept = sorted.slice(0, MAX_PLACE_REGISTRATIONS);
      for (const over of sorted.slice(MAX_PLACE_REGISTRATIONS)) {
        outcome.skipped.push({
          appScopeId: over.appScopeId,
          reason: `over the ${MAX_PLACE_REGISTRATIONS} places one issuer takes per team`,
        });
      }
      const value = valueOf(kept);
      if (deps.sent?.get(issuerScopeId) === value) {
        outcome.unchanged.push(issuerScopeId);
        return;
      }
      try {
        await deps.controlPlane.configureInstance(scopeIdSchema.parse(issuerScopeId), [{ key, value }]);
        deps.sent?.set(issuerScopeId, value);
        outcome.delivered.push({ issuerScopeId, apps: kept.map((r) => r.appScopeId) });
      } catch (e) {
        outcome.failed.push({ issuerScopeId, reason: reasonOf(e) });
      }
    }),
  );
  return outcome;
}

/**
 * The Apps list's gate for the places pass, keyed by TEAM, per isolate.
 *
 * Runs a pass when this team has none in flight and any of: it never converged here; the first
 * page of apps changed since (a fresh install is at its top); or `everyMs` has passed. Any
 * member's load may trigger it, viewers included, for the reason `McpReconcileGate` gives: it
 * writes nothing the member asked for, only what the team's own configuration implies.
 */
export class PlacesReconcileGate {
  private readonly last = new Map<string, { at: number; fingerprint: string }>();
  private readonly running = new Set<string>();
  /** Per team: issuer scope → the value that last landed there. */
  private readonly sentByTeam = new Map<string, Map<string, string>>();

  constructor(
    private readonly everyMs: number = PLACES_RECONCILE_EVERY_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** What a page of apps looks like to the gate: which apps, where, in what state. */
  static fingerprintOf(apps: readonly DashboardAppRow[]): string {
    return apps.map((a) => `${a.app_scope_id}:${a.status}:${a.hostname ?? ''}:${a.name}`).join('|');
  }

  run(
    tenantId: string,
    page: readonly DashboardAppRow[],
    pass: (sent: Map<string, string>) => Promise<PlacesReconcileOutcome>,
  ): Promise<PlacesReconcileOutcome> | null {
    if (this.running.has(tenantId)) return null;
    const fingerprint = PlacesReconcileGate.fingerprintOf(page);
    const last = this.last.get(tenantId);
    if (last && last.fingerprint === fingerprint && this.now() - last.at < this.everyMs) return null;
    this.running.add(tenantId);
    let sent = this.sentByTeam.get(tenantId);
    if (!sent) this.sentByTeam.set(tenantId, (sent = new Map()));
    return pass(sent)
      .then((outcome) => {
        if (placesConverged(outcome)) this.last.set(tenantId, { at: this.now(), fingerprint });
        return outcome;
      })
      .finally(() => this.running.delete(tenantId));
  }
}

/** The Apps list's places gate for this isolate (one per worker isolate, like the MCP gate). */
export const placesReconcile = new PlacesReconcileGate();
