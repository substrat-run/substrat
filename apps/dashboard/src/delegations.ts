import {
  DELEGATIONS_CONFIG_PREFIX,
  delegationGrants,
  scopeId as scopeIdSchema,
  type DelegationGrant,
  type ManifestDelegation,
  type ScopeId,
} from '@substrat-run/contracts';
import { samePeerVertical } from '@substrat-run/kernel';
import type { TenantNarrowedControlPlane } from './authority.js';
import { discoverTeamIssuers, issuerFor } from './mcp-resources.js';
import type { DashboardAppRow } from './module.js';
import { PLACES_RECONCILE_EVERY_MS, PlacesReconcileGate } from './places.js';

/**
 * Delivering an app's delegation grants to the team auth-server it signs in with (#3161).
 *
 * A vertical's module manifests may declare `delegations`: which OTHER vertical of the tenant
 * may act for a person signed in here, with which of this vertical's keys, on which channels.
 * A plugin taking its people from a master app is the shape: the plugin declares the master.
 * The issuer only lets an actor exchange a person's token for one addressed to the host when
 * it holds a grant for that pair, and only the platform may give it one. The dashboard is the
 * party that knows every fact a grant needs: which version each app runs, which app of the team
 * a declared slug names, and which issuer each of them signs in with. So it delivers them.
 *
 * ## The delivery
 *
 * One entry per HOST app through the issuer's `/internal/configure`, platform-gated and
 * tenant-narrowed like every other delivery (vocabulary in `@substrat-run/contracts`'
 * `delegations.ts`, the issuer's half in `demos/auth-server/src/delegations.ts`):
 *
 *     substrat:delegations:<host app scope id>  =  [{ "actor": "<actor app scope id>", … }]
 *
 * The value is the host's WHOLE set, so a repeat is a no-op and a grant the host no longer
 * declares is revoked by the next delivery. `""` revokes all of them.
 *
 * ## What a declared slug becomes
 *
 * The app of that vertical in the SAME team, found by the peer rule (`samePeerVertical`: the
 * bare slug and this tenant's pinned `<tenant>/<slug>`, an exact spelling first), and signing
 * in at the SAME team auth-server as the host. Anything else is skipped and logged once per
 * isolate, never guessed: no install, several (which one a person meant is not this file's
 * call), or one on another issuer, where the exchange could never happen anyway. An app on an
 * issuer that is not one of the team's auth-servers gets no grant at all.
 *
 * ## When
 *
 *   - **Install, retry, delete, an Identity change, a promote or a version bind made here**:
 *     the whole team's set again, after the response (`syncDelegationsIn` in `worker.ts`). One
 *     pass, because each of them can change a host's set: its own running version, its issuer,
 *     or whether an actor it names resolves.
 *   - **Delete of a host**: cleared at its issuer beside the MCP un-registration, since a
 *     deleted app is no longer in the list a pass walks.
 *   - **Everything else**: the Apps list's pass (`DelegationsReconcileGate`), every few minutes
 *     per team. A version promoted by the CLI or a deploy workflow reaches the issuer that way.
 *
 * Each is best-effort, as the MCP registration is: a missing grant costs a refused exchange,
 * never a sign-in, and the next pass delivers it.
 *
 * ## The one unknown
 *
 * The declaration is read from the RUNNING version (the bound one, else `prod`). A version
 * whose stored manifest does not say (`null`, pushed before the field was carried) is left
 * alone: nothing is delivered for it, so a grant from elsewhere is not revoked by a guess.
 */

/** A declared actor that is not a grant, and why. */
export type DelegationSkip =
  | { actor: string; reason: 'not-installed' }
  | { actor: string; reason: 'ambiguous'; scopeIds: string[] }
  | { actor: string; reason: 'other-issuer'; scopeId: string }
  | { actor: string; reason: 'duplicate'; scopeId: string };

/**
 * A host's grants from its declaration, resolved against the team's apps. Pure.
 *
 * `issuerOfApp` holds the team auth-server each app signs in at, or null for none of them;
 * an app it does not hold signs in at none.
 */
export function delegationGrantsFor(input: {
  declared: readonly ManifestDelegation[];
  hostIssuerScopeId: string;
  apps: readonly DashboardAppRow[];
  tenantSlug: string | null;
  issuerOfApp: ReadonlyMap<string, string | null>;
}): { grants: DelegationGrant[]; skipped: DelegationSkip[] } {
  const live = input.apps.filter((a) => a.status === 'active');
  const grants: DelegationGrant[] = [];
  const skipped: DelegationSkip[] = [];
  for (const d of input.declared) {
    const matches = live.filter((a) => samePeerVertical(a.vertical_slug, d.actor, input.tenantSlug));
    const exact = matches.filter((a) => a.vertical_slug === d.actor);
    const chosen = exact.length > 0 ? exact : matches;
    if (chosen.length === 0) {
      skipped.push({ actor: d.actor, reason: 'not-installed' });
      continue;
    }
    if (chosen.length > 1) {
      skipped.push({ actor: d.actor, reason: 'ambiguous', scopeIds: chosen.map((a) => a.app_scope_id).sort() });
      continue;
    }
    const actor = chosen[0]!.app_scope_id;
    if ((input.issuerOfApp.get(actor) ?? null) !== input.hostIssuerScopeId) {
      skipped.push({ actor: d.actor, reason: 'other-issuer', scopeId: actor });
      continue;
    }
    // Two spellings of one vertical (`todo`, `acme/todo`) reach one app; the issuer refuses a
    // set naming an actor twice, so the first declaration stands.
    if (grants.some((g) => g.actor === actor)) {
      skipped.push({ actor: d.actor, reason: 'duplicate', scopeId: actor });
      continue;
    }
    grants.push({
      actor: scopeIdSchema.parse(actor),
      permissions: [...d.permissions],
      ...(d.channels ? { channels: [...d.channels] } : {}),
    });
  }
  return { grants, skipped };
}

type DelegationsControlPlane = Pick<TenantNarrowedControlPlane, 'configureInstance'>;

/** Deliver a host's whole set to one issuer; `[]` revokes every grant it held there. */
export async function deliverAppDelegations(
  cp: DelegationsControlPlane,
  input: { hostScopeId: ScopeId; issuerScopeId: ScopeId; grants: readonly DelegationGrant[] },
): Promise<void> {
  const grants = delegationGrants.parse(input.grants);
  await cp.configureInstance(input.issuerScopeId, [
    { key: `${DELEGATIONS_CONFIG_PREFIX}${input.hostScopeId}`, value: grants.length > 0 ? JSON.stringify(grants) : '' },
  ]);
}

/** Revoke every grant a host holds at one issuer. */
export function clearAppDelegations(
  cp: DelegationsControlPlane,
  input: { hostScopeId: ScopeId; issuerScopeId: ScopeId },
): Promise<void> {
  return deliverAppDelegations(cp, { ...input, grants: [] });
}

/**
 * The declaration of an app's RUNNING version: the version it is bound to, else the one `prod`
 * serves, as the Model tab resolves it. `null` when there is no running version or its stored
 * manifest does not say. Reads are shared across one pass, per vertical and per version.
 */
export function runningDelegationsReader(
  cp: Pick<TenantNarrowedControlPlane, 'boundVersionId' | 'listChannels' | 'versionDelegations'>,
): (app: DashboardAppRow) => Promise<ManifestDelegation[] | null> {
  const prodOf = new Map<string, Promise<string | null>>();
  const declaredOf = new Map<string, Promise<ManifestDelegation[] | null>>();
  return async (app) => {
    // Strict: a failed read must not be taken for "follows prod".
    const bound = await cp.boundVersionId(scopeIdSchema.parse(app.app_scope_id), { strict: true });
    const slug = app.vertical_slug;
    let prod = prodOf.get(slug);
    if (!prod) {
      prod = cp.listChannels(slug).then((chs) => chs.find((ch) => ch.channel === 'prod')?.versionId ?? null);
      prodOf.set(slug, prod);
    }
    const running = bound ?? (await prod);
    if (!running) return null;
    const key = `${slug}@${running}`;
    let declared = declaredOf.get(key);
    if (!declared) {
      declared = cp.versionDelegations(slug, running);
      declaredOf.set(key, declared);
    }
    return declared;
  };
}

/** One host's outcome in a pass, for a caller that logs it and a test that pins it. */
export interface DelegationsOutcome {
  hostScopeId: string;
  /** The team auth-server it signs in at, or null for none of them. */
  issuerScopeId: string | null;
  /** Null when its running version's declaration is not known: nothing was delivered. */
  grants: DelegationGrant[] | null;
  skipped: DelegationSkip[];
  /** It declares delegations, but signs in at no team auth-server, so it was granted none. */
  noTeamIssuer: boolean;
  /** Its declaration could not be read; nothing was delivered. */
  readFailed: string | null;
  /** Issuers the set (its own) or `""` (every other) landed at. */
  delivered: string[];
  failed: Array<{ issuerScopeId: string; reason: string }>;
}

export interface DelegationsReconcile {
  /** Non-empty when the pass delivered nothing, because these could not be read. */
  unreadable: string[];
  outcomes: DelegationsOutcome[];
}

/** Did a pass deliver everything it meant to? One that did not must run again. */
export function delegationsConverged(result: DelegationsReconcile): boolean {
  return result.unreadable.length === 0 && result.outcomes.every((o) => o.readFailed === null && o.failed.length === 0);
}

/**
 * The Apps list's gate for the pass, per team per isolate, like the places gate: again when the
 * first page changed, and every few minutes otherwise, which is how a version promoted outside
 * the dashboard reaches the issuer. A pass delivers every set again: a memo of what was sent
 * would be this isolate's alone, and another isolate's delivery could leave it wrong.
 */
export const delegationsReconcile = new PlacesReconcileGate<DelegationsReconcile>(
  PLACES_RECONCILE_EVERY_MS,
  Date.now,
  delegationsConverged,
);

const reasonOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Converge every app of a team onto its grants: the running version's set at the team
 * auth-server it signs in at, and `""` at every other team auth-server. An app whose
 * declaration is not known is left alone everywhere. Each delivery settles on its own.
 *
 * Nothing is delivered when any auth-server's origins or any app's stored identity cannot be
 * read: an app would then read as signing in elsewhere, and a grant it holds would be revoked
 * by a failed read rather than by a change.
 */
export async function reconcileDelegations(deps: {
  apps: readonly DashboardAppRow[];
  isIssuer: (app: DashboardAppRow) => boolean;
  /** The issuer the app's stored `substrat:auth` names, or null for none. */
  issuerOf: (appScopeId: string) => Promise<string | null>;
  declaredOf: (app: DashboardAppRow) => Promise<ManifestDelegation[] | null>;
  /** The tenant's directory slug, so a pinned `<slug>/<vertical>` install answers its bare name. */
  tenantSlug: string | null;
  controlPlane: Pick<TenantNarrowedControlPlane, 'listHostnames' | 'configureInstance'>;
}): Promise<DelegationsReconcile> {
  const { issuers, unresolved } = await discoverTeamIssuers(deps.apps, deps.isIssuer, deps.controlPlane);
  if (unresolved.length > 0) return { unreadable: unresolved, outcomes: [] };
  const hosts = deps.apps.filter((a) => a.status === 'active' && !deps.isIssuer(a));
  const issuerOfApp = new Map<string, string | null>();
  const unreadable: string[] = [];
  await Promise.all(
    hosts.map(async (a) => {
      try {
        issuerOfApp.set(a.app_scope_id, issuerFor(await deps.issuerOf(a.app_scope_id), issuers)?.scopeId ?? null);
      } catch {
        unreadable.push(a.app_scope_id);
      }
    }),
  );
  if (unreadable.length > 0) return { unreadable: unreadable.sort(), outcomes: [] };

  const outcomes = await Promise.all(
    hosts.map(async (app): Promise<DelegationsOutcome> => {
      const hostScopeId = scopeIdSchema.parse(app.app_scope_id);
      const issuerScopeId = issuerOfApp.get(app.app_scope_id) ?? null;
      const outcome: DelegationsOutcome = {
        hostScopeId,
        issuerScopeId,
        grants: null,
        skipped: [],
        noTeamIssuer: false,
        readFailed: null,
        delivered: [],
        failed: [],
      };
      let declared: ManifestDelegation[] | null;
      try {
        declared = await deps.declaredOf(app);
      } catch (e) {
        outcome.readFailed = reasonOf(e);
        return outcome;
      }
      if (declared === null) return outcome;
      const computed = issuerScopeId
        ? delegationGrantsFor({ declared, hostIssuerScopeId: issuerScopeId, apps: deps.apps, tenantSlug: deps.tenantSlug, issuerOfApp })
        : { grants: [], skipped: [] };
      outcome.grants = computed.grants;
      outcome.skipped = computed.skipped;
      outcome.noTeamIssuer = !issuerScopeId && declared.length > 0;
      await Promise.all(
        issuers.map(async (i) => {
          try {
            await deliverAppDelegations(deps.controlPlane, {
              hostScopeId,
              issuerScopeId: i.scopeId,
              grants: i.scopeId === issuerScopeId ? computed.grants : [],
            });
            outcome.delivered.push(i.scopeId);
          } catch (e) {
            outcome.failed.push({ issuerScopeId: i.scopeId, reason: reasonOf(e) });
          }
        }),
      );
      return outcome;
    }),
  );
  return { unreadable: [], outcomes };
}

/** Skip lines already logged in this isolate: a declaration does not change between passes. */
const loggedSkips = new Set<string>();

/**
 * Log what a pass left undone (every time: it is retried) and every declared actor it could
 * not resolve (once per isolate: it is a fact about the team, not a fault). Returns the
 * unsettled outcomes.
 */
export function logDelegations(
  tenantId: string,
  result: DelegationsReconcile,
  log: (message: string, detail: string) => void = console.error,
  seen: Set<string> = loggedSkips,
): DelegationsOutcome[] {
  for (const o of result.outcomes) {
    if (o.noTeamIssuer) {
      const key = `${tenantId}|${o.hostScopeId}|no-team-issuer`;
      if (!seen.has(key)) {
        seen.add(key);
        log(
          'dashboard: delegations not delivered: the app does not sign in at a team auth-server',
          JSON.stringify({ tenant: tenantId, host: o.hostScopeId }),
        );
      }
    }
    for (const s of o.skipped) {
      const detail = JSON.stringify({ tenant: tenantId, host: o.hostScopeId, ...s });
      if (seen.has(detail)) continue;
      seen.add(detail);
      log('dashboard: delegation actor skipped', detail);
    }
  }
  const unsettled = result.outcomes.filter((o) => o.readFailed !== null || o.failed.length > 0);
  if (result.unreadable.length > 0 || unsettled.length > 0) {
    log(
      'dashboard: delegation reconcile left deliveries undone',
      JSON.stringify({ tenant: tenantId, unreadable: result.unreadable, unsettled }),
    );
  }
  return unsettled;
}
