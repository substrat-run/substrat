import {
  definePermissions,
  orgId as orgIdSchema,
  platformActorId,
  scopeId as scopeIdSchema,
  type PermissionKey,
  type PlatformActorId,
  type PrincipalId,
  type RoleDefinition,
  type ScopeDump,
  type ScopeDumpTable,
  type ScopeId,
  type TenantId,
} from '@substrat-run/contracts';
import { ulid, type ScopeHost } from '@substrat-run/kernel';
import { invitesModule } from '@substrat-run/engine-invites';
import { MEMBER_ROLES, dashboardModule, type DashboardAppRow } from './module.js';
import { ControlPlaneError, TenantNarrowedControlPlane, type DnsRecordRow, type SnapshotRecord } from './authority.js';
import { authConfigFor, type AppAuthChoice, type RegisterOidcClientFn } from './auth-wiring.js';

/** This vertical's slug and the DO/entitlement key it registers under. */
export const VERTICAL = 'dashboard';

/**
 * The dashboard vertical composes the invites engine (star topology, never a fork):
 * team invitations are the engine's hashed, accept-required state machine, driven by
 * the dashboard's own member operations. Both modules run in the dashboard scope.
 */
export const MODULES = [dashboardModule, invitesModule];

/**
 * The team roles, rendered from `MEMBER_ROLES` (module.ts) so the checkpoint artifact
 * (PERMISSIONS.md) and the runtime `assignRole` set agree by construction. `owner` is
 * the un-removable first member; `admin` manages the team; `member` runs apps; `viewer`
 * is read-only. The invite flow enforces the §5.1 "assign only what you hold" bound.
 */
export const ROLES: RoleDefinition[] = Object.entries(MEMBER_ROLES).map(([key, permissions]) => ({
  key,
  permissions: permissions as PermissionKey[],
  source: 'vertical',
}));

/**
 * The single typed source for this vertical's permission surface — what the permission
 * checkpoint and `substrat push` read (discovered via `package.json` `substrat.permissions`).
 * No entity-narrowed grants: dashboard authority is role-based (team roles at the tenant node).
 */
export const permissions = definePermissions({ modules: MODULES, roles: ROLES });

/**
 * Bring an already-provisioned tenant's role definitions up to date with the current
 * `ROLES`. Role permission sets are written to the directory at provisioning time, so
 * when a permission is later ADDED to a role in code (e.g. `dashboard:manage-integrations`),
 * existing tenants keep the old set and their owners silently lack the new key. `defineRole`
 * is an upsert and permission checks resolve principal→role→stored-permissions, so
 * re-defining a drifted role grants the new key to every current holder at once. Gated on
 * drift: it writes at most once per tenant after a `ROLES` change, and is a pure read
 * thereafter — cheap enough to run on the resolve path so every tenant self-heals on its
 * next request, with no migration or manual backfill.
 */
export async function reconcileRoles(host: ScopeHost, staff: PlatformActorId, tenantId: TenantId): Promise<void> {
  const current = await host.admin.listRoles(staff, { tenantId });
  const have = new Map(current.map((r) => [r.key, new Set<string>(r.permissions)]));
  for (const role of ROLES) {
    const set = have.get(role.key);
    const drift = !set || set.size !== role.permissions.length || role.permissions.some((p) => !set.has(p));
    if (drift) await host.admin.defineRole(staff, tenantId, role);
  }
}

/** The customer's dashboard node + who they are — everything an app action needs, all ambient. */
export interface DashboardNode {
  tenantId: TenantId;
  scopeId: ScopeId;
  principal: PrincipalId;
}

/**
 * Teams created after this instant (ULID time prefix, 2026-07-27T00:00Z) were seeded
 * at creation (`createTeam` invokes `dashboard/init-team`), so `ensureRosterSeeded`
 * skips them on the tenant id alone — no reads. Tenant ids are ULIDs, so creation
 * time is lexically comparable.
 */
const ROSTER_EPOCH = '01KYGDY300';

/** Tenants already checked (or healed) by this isolate — one roster read per team. */
const rosterChecked = new Set<string>();

/**
 * Seed a pre-roster team's `dashboard_members` on its next resolve. Teams provisioned
 * before the roster existed (#191, 2026-07-23) have the tables (migrations ran) but
 * no rows — no owner row — so every roster-gated move (delete the organization, the
 * Members tab, invites) refuses its own owner with "permission denied". Same
 * self-heal shape as `reconcileRoles` above: run on the resolve path, gated so it is
 * a no-op everywhere except the legacy teams it exists for.
 *
 * The resolving caller becomes the owner row. That is safe because pre-roster teams
 * were single-user by construction (multi-team + invites shipped WITH the roster),
 * and `init-team` is a guarded singleton — a team that already has a `dashboard_team`
 * row is left untouched, so a roster that is empty because everyone LEFT is never
 * resurrected. Legacy teams also predate the invites composition, so the (idempotent)
 * entitlement + org are brought along — healing invites, not just deletion.
 *
 * Best-effort: a heal failure never breaks the resolve; the memo is dropped so the
 * next request retries.
 */
export async function ensureRosterSeeded(
  host: ScopeHost,
  staff: PlatformActorId,
  node: DashboardNode,
  ownerEmail: string,
): Promise<void> {
  if (node.tenantId >= ROSTER_EPOCH || rosterChecked.has(node.tenantId)) return;
  rosterChecked.add(node.tenantId);
  try {
    const scope = await host.getScope(node.principal, node.tenantId, node.scopeId);
    const members = (await scope.invoke('dashboard/list-members', {})) as unknown[];
    if (members.length > 0) return;
    await host.admin.grantEntitlement(staff, node.tenantId, 'invites');
    let org = (await host.admin.listOrgs(staff, node.tenantId))[0]?.id;
    if (!org) {
      org = orgIdSchema.parse(ulid());
      const tenant = await host.admin.getTenant(staff, node.tenantId);
      await host.admin.createOrg(staff, { id: org, tenantId: node.tenantId, slug: 'team', name: tenant?.name ?? 'team' });
    }
    await scope.invoke('dashboard/init-team', { orgId: org, ownerEmail });
  } catch {
    rosterChecked.delete(node.tenantId);
  }
}

/**
 * Bootstrap ONE customer: a tenant, a dashboard scope running this vertical, and
 * the signer as its owner. This is the one action that CANNOT be tenant-narrowed
 * — there is no tenant yet — so it stays a controlled platform action, triggered
 * by sign-up behind quotas (see docs/design/dashboard.md §4). Everything after it
 * is authorized in-scope and effected against this tenant only.
 */
export async function provisionDashboard(
  host: ScopeHost,
  input: { tenantId: TenantId; scopeId: ScopeId; owner: PrincipalId; slug: string; name: string },
): Promise<DashboardNode> {
  const staff = platformActorId.parse(ulid());
  await host.admin.createTenant(staff, { id: input.tenantId, slug: input.slug, name: input.name });
  await host.admin.grantEntitlement(staff, input.tenantId, VERTICAL);
  // The invites engine runs in this scope (team invitations); its ops resolve only
  // for a tenant holding the 'invites' entitlement (default-deny), so grant it too.
  await host.admin.grantEntitlement(staff, input.tenantId, 'invites');
  await host.provisionScope(staff, {
    tenantId: input.tenantId,
    scopeId: input.scopeId,
    jurisdiction: 'global',
    vertical: VERTICAL,
  });
  await host.admin.activateScope(staff, input.tenantId, input.scopeId);
  for (const role of ROLES) await host.admin.defineRole(staff, input.tenantId, role);
  await host.admin.assignRole(staff, {
    principalId: input.owner,
    roleKey: 'owner',
    node: { tenantId: input.tenantId, scopeId: null },
  });
  return { tenantId: input.tenantId, scopeId: input.scopeId, principal: input.owner };
}

/**
 * Create an app — provision a new scope running `verticalSlug` **in the caller's
 * own tenant**. This is the load-bearing claim of the whole design cashed out:
 *
 * - **Authorize in-scope.** `dashboard/provision-app` runs first, and its first
 *   line is `assertAllowed(ctx.check('dashboard:provision-app'))`. The kernel
 *   decides *can they* against the caller's grants in their dashboard scope. A
 *   caller without the key is refused before anything is provisioned.
 * - **Effect tenant-narrowed.** The scope is provisioned into `node.tenantId` —
 *   the caller's OWN tenant, read from their authenticated dashboard node, **not
 *   a request argument**. There is no `tenantId` parameter a caller could set to
 *   another tenant, so cross-tenant is impossible by construction (the #97 move:
 *   authority is inherited, not re-declared).
 *
 * The `platformActorId` here effects `provisionScope` (a ScopeHost action host
 * code holds); its authority to touch THIS tenant was already decided by the
 * kernel check above, and the tenant it touches is fixed to the caller's own.
 */
export async function createApp(
  host: ScopeHost,
  input: {
    /** The caller's dashboard node — ambient, from their session. The tenant comes from HERE. */
    node: DashboardNode;
    /** The app's own scope id (minted by the caller). */
    appScopeId: ScopeId;
    /** Which vertical the app runs (catalog slug). */
    verticalSlug: string;
    name: string;
    /**
     * The SKU flags the app's modules load under (default-deny, §4.3). A single-engine
     * app has one; a composed vertical like Callout needs one per engine it runs.
     * Defaults to `[verticalSlug]`.
     */
    appEntitlements?: string[];
    /** Permissions to grant the owner INSIDE the new app scope, so they can use it. */
    appOwnerGrants?: PermissionKey[];
    /**
     * The tenant-app base domain the default hostname is minted under. The bound
     * hostname is `<app>-<team>.<jurisdiction>.substrat.run` (K-30 + the tenant-suffix
     * scheme); overridable for tests.
     */
    baseDomain?: string;
    /**
     * The team's human handle (slugified team name), suffixed into the default
     * hostname — `callout-sesamy.global.substrat.run` — so two teams' same-named
     * apps get distinct, legible URLs instead of first-come-first-served + a ULID
     * tail. Absent (older callers, tests) falls back to the unsuffixed scheme.
     * Existing bindings are never touched: the scheme applies to NEW apps only.
     */
    teamHandle?: string;
    /**
     * CONNECTED mode (production). When present, the app is provisioned on the
     * SHARED control plane through this tenant-narrowed seam (§4) — a directory
     * row + a real vertical instance + a hostname the router can resolve — instead
     * of into this deployment's own DOs. Absent ⇒ the M0 embedded path (tests,
     * standalone), which runs the app in this deployment and binds locally.
     */
    controlPlane?: TenantNarrowedControlPlane;
    /** Display name for the tenant when it is first registered on the shared plane. */
    tenantName?: string;
    /**
     * The install form's config entries (#426) — the vertical's declared env-spec
     * fields, filled in by the installer. Two destinations, one input: AUTHORED into
     * `dashboard_app_env` (so the Env tab shows install-time values, secrets masked)
     * and DELIVERED with provisioning (vertical-auth-detach.md §2.2) so the app
     * arrives configured atomically — e.g. an Auth Server's bootstrap ADMIN_*, an
     * issuer with an admin from its first request. Delivery is connected-mode only;
     * the embedded path has no delivery seam (modules there read authored config).
     */
    appConfig?: Array<{ key: string; value: string; secret: boolean }>;
    /**
     * The install form's Identity choice (§2.4): which issuer this app authenticates
     * against. Applied AFTER the hostname binds — the OIDC callback URL needs the app's
     * URL, and a team Auth Server registers the client against it — then delivered as
     * the `substrat:auth` entry. Absent ⇒ the vertical's builtin default. Connected
     * mode only (embedded has no delivery seam).
     */
    appAuth?: AppAuthChoice;
    /** Injected client-registration (tests); defaults to real dynamic registration. */
    registerOidcClient?: RegisterOidcClientFn;
    /** Backoff schedule for the step-3 configure retry (#391); tests pass short/empty. */
    configureRetryDelaysMs?: readonly number[];
  },
): Promise<DashboardAppRow> {
  // 1. Authorize + record, as the caller, in their own dashboard scope. This is the
  //    "can they?" half of §4 — the kernel's permission check, in the caller's scope
  //    — and it runs the same in both modes, before any effect.
  const scope = await host.getScope(input.node.principal, input.node.tenantId, input.node.scopeId);
  await scope.invoke('dashboard/provision-app', {
    appScopeId: input.appScopeId,
    verticalSlug: input.verticalSlug,
    name: input.name,
  });

  // 1.5. AUTHOR the install form's config before any platform effect (#426), so what
  //      the user typed survives even a failed install (visible on the Env tab, ready
  //      for a retry) — the whole point of the form is that these values never exist
  //      only in one in-flight request.
  if (input.appConfig?.length) {
    await scope.invoke('dashboard/set-app-env', { appScopeId: input.appScopeId, entries: input.appConfig });
  }

  // 2. Effect the app scope IN THE CALLER'S OWN TENANT (node.tenantId, ambient —
  //    never a request argument). Connected: on the shared plane, tenant-narrowed.
  //    Embedded: in this deployment's own host. On failure (the vertical refused, a
  //    hostname wouldn't bind, …) mark the row `failed` so it doesn't sit silently at
  //    `provisioning`, then re-throw the original error (the caller surfaces it).
  const step = installStepRecorder(scope, input.appScopeId);
  let provisioned: ProvisionOutcome;
  try {
    provisioned = input.controlPlane
      ? await provisionOnSharedPlane(input.controlPlane, input, step)
      : await provisionEmbedded(host, input, step);
  } catch (e) {
    // Record WHY on the app's audit trail (e.g. "no deployment is bound for vertical 'meridian'"),
    // not just the toast — so the failure is visible on the app's Activity panel afterward.
    const reason = e instanceof Error ? e.message : String(e);
    await scope.invoke('dashboard/mark-app-failed', { appScopeId: input.appScopeId, reason }).catch(() => {});
    throw e;
  }

  // 3. Wire the chosen IDENTITY (vertical-auth-detach.md §2.4) — after the hostname
  //    bound (the callback URL derives from it), before the row goes active. A failure
  //    here is a real failure, not a degraded install: the user asked for THIS issuer,
  //    and an app that silently fell back to builtin would strand its users later.
  if (input.appAuth && input.controlPlane) {
    let config: Record<string, string> | undefined;
    try {
      // The friendly reason is thrown INSIDE the step so the recorded failure and the
      // surfaced error are the same text (identityFailureReason names the fix, not
      // just the status line).
      await step('identity', async () => {
        try {
          if (!provisioned.hostname) {
            throw new Error('no hostname could be bound, so the OIDC callback URL cannot be formed');
          }
          config = await authConfigFor(input.appAuth!, {
            appName: input.name,
            redirectUri: `https://${provisioned.hostname}/api/auth/callback`,
            ...(input.registerOidcClient ? { registerClient: input.registerOidcClient } : {}),
          });
          await deliverAuthConfig(input.controlPlane!, input.appScopeId, config, input.configureRetryDelaysMs);
        } catch (e) {
          throw new Error(identityFailureReason(e, input.verticalSlug), { cause: e });
        }
      });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      await scope.invoke('dashboard/mark-app-failed', { appScopeId: input.appScopeId, reason }).catch(() => {});
      throw e;
    }
    // Author the delivered choice in the dashboard's own store (`dashboard/get-app-auth`)
    // so the Settings tab can show and update it later — delivery alone would leave the
    // issuer invisible everywhere but inside the app's deployment.
    await scope.invoke('dashboard/set-app-auth', { appScopeId: input.appScopeId, config: config! });
  }

  // 4. Flip the account's record to active, recording the hostname if one bound and the
  //    vertical's non-secret provision result (#426) — the facts a first run needs (a
  //    minted client id, migrations applied) that previously died with the 201 body.
  return scope.invoke('dashboard/mark-app-active', {
    appScopeId: input.appScopeId,
    ...(provisioned.hostname ? { hostname: provisioned.hostname } : {}),
    ...(provisioned.provisionResult ? { provisionResult: provisioned.provisionResult } : {}),
  });
}

/**
 * The install sequence (#424), in order. Step rows are keyed by these names and
 * rendered in this order (`seq` = index). 'provision' and 'identity' only exist in
 * connected mode (they are vertical round-trips); a step that never ran has no row.
 */
export const INSTALL_STEPS = ['directory', 'provision', 'activate', 'hostname', 'identity'] as const;
export type InstallStepName = (typeof INSTALL_STEPS)[number];

/** Run `fn` as one recorded install step: running → done, or failed with the error verbatim. */
type RunInstallStep = <T>(step: InstallStepName, fn: () => Promise<T>) => Promise<T>;

/** The default when no recorder is threaded (older callers, tests): run the stage unrecorded. */
const unrecorded: RunInstallStep = (_step, fn) => fn();

/**
 * The durable step recorder (#424): wraps each stage of the install in a
 * `dashboard/record-install-step` running → done/failed transition, so the Apps view
 * renders the sequence live and a failed install names its step + the downstream error
 * VERBATIM (the diagnosis that used to die with the toast). Resume re-enters the same
 * rows — attempts bump, statuses converge — which is exactly the platform-request shape
 * (status/attempts/last_error) applied to the install. Each write is best-effort: a
 * progress write must never fail an install that would otherwise succeed. The 'failed'
 * write happens BEFORE the error propagates, so the record exists by the time the
 * caller marks the row failed.
 */
function installStepRecorder(
  scope: { invoke(op: string, input: unknown): Promise<unknown> },
  appScopeId: ScopeId,
): RunInstallStep {
  const record = (step: InstallStepName, status: 'running' | 'done' | 'failed', error?: string): Promise<unknown> =>
    scope
      .invoke('dashboard/record-install-step', {
        appScopeId,
        step,
        seq: INSTALL_STEPS.indexOf(step),
        status,
        ...(error ? { error } : {}),
      })
      .catch(() => {});
  return async (step, fn) => {
    await record(step, 'running');
    try {
      const result = await fn();
      await record(step, 'done');
      return result;
    } catch (e) {
      await record(step, 'failed', e instanceof Error ? e.message : String(e));
      throw e;
    }
  };
}

/** What the platform effect reports back: the bound hostname + the vertical's provision result. */
interface ProvisionOutcome {
  hostname: string | null;
  /** Non-secret first-run facts from the vertical's provision response (#426); connected mode only. */
  provisionResult?: Record<string, string>;
}

/**
 * A HUMAN-readable reason for a failed identity step — this string lands on the app's
 * Activity trail and in the failure toast, so it must say what happened AND what to do
 * next, not just relay the deployment's status line. The one case worth naming: a 501
 * from the app's deployment means the vertical has no `/internal/configure` route, so
 * an issuer choice can never reach it (the sesamy-crm incident, 2026-07-27).
 */
function identityFailureReason(e: unknown, verticalSlug: string): string {
  const cause = e instanceof Error ? e.message : String(e);
  if (e instanceof ControlPlaneError && e.status === 501) {
    return (
      `identity setup failed: the '${verticalSlug}' app cannot receive auth settings while running ` +
      `(its deployment answered: ${cause}). Create the app with Identity set to Builtin, ` +
      `or add /internal/configure support to the vertical and retry.`
    );
  }
  // #391: the just-provisioned deployment did not ANSWER (502 from the control plane's
  // vertical seam, or 0 = the control plane itself unreachable) — after the bounded
  // retry below already rode out the normal cold-start window. Name the transient and
  // the recovery instead of relaying a bare status line.
  if (e instanceof ControlPlaneError && (e.status === 502 || e.status === 0)) {
    return (
      `identity setup failed: the '${verticalSlug}' app's deployment did not answer (${cause}). ` +
      `A just-created app can take a moment to start — this was retried and still failed, ` +
      `so delete the failed app and install it again in a minute.`
    );
  }
  return `identity setup failed: ${cause}`;
}

/**
 * Deliver the issuer choice to the just-provisioned instance, riding out its cold start
 * (#391). The instance was born milliseconds before this call, so the first
 * `/internal/configure` can land while its script is still waking — which surfaces as a
 * 502 "vertical unreachable" from the control plane's vertical seam (or a 0, the control
 * plane itself not answering). Those are retried on a short backoff; an honest refusal
 * (501 = no live-config support, any 4xx) fails immediately — retrying a refusal only
 * delays the real message.
 */
const CONFIGURE_RETRY_DELAYS_MS: readonly number[] = [750, 2500];

async function deliverAuthConfig(
  cp: TenantNarrowedControlPlane,
  appScopeId: ScopeId,
  config: Record<string, string>,
  delays: readonly number[] = CONFIGURE_RETRY_DELAYS_MS,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await cp.configureInstance(appScopeId, [{ key: 'substrat:auth', value: JSON.stringify(config) }]);
      return;
    } catch (e) {
      const transient = e instanceof ControlPlaneError && (e.status === 0 || (e.status >= 500 && e.status !== 501));
      const delay = delays[attempt];
      if (!transient || delay === undefined) throw e;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

type CreateAppInput = Parameters<typeof createApp>[1];

/**
 * Delete an app: authorize + soft-delete the account's record, then take its scope
 * offline (the mirror of createApp). ARCHIVE — the terminal delete state: the record is
 * retained (audit history) but the scope releases its slug so the name can be reused,
 * and the hostname goes to `failed` so the router stops resolving it. Connected: on the
 * shared plane, tenant-narrowed. Embedded: this host.
 */
export async function deprovisionApp(
  host: ScopeHost,
  input: {
    node: DashboardNode;
    appScopeId: ScopeId;
    hostname: string | null;
    controlPlane?: TenantNarrowedControlPlane;
  },
): Promise<void> {
  // 1. Authorize + record, in the caller's own dashboard scope — the "can they?" half,
  //    exactly as createApp does, before any platform effect.
  const scope = await host.getScope(input.node.principal, input.node.tenantId, input.node.scopeId);
  await scope.invoke('dashboard/delete-app', { appScopeId: input.appScopeId });

  // 2. Take the app scope offline in the caller's own tenant (ambient, never a request arg).
  if (input.controlPlane) {
    await input.controlPlane.archiveScope(input.appScopeId);
    if (input.hostname) await input.controlPlane.setHostnameStatus(input.hostname, 'failed', 'app deleted');
  } else {
    const staff = platformActorId.parse(ulid());
    await host.admin.archiveScope(staff, input.node.tenantId, input.appScopeId);
    if (input.hostname) await host.admin.setHostnameStatus(staff, input.hostname, 'failed');
  }
}

/**
 * Retry a FAILED app: best-effort tear down the failed attempt, then re-provision
 * fresh under a NEW scope with the same vertical + name. Composing the proven
 * `deprovisionApp` + `createApp` (rather than re-running a half-finished sequence in
 * place) keeps retry robust against partial state — a first attempt can leave the
 * directory scope created but the vertical instance missing, which a naive re-run
 * would trip over. A retry that still can't come up marks the fresh row `failed` and
 * surfaces the real error, exactly like the first create. The deprovision is
 * best-effort: the app already failed, so anything that won't tear down is harmless.
 */
export async function retryApp(
  host: ScopeHost,
  input: {
    node: DashboardNode;
    /** The failed app's current scope + hostname, to release before the fresh attempt. */
    failedScopeId: ScopeId;
    hostname: string | null;
    /** The scope id the fresh attempt provisions under (minted by the caller). */
    newScopeId: ScopeId;
    verticalSlug: string;
    name: string;
    appEntitlements?: string[];
    appOwnerGrants?: PermissionKey[];
    controlPlane?: TenantNarrowedControlPlane;
    tenantName?: string;
  },
): Promise<DashboardAppRow> {
  await deprovisionApp(host, {
    node: input.node,
    appScopeId: input.failedScopeId,
    hostname: input.hostname,
    controlPlane: input.controlPlane,
  }).catch(() => {});
  return createApp(host, {
    node: input.node,
    appScopeId: input.newScopeId,
    verticalSlug: input.verticalSlug,
    name: input.name,
    appEntitlements: input.appEntitlements,
    appOwnerGrants: input.appOwnerGrants,
    controlPlane: input.controlPlane,
    tenantName: input.tenantName,
  });
}

/**
 * Resume an app STUCK at `provisioning` (#424 case 4): the worker died — or the browser
 * closed — somewhere between the platform effect and `mark-app-active`, leaving a row
 * that renders as an eternal spinner while the install may be anywhere from half-made to
 * fully serving. Unlike `retryApp` (a FAILED row: tear down, fresh scope), this re-runs
 * the install tail IN PLACE against the SAME scope — every step is idempotent by design
 * (ensureTenant/provisionScope upsert, provisionInstance converges at the far end (K-31),
 * activateScope re-asserts, bindHostname re-binds its own scope) — so however far the
 * first attempt got, this converges to `active` or surfaces the real blocker and marks
 * the row `failed` (which unlocks Retry). The identity step is deliberately NOT re-run:
 * if the original install delivered an issuer choice it persists in the vertical, and if
 * it never got there the app runs the builtin default the user can change in Settings —
 * resuming cannot re-derive a choice that was never recorded.
 */
export async function resumeApp(
  host: ScopeHost,
  input: {
    node: DashboardNode;
    /** The stuck app's scope — resumed in place, never re-minted. */
    appScopeId: ScopeId;
    verticalSlug: string;
    name: string;
    appEntitlements?: string[];
    appOwnerGrants?: PermissionKey[];
    baseDomain?: string;
    teamHandle?: string;
    controlPlane?: TenantNarrowedControlPlane;
    tenantName?: string;
  },
): Promise<DashboardAppRow> {
  // Authorize + record + guard (only a `provisioning` row resumes), in the caller's own
  // dashboard scope — the same check-then-effect split as createApp step 1.
  const scope = await host.getScope(input.node.principal, input.node.tenantId, input.node.scopeId);
  await scope.invoke('dashboard/resume-app', { appScopeId: input.appScopeId });

  // Resume re-enters the SAME step rows: each re-run step goes back to 'running' with
  // attempts += 1, so a healed install reads `…provision ✓ (2 attempts) → activate ✓`.
  const step = installStepRecorder(scope, input.appScopeId);
  let provisioned: ProvisionOutcome;
  try {
    provisioned = input.controlPlane
      ? await provisionOnSharedPlane(input.controlPlane, input, step)
      : await provisionEmbedded(host, input, step);
  } catch (e) {
    // A resume that still can't come up is a REAL failure: mark it so (unlocking Retry)
    // and record why on the Activity trail, exactly like a failed create.
    const reason = e instanceof Error ? e.message : String(e);
    await scope.invoke('dashboard/mark-app-failed', { appScopeId: input.appScopeId, reason }).catch(() => {});
    throw e;
  }

  return scope.invoke('dashboard/mark-app-active', {
    appScopeId: input.appScopeId,
    ...(provisioned.hostname ? { hostname: provisioned.hostname } : {}),
    ...(provisioned.provisionResult ? { provisionResult: provisioned.provisionResult } : {}),
  });
}

/** The outcome of an update: whether it moved, and the version labels either side. */
export interface UpdateAppResult {
  /** False when the app was already on the prod version (no rebind, no event). */
  updated: boolean;
  /** The version label the app runs after this call, e.g. "0.0.12" (null if unlabelled). */
  version: string | null;
  /** The version label it ran before, e.g. "0.0.9" (null if it had none/unknown). */
  previousVersion: string | null;
}

/**
 * Move an installed app to its vertical's current prod version — the missing half of
 * promotion. Promoting a channel (`promoteVersion`) moves the *vertical's* pointer; it
 * does NOT touch scopes already provisioned, which stay pinned to the version they got
 * at install time (provision.ts pins `prod`-at-the-time). So an app installed when prod
 * was 0.0.9 keeps serving 0.0.9 even after prod moves to 0.0.12 — this is what rebinds it.
 *
 * Mirrors createApp's shape: authorize + record in the caller's own dashboard scope
 * (gated on their `provision-app` grant), then effect the rebind tenant-narrowed
 * (connected: shared plane; embedded: this host). A no-op — and silent — when the app is
 * already current.
 */
export async function updateApp(
  host: ScopeHost,
  input: {
    node: DashboardNode;
    appScopeId: ScopeId;
    verticalSlug: string;
    /** Fork-before-promote (§4): snapshot pre-migration data before the rebind. */
    snapshot?: boolean;
    controlPlane?: TenantNarrowedControlPlane;
  },
): Promise<UpdateAppResult> {
  const scope = await host.getScope(input.node.principal, input.node.tenantId, input.node.scopeId);

  // Resolve the vertical's current prod version and the scope's currently-bound one,
  // plus the version labels (id → "0.0.12") for a readable audit line.
  let prodVersionId: string | undefined;
  let boundVersionId: string | null;
  let versions: Array<{ id: string; version: string }>;
  if (input.controlPlane) {
    const cp = input.controlPlane;
    prodVersionId = (await cp.listChannels(input.verticalSlug)).find((ch) => ch.channel === 'prod')?.versionId;
    boundVersionId = await cp.boundVersionId(input.appScopeId);
    versions = await cp.listVersions(input.verticalSlug);
  } else {
    const staff = platformActorId.parse(ulid());
    prodVersionId = (await host.admin.listChannels(staff, input.verticalSlug)).find((ch) => ch.channel === 'prod')?.versionId;
    boundVersionId = (await host.admin.getScopeRecord(staff, input.node.tenantId, input.appScopeId))?.verticalVersionId ?? null;
    versions = await host.admin.listVersions(staff, input.verticalSlug);
  }
  const label = (id: string | null | undefined): string | null =>
    (id ? versions.find((v) => v.id === id)?.version ?? null : null);

  if (!prodVersionId) throw new Error(`vertical '${input.verticalSlug}' has no prod version to update to`);
  const toLabel = label(prodVersionId);
  const fromLabel = label(boundVersionId);
  // Already current — nothing to rebind, and nothing worth an Activity entry.
  if (prodVersionId === boundVersionId) return { updated: false, version: toLabel, previousVersion: fromLabel };

  // Authorize in-scope + record the move (the assert gates the effect below), then
  // rebind the scope so the router dispatches on the new version's deploymentRef.
  // `snapshot` is fork-before-promote (preview-and-snapshots.md §4): the platform
  // snapshots the pre-migration data first when the rebind crosses a migration
  // digest — and does nothing extra on a code-only update.
  await scope.invoke('dashboard/update-app', {
    appScopeId: input.appScopeId,
    detail: `${fromLabel ?? '—'} → ${toLabel ?? prodVersionId}${input.snapshot ? ' (snapshot first)' : ''}`,
  });
  if (input.controlPlane) {
    await input.controlPlane.bindScopeVersion(input.appScopeId, prodVersionId, {
      snapshot: input.snapshot,
    });
  } else {
    const staff = platformActorId.parse(ulid());
    await host.admin.bindScopeVersion(staff, input.node.tenantId, input.appScopeId, prodVersionId, {
      snapshot: input.snapshot,
    });
  }

  // The new version may DECLARE a surface the app didn't have before (surfaces evolve
  // additively). Bind a URL for any newly-declared surface now, so "add a surface in a PR,
  // push" gives it a public URL on update with no manual bind. Best-effort: the version has
  // already moved, and a missing surface URL must never fail the update itself.
  const apps = (await scope.invoke('dashboard/list-apps', {})) as DashboardAppRow[];
  const appHostname = await resolveDefaultHostname(host, {
    node: input.node,
    appScopeId: input.appScopeId,
    stored: apps.find((a) => a.app_scope_id === input.appScopeId)?.hostname ?? null,
    ...(input.controlPlane ? { controlPlane: input.controlPlane } : {}),
  });
  await reconcileSurfaceHostnames(host, {
    node: input.node,
    appScopeId: input.appScopeId,
    verticalSlug: input.verticalSlug,
    appHostname,
    ...(input.controlPlane ? { controlPlane: input.controlPlane } : {}),
  }).catch(() => {});

  return { updated: true, version: toLabel, previousVersion: fromLabel };
}

/**
 * Snapshot an app's data into an archive fork (preview-and-snapshots.md §3) — the
 * Snapshots tab's "Create test copy". Authorize in the caller's own dashboard scope
 * (same authority as managing the app), then effect tenant-narrowed: the CP
 * orchestrates the fork inside the app's own vertical deployment (connected), or the
 * host forks in-process (embedded). `ttlDays` opts into the GC sweep; omitted =
 * pinned until deleted.
 */
export async function snapshotApp(
  host: ScopeHost,
  input: {
    node: DashboardNode;
    appScopeId: ScopeId;
    ttlDays?: number;
    /** The app's bound hostname — the preview URL is derived from its first label. */
    appHostname?: string | null;
    controlPlane?: TenantNarrowedControlPlane;
  },
): Promise<{ id: string; expiresAt: string | null; url: string | null }> {
  const scope = await host.getScope(input.node.principal, input.node.tenantId, input.node.scopeId);
  const expiresAt =
    input.ttlDays && input.ttlDays > 0
      ? new Date(Date.now() + input.ttlDays * 86_400_000).toISOString()
      : undefined;
  await scope.invoke('dashboard/snapshot-app', {
    appScopeId: input.appScopeId,
    detail: expiresAt ? `test copy, expires ${expiresAt.slice(0, 10)}` : 'test copy, kept until deleted',
  });
  let snapId: ScopeId;
  if (input.controlPlane) {
    const created = await input.controlPlane.snapshotScope(input.appScopeId, { expiresAt });
    snapId = scopeIdSchema.parse(created.id);
  } else {
    const staff = platformActorId.parse(ulid());
    snapId = await host.snapshotScope(staff, input.node.tenantId, input.appScopeId, { expiresAt });
  }
  const url = await bindSnapshotHostname(host, input, snapId);
  return { id: snapId, expiresAt: expiresAt ?? null, url };
}

/**
 * Bind the copy's preview hostname: the app's own label plus a `--s<tail>` tag —
 * `callout--s1a2b.global.substrat.run`. `--` is reserved by construction (slugify
 * collapses runs), so a preview can never be mistaken for (or squat) an app's name.
 * The fork's directory row is what the router resolves, so the URL serves the COPY,
 * in the same deployment that holds its bytes; deleting/reaping the copy removes the
 * binding with the row. Best-effort: a copy with no URL is still a valid copy.
 *
 * The served copy sits behind the app's own sign-in (the fork carries the source's
 * users as of the fork). Tighter, dashboard-session gating for preview URLs is a
 * stated follow-up (preview-and-snapshots.md §6).
 */
async function bindSnapshotHostname(
  host: ScopeHost,
  input: { node: DashboardNode; appHostname?: string | null; controlPlane?: TenantNarrowedControlPlane },
  snapId: ScopeId,
): Promise<string | null> {
  if (!input.appHostname || !input.appHostname.includes('.')) return null;
  const [label, ...rest] = input.appHostname.split('.');
  const hostname = `${label}--s${snapId.toLowerCase().slice(-4)}.${rest.join('.')}`;
  try {
    if (input.controlPlane) {
      await input.controlPlane.bindHostname({ hostname, scopeId: snapId, surface: 'app', canonical: true });
      await input.controlPlane.setHostnameStatus(hostname, 'active');
    } else {
      const staff = platformActorId.parse(ulid());
      await host.admin.bindHostname(staff, {
        hostname,
        tenantId: input.node.tenantId,
        scopeId: snapId,
        surface: 'app',
        region: null,
        canonical: true,
      });
      await host.admin.setHostnameStatus(staff, hostname, 'active');
    }
    return hostname;
  } catch {
    return null; // collision or transient — the copy stands without a URL
  }
}

/** The forks of one app, newest first — the Snapshots tab's list. */
export async function listAppSnapshots(
  host: ScopeHost,
  input: { node: DashboardNode; appScopeId: ScopeId; controlPlane?: TenantNarrowedControlPlane },
): Promise<SnapshotRecord[]> {
  let records: SnapshotRecord[];
  if (input.controlPlane) {
    records = await input.controlPlane.listSnapshots(input.appScopeId);
  } else {
    const staff = platformActorId.parse(ulid());
    const scopes = await host.admin.listScopes(staff, { tenantId: input.node.tenantId });
    records = scopes
      .filter((s) => s.forkedFrom === input.appScopeId)
      .sort((a, b) => ((a.forkedAt ?? '') < (b.forkedAt ?? '') ? 1 : -1))
      .map((s) => ({
        id: s.id,
        kind: s.kind,
        forkedFrom: s.forkedFrom,
        forkedAt: s.forkedAt,
        expiresAt: s.expiresAt,
        verticalVersionId: s.verticalVersionId,
        createdAt: s.createdAt,
      }));
  }
  // Join each copy's preview URL (active binding on the fork scope). Best-effort —
  // a copy without one just renders URL-less.
  const staff = platformActorId.parse(ulid());
  return Promise.all(
    records.map(async (r) => {
      try {
        const hosts = input.controlPlane
          ? await input.controlPlane.listHostnames(scopeIdSchema.parse(r.id))
          : await host.admin.listHostnames(staff, { scopeId: scopeIdSchema.parse(r.id) });
        const active = hosts.find((h) => h.status === 'active');
        return { ...r, url: active?.hostname ?? null };
      } catch {
        return { ...r, url: null };
      }
    }),
  );
}

/** Delete one snapshot of an app. The platform refuses anything that is not a fork. */
export async function deleteAppSnapshot(
  host: ScopeHost,
  input: {
    node: DashboardNode;
    appScopeId: ScopeId;
    snapshotScopeId: ScopeId;
    controlPlane?: TenantNarrowedControlPlane;
  },
): Promise<void> {
  const scope = await host.getScope(input.node.principal, input.node.tenantId, input.node.scopeId);
  await scope.invoke('dashboard/delete-app-snapshot', {
    appScopeId: input.appScopeId,
    detail: input.snapshotScopeId,
  });
  if (input.controlPlane) {
    await input.controlPlane.deleteSnapshot(input.snapshotScopeId);
    return;
  }
  const staff = platformActorId.parse(ulid());
  await host.deleteSnapshot(staff, input.node.tenantId, input.snapshotScopeId);
}

/**
 * Export an app's data as a dump (preview-and-snapshots.md §8, from the dashboard) —
 * the file the CLI's `scope restore` (and the Import button below) accepts back.
 * Authorize + record in the caller's own dashboard scope, then read tenant-narrowed.
 * CONNECTED, the CP is the gate: the dump arrives MASKED (no break-glass from this
 * surface) and jurisdiction-checked, and the CP writes its own access-log entry.
 * EMBEDDED there is no trust boundary to cross — the host's files already sit on the
 * operator's own disk — so the dump is the full read, flagged `masked: false`.
 */
export async function exportAppData(
  host: ScopeHost,
  input: { node: DashboardNode; appScopeId: ScopeId; controlPlane?: TenantNarrowedControlPlane },
): Promise<ScopeDump & { masked: boolean }> {
  const scope = await host.getScope(input.node.principal, input.node.tenantId, input.node.scopeId);
  await scope.invoke('dashboard/export-app-data', {
    appScopeId: input.appScopeId,
    detail: input.controlPlane ? 'masked export' : 'full export (embedded)',
  });
  if (input.controlPlane) return input.controlPlane.exportScope(input.appScopeId);
  const staff = platformActorId.parse(ulid());
  const dump = await host.admin.exportScope(staff, input.node.tenantId, input.appScopeId);
  return { ...dump, masked: false };
}

/**
 * Load an uploaded dump into an app's existing scope, replacing its data wholesale
 * (§8's write half — how a locally-built world lands on a hosted app). The safety
 * copy comes FIRST: restore is the one dashboard action that destroys data, so the
 * pre-restore state must survive as a fork the user can back out to (its id is in
 * the returned record and on the activity trail). `snapshotApp` also carries the
 * authorization — same authority, checked before any effect.
 */
export async function restoreAppData(
  host: ScopeHost,
  input: {
    node: DashboardNode;
    appScopeId: ScopeId;
    tables: ScopeDumpTable[];
    /** The app's bound hostname — gives the safety copy a preview URL. */
    appHostname?: string | null;
    controlPlane?: TenantNarrowedControlPlane;
  },
): Promise<{ restored: ScopeId; tables: number; safetyCopyId: string }> {
  const safety = await snapshotApp(host, {
    node: input.node,
    appScopeId: input.appScopeId,
    ttlDays: RESTORE_SAFETY_TTL_DAYS,
    appHostname: input.appHostname,
    controlPlane: input.controlPlane,
  });
  const scope = await host.getScope(input.node.principal, input.node.tenantId, input.node.scopeId);
  await scope.invoke('dashboard/restore-app-data', {
    appScopeId: input.appScopeId,
    detail: `${input.tables.length} tables; safety copy ${safety.id}`,
  });
  if (input.controlPlane) {
    await input.controlPlane.restoreScope(input.appScopeId, input.tables);
  } else {
    const staff = platformActorId.parse(ulid());
    await host.restoreScope(staff, input.node.tenantId, input.appScopeId, {
      tenantId: input.node.tenantId,
      scopeId: input.appScopeId,
      capturedAt: new Date().toISOString(),
      tables: input.tables,
    });
  }
  return { restored: input.appScopeId, tables: input.tables.length, safetyCopyId: safety.id };
}

/** Long enough to notice a bad restore; short enough that safety copies self-reap. */
const RESTORE_SAFETY_TTL_DAYS = 7;

/**
 * CONNECTED mode: provision through the shared control plane, tenant-narrowed —
 * the production path (dashboard.md §6). Mirrors the operator console's proven
 * create-instance sequence (apps/console/src/lib/create-instance.ts): a directory
 * row (`provisionScope`), the vertical instance (`provisionInstance` → the vertical
 * grants entitlements + assigns the owner its role), activation, then a bound
 * default hostname the router resolves. No `bindScopeVersion`: with WfP off the
 * router dispatches on a static `VERTICAL_<slug>` binding, which needs no version.
 */
async function provisionOnSharedPlane(
  cp: TenantNarrowedControlPlane,
  input: CreateAppInput,
  step: RunInstallStep = unrecorded,
): Promise<ProvisionOutcome> {
  const nameSlug = slugify(input.name);
  const scopeTail = input.appScopeId.toLowerCase().slice(-6);
  // The SCOPE slug must be UNIQUE within the tenant. Suffixing the scope id keeps two apps
  // with the same name — or a fresh attempt after one left an orphaned scope (a failed
  // provision marks the row failed but doesn't release its shared-plane scope) — from
  // colliding on "scope slug 'x' already taken". The hostname below still prefers the clean
  // name, so the URL stays `meridian.global.substrat.run` whenever it's free.
  const slug = `${nameSlug}-${scopeTail}`;
  const tenantSlug = `t-${cp.tenantId.toLowerCase().replace(/[^a-z0-9]/g, '').slice(-10)}`;

  await step('directory', async () => {
    await cp.ensureTenant(tenantSlug, input.tenantName ?? 'Workspace');
    // Belt-and-braces: the vertical grants these too, but an idempotent grant here
    // keeps the shared directory's entitlement view complete regardless.
    for (const key of input.appEntitlements ?? [input.verticalSlug]) await cp.grantEntitlement(key);
    await cp.provisionScope({ scopeId: input.appScopeId, slug, name: input.name, vertical: input.verticalSlug, jurisdiction: 'global' });
  });

  // The install form's config rides WITH provisioning (#426): the instance is born
  // configured — an issuer with its admin, an app with its keys — instead of live-but-
  // unconfigured until a later Env-tab save. Empty values are omitted (an untouched
  // optional field is not a delivery).
  const config = Object.fromEntries(
    (input.appConfig ?? []).filter((e) => e.value !== '').map((e) => [e.key, e.value]),
  );
  // The vertical round-trip: tenant stores minted + bound and /internal/provision called
  // (control-plane side). A failure here carries the vertical's refusal VERBATIM (#428) —
  // recorded on this step, so the diagnosis survives the toast.
  const instance = await step('provision', () =>
    cp.provisionInstance(input.verticalSlug, {
      scopeId: input.appScopeId,
      owner: input.node.principal,
      slug,
      name: input.name,
      ...(Object.keys(config).length > 0 ? { config } : {}),
    }),
  );
  const provisionResult = instance?.result;

  await step('activate', async () => {
    await cp.activateScope(input.appScopeId);
    // Pin the scope to the vertical's prod version so the router dispatches on it once
    // Workers-for-Platforms is enabled (D-35). No promoted version today ⇒ this is a
    // no-op and the router serves via the static `VERTICAL_<slug>` binding. It is the
    // ONLY thing that differs between the static bring-up and dynamic dispatch, so the
    // dashboard needs NO change when WfP flips on — only the deploy mechanism does.
    const prod = (await cp.listChannels(input.verticalSlug)).find((ch) => ch.channel === 'prod');
    if (prod) await cp.bindScopeVersion(input.appScopeId, prod.versionId);
  });

  const domain = input.baseDomain ?? 'substrat.run';
  // Tenant-suffixed by preference (`callout-sesamy`), the scope-tailed slug as the
  // collision fallback; the unsuffixed ladder only for callers with no handle.
  const labels = input.teamHandle
    ? [`${nameSlug}-${input.teamHandle}`, `${slug}-${input.teamHandle}`]
    : [nameSlug, slug];
  // The vertical's DECLARED surfaces (K-26): the clean hostname fronts the primary
  // surface; every OTHER declared surface gets its own `<base>-<surface>` hostname —
  // the same mint the Domains tab uses — so a multi-surface app arrives with a URL per
  // surface, not just one. A vertical that declares none keeps the historic
  // single `app` binding, so nothing changes for the common case.
  const surfaces = await declaredSurfacesFor({ controlPlane: cp }, input.verticalSlug);
  const primary = primarySurface(surfaces);
  // An exhausted ladder records a FAILED hostname step (honest — the app has no URL)
  // but does not fail the install: the row still goes active URL-less, exactly as
  // before, and the hostname self-heal / Domains tab can repair it later.
  const bound = await step('hostname', async () => {
    for (const label of labels) {
      const hostname = `${label}.global.${domain}`;
      try {
        await cp.bindHostname({ hostname, scopeId: input.appScopeId, surface: primary, canonical: true });
      } catch {
        // Global-uniqueness collision or transient on the primary — try the next candidate.
        continue;
      }
      // The primary hostname is bound at the router now — the app is reachable, and this is
      // the value the dashboard must record. Everything below is best-effort: a failure in
      // activation or a secondary surface must NOT discard the hostname we just bound (that
      // stranded the dashboard's record — a null column — while the app ran fine).
      await cp.setHostnameStatus(hostname, 'active').catch(() => {});
      // Bind the remaining surfaces off the SAME base that won the collision ladder, so they
      // share the app's chosen label (`egeryds` → `egeryds-eka`).
      await bindDeclaredSurfaces({
        base: label,
        suffix: `global.${domain}`,
        surfaces,
        primary,
        alreadyBound: new Set(),
        bind: async (h, surface) => {
          await cp.bindHostname({ hostname: h, scopeId: input.appScopeId, surface, canonical: true });
          await cp.setHostnameStatus(h, 'active');
        },
      });
      return hostname;
    }
    throw new Error(`no hostname could be bound under global.${domain} (every name candidate was taken)`);
  }).catch(() => null);
  return { hostname: bound, ...(provisionResult ? { provisionResult } : {}) };
}

/** EMBEDDED mode (M0 / tests): provision into this deployment's own host + directory.
 *  No vertical HTTP round-trip here, so there is never a provision result to report. */
async function provisionEmbedded(
  host: ScopeHost,
  input: CreateAppInput,
  step: RunInstallStep = unrecorded,
): Promise<ProvisionOutcome> {
  const staff = platformActorId.parse(ulid());
  const tenantId = input.node.tenantId;
  await step('directory', async () => {
    for (const key of input.appEntitlements ?? [input.verticalSlug]) {
      await host.admin.grantEntitlement(staff, tenantId, key);
    }
    await host.provisionScope(staff, { tenantId, scopeId: input.appScopeId, jurisdiction: 'global', vertical: input.verticalSlug });
  });
  // No 'provision' step embedded: the modules run in-process, so there is no vertical
  // round-trip (and never a provision result). The step simply has no row.
  await step('activate', async () => {
    await host.admin.activateScope(staff, tenantId, input.appScopeId);
    for (const permission of input.appOwnerGrants ?? []) {
      await host.admin.grant(staff, {
        principalId: input.node.principal,
        permission,
        node: { tenantId, scopeId: input.appScopeId },
        grantedBy: input.node.principal,
      });
    }
  });
  // Declared surfaces ride the local registry (register-vertical → install-spec); absent
  // for an unregistered vertical (older tests) ⇒ [] ⇒ the historic single `app` binding.
  const surfaces = await declaredSurfacesFor({ host }, input.verticalSlug);
  // Same semantics as the shared-plane ladder: an unbindable hostname is a FAILED step
  // (honest), never a failed install.
  const hostname = await step('hostname', async () => {
    const bound = await bindDefaultHostname(host, {
      staff,
      tenantId,
      scopeId: input.appScopeId,
      name: input.name,
      teamHandle: input.teamHandle,
      jurisdiction: 'global',
      baseDomain: input.baseDomain ?? 'substrat.run',
      surfaces,
    });
    if (!bound) throw new Error('no hostname could be bound (every name candidate was taken)');
    return bound;
  }).catch(() => null);
  return { hostname };
}

/**
 * The surface that a scope's CLEAN default hostname fronts. A vertical that declares an
 * `app` surface keeps it there (the historic default); one that declares surfaces but no
 * `app` puts its FIRST declared surface on the clean URL; one that declares none falls
 * back to `app`. Every other declared surface is bound to its own `<base>-<surface>`
 * hostname alongside.
 */
function primarySurface(surfaces: Array<{ name: string; label: string }>): string {
  return surfaces.find((s) => s.name === 'app')?.name ?? surfaces[0]?.name ?? 'app';
}

/**
 * Bind a hostname for every DECLARED surface (K-26) other than the primary that has no
 * active binding yet — `<base>-<surface>.<suffix>` off the app's chosen label, active and
 * canonical for its surface. Idempotent (the primary and anything in `alreadyBound` are
 * skipped) and best-effort per surface (a collision on one never blocks the rest), so it is
 * safe to run at install AND on every update. `bind` carries the mode: the tenant-narrowed
 * control plane when connected, `host.admin` when embedded.
 */
async function bindDeclaredSurfaces(opts: {
  base: string;
  suffix: string;
  surfaces: Array<{ name: string; label: string }>;
  primary: string;
  alreadyBound: Set<string>;
  bind: (hostname: string, surface: string) => Promise<void>;
}): Promise<void> {
  for (const s of opts.surfaces) {
    if (s.name === opts.primary || opts.alreadyBound.has(s.name)) continue;
    try {
      await opts.bind(`${opts.base}-${s.name}.${opts.suffix}`, s.name);
    } catch {
      // Collision or transient on a secondary surface — skip it.
    }
  }
}

/**
 * The surfaces a vertical DECLARES (package.json `substrat.surfaces` → the registry). Read
 * from the shared plane's catalog when connected, else this host's local registry; `[]` when
 * the vertical declares none, isn't registered, or the lookup fails — i.e. the historic
 * single-surface default. The catalog method may be absent on a test seam, hence the guard.
 */
async function declaredSurfacesFor(
  src: { host?: ScopeHost; controlPlane?: TenantNarrowedControlPlane },
  verticalSlug: string,
): Promise<Array<{ name: string; label: string }>> {
  if (src.controlPlane) {
    if (typeof src.controlPlane.listCatalog !== 'function') return [];
    const catalog = await src.controlPlane.listCatalog().catch(() => []);
    return catalog.find((v) => v.slug === verticalSlug)?.surfaces ?? [];
  }
  if (src.host) {
    const staff = platformActorId.parse(ulid());
    return src.host.admin
      .listVerticals(staff)
      .then((vs) => vs.find((v) => v.slug === verticalSlug)?.surfaces ?? [])
      .catch(() => [] as Array<{ name: string; label: string }>);
  }
  return [];
}

/**
 * Bind a URL for every DECLARED surface of an already-installed app that lacks one — the
 * update-time half of the install-time binding in `createApp`. Surfaces evolve additively
 * (a new version can DECLARE a surface the app didn't have), so on update we mint the missing
 * `<base>-<surface>` hostnames off the app's own default hostname. Idempotent and best-effort
 * — the same self-heal shape as `reconcileRoles` — so a version that adds a surface gets its
 * URL with no manual bind, and a version that changes nothing does no work.
 *
 * The base label is the app's default (primary) hostname, passed in by the caller — never a
 * custom domain, so a surface mint can't inherit a customer's own domain label by accident.
 */
export async function reconcileSurfaceHostnames(
  host: ScopeHost,
  input: {
    node: DashboardNode;
    appScopeId: ScopeId;
    verticalSlug: string;
    /** The app's default hostname (`egeryds.global.substrat.run`) — the base for surface mints. */
    appHostname: string | null;
    controlPlane?: TenantNarrowedControlPlane;
  },
): Promise<void> {
  if (!input.appHostname || !input.appHostname.includes('.')) return;
  const surfaces = await declaredSurfacesFor({ host, controlPlane: input.controlPlane }, input.verticalSlug);
  if (surfaces.length < 2) return; // nothing beyond the primary to bind
  const existing = await listAppHostnames(host, {
    node: input.node,
    appScopeId: input.appScopeId,
    ...(input.controlPlane ? { controlPlane: input.controlPlane } : {}),
  });
  const alreadyBound = new Set(existing.filter((h) => h.status === 'active').map((h) => h.surface));
  const [base, ...rest] = input.appHostname.split('.');
  const suffix = rest.join('.');
  const bind = input.controlPlane
    ? async (hostname: string, surface: string): Promise<void> => {
        await input.controlPlane!.bindHostname({ hostname, scopeId: input.appScopeId, surface, canonical: true });
        await input.controlPlane!.setHostnameStatus(hostname, 'active');
      }
    : async (hostname: string, surface: string): Promise<void> => {
        const staff = platformActorId.parse(ulid());
        await host.admin.bindHostname(staff, {
          hostname,
          tenantId: input.node.tenantId,
          scopeId: input.appScopeId,
          surface,
          region: null,
          canonical: true,
        });
        await host.admin.setHostnameStatus(staff, hostname, 'active');
      };
  await bindDeclaredSurfaces({ base: base!, suffix, surfaces, primary: primarySurface(surfaces), alreadyBound, bind });
}

/** A URL-safe slug from an app or team name. */
export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'app'
  );
}

/**
 * Bind the scope's default hostname and mark it active, returning the bound value
 * (or null if none could be bound). `surface: 'app'` + `canonical: true` mirror the
 * console's create-instance flow; `region: null` because `global` has no regional
 * pinning. Tries the clean slug first, then a scope-tailed slug on collision.
 */
async function bindDefaultHostname(
  host: ScopeHost,
  args: { staff: PlatformActorId; tenantId: TenantId; scopeId: ScopeId; name: string; teamHandle?: string; jurisdiction: string; baseDomain: string; surfaces?: Array<{ name: string; label: string }> },
): Promise<string | null> {
  const base = slugify(args.name);
  const tail = args.scopeId.toLowerCase().slice(-4);
  // Tenant-suffixed by preference (`callout-sesamy`), scope tail as collision belt.
  const labels = args.teamHandle
    ? [`${base}-${args.teamHandle}`, `${base}-${tail}-${args.teamHandle}`]
    : [base, `${base}-${tail}`];
  const surfaces = args.surfaces ?? [];
  const primary = primarySurface(surfaces);
  for (const label of labels) {
    const hostname = `${label}.${args.jurisdiction}.${args.baseDomain}`;
    try {
      await host.admin.bindHostname(args.staff, {
        hostname,
        tenantId: args.tenantId,
        scopeId: args.scopeId,
        surface: primary,
        region: null,
        canonical: true,
      });
    } catch {
      // Collision or transient on the primary — try the next candidate.
      continue;
    }
    // The primary hostname is bound now — the app is reachable, and this is the value the
    // dashboard must record. Activation and secondary-surface binds below are best-effort:
    // a failure there must NOT discard the hostname we just bound.
    await host.admin.setHostnameStatus(args.staff, hostname, 'active').catch(() => {});
    // Every OTHER declared surface (K-26) gets its own `<base>-<surface>` hostname on the
    // same winning label.
    await bindDeclaredSurfaces({
      base: label,
      suffix: `${args.jurisdiction}.${args.baseDomain}`,
      surfaces,
      primary,
      alreadyBound: new Set(),
      bind: async (h, surface) => {
        await host.admin.bindHostname(args.staff, {
          hostname: h,
          tenantId: args.tenantId,
          scopeId: args.scopeId,
          surface,
          region: null,
          canonical: true,
        });
        await host.admin.setHostnameStatus(args.staff, h, 'active');
      },
    });
    return hostname;
  }
  return null;
}

// -- surface hostnames (the Domains tab; K-26 multi-surface) -----------------
// A scope can front more than one app — the CRM and its absorbed economy-admin
// surface share one scope, one worker, one bundle; the hostname decides which
// chrome you get (`readRoutedNode(...).surface`). The vertical's side already
// works; these helpers are the operator-facing half: give a surface a URL.

/** One binding as the Domains tab renders it. */
export interface AppHostnameRow {
  hostname: string;
  surface: string;
  status: string;
  /** Why the row is `failed` (or mid-flight detail) — the tab must render this, not just the pill. */
  statusNote: string | null;
  canonical: boolean;
  createdAt: string | null;
  /** DNS records the tenant must publish for a custom domain; empty for a platform mint. */
  validationRecords: DnsRecordRow[];
}

/** The bindings on one app's scope — default hostname, surface hostnames, custom domains. */
export async function listAppHostnames(
  host: ScopeHost,
  input: { node: DashboardNode; appScopeId: ScopeId; controlPlane?: TenantNarrowedControlPlane },
): Promise<AppHostnameRow[]> {
  let rows: AppHostnameRow[];
  if (input.controlPlane) {
    rows = (await input.controlPlane.listHostnames(input.appScopeId)).map((h) => ({
      hostname: h.hostname,
      surface: h.surface,
      status: h.status,
      statusNote: h.statusNote ?? null,
      canonical: h.canonical,
      createdAt: h.createdAt ?? null,
      validationRecords: h.validationRecords ?? [],
    }));
  } else {
    const staff = platformActorId.parse(ulid());
    rows = (await host.admin.listHostnames(staff, { scopeId: input.appScopeId })).map((h) => ({
      hostname: h.hostname,
      surface: h.surface,
      status: h.status,
      statusNote: h.statusNote ?? null,
      canonical: h.canonical,
      createdAt: h.createdAt,
      validationRecords: h.validationRecords ?? [],
    }));
  }
  return rows.sort((a, b) => (a.createdAt ?? '') < (b.createdAt ?? '') ? -1 : 1);
}

/**
 * The app's default hostname for URL derivation (the OIDC callback, etc.). Prefers the
 * dashboard's own stored column, but falls back to the LIVE bindings from the control
 * plane / host — the authoritative source the router actually serves — when the column
 * is empty. The column can be null even for a fully-reachable app (a bind that succeeded
 * at the router but whose activation step then threw, discarding the return value during
 * provisioning); reading the live bindings recovers the real hostname instead of failing
 * an operation on the dashboard's incomplete bookkeeping. Prefers the canonical, active
 * binding — provisioning binds the primary surface first, so the earliest canonical
 * binding is the app's clean default URL. Returns null only when nothing is bound.
 */
export async function resolveDefaultHostname(
  host: ScopeHost,
  input: { node: DashboardNode; appScopeId: ScopeId; stored: string | null; controlPlane?: TenantNarrowedControlPlane },
): Promise<string | null> {
  if (input.stored) return input.stored;
  const bindings = await listAppHostnames(host, {
    node: input.node,
    appScopeId: input.appScopeId,
    ...(input.controlPlane ? { controlPlane: input.controlPlane } : {}),
  }).catch(() => [] as AppHostnameRow[]);
  const best =
    bindings.find((b) => b.canonical && b.status === 'active') ??
    bindings.find((b) => b.status === 'active') ??
    bindings[0];
  return best?.hostname ?? null;
}

/**
 * Bind a hostname to one surface of an app (the Domains tab's add).
 *
 * Two forms, per the §4.2 lifecycle: a PLATFORM hostname is minted from the app's
 * own default label (`crm.global.…` + surface `eka` → `crm-eka.global.…`) and lands
 * `active` immediately — it rides the existing wildcard cert, there is no DNS dance.
 * A CUSTOM domain is recorded `pending` and walks pending → verifying → active as
 * validation and cert issuance actually happen (a later, staff/automation step) —
 * never marked active by wishing.
 *
 * The binding is canonical only when its (scope, surface) has no binding yet: adding
 * an alias never silently demotes the URL a surface already serves on (the demotion
 * rule stays an explicit choice, surfaced by the UI, not a side effect of adding).
 */
export async function addAppHostname(
  host: ScopeHost,
  input: {
    node: DashboardNode;
    appScopeId: ScopeId;
    surface: string;
    /** A custom domain to bind (else a platform hostname is minted for the surface). */
    customDomain?: string;
    /** The app's default hostname — the label source for a platform mint. */
    appHostname?: string | null;
    controlPlane?: TenantNarrowedControlPlane;
  },
): Promise<AppHostnameRow> {
  const surface = input.surface.trim();
  if (!surface || surface.length > 32) throw new Error(`invalid surface name '${input.surface}'`);
  const existing = await listAppHostnames(host, input);
  const canonical = !existing.some((h) => h.surface === surface);

  const scope = await host.getScope(input.node.principal, input.node.tenantId, input.node.scopeId);
  const bind = async (hostname: string, active: boolean): Promise<AppHostnameRow> => {
    if (input.controlPlane) {
      // The CP bind runs issuance inline and returns the post-issuance row — a custom
      // domain comes back `verifying` with DNS records, or `failed` with the reason.
      // Return that instead of a wishful synthesized `pending`.
      const row = await input.controlPlane.bindHostname({ hostname, scopeId: input.appScopeId, surface, canonical });
      if (active) await input.controlPlane.setHostnameStatus(hostname, 'active');
      return {
        hostname,
        surface,
        status: active ? 'active' : row.status,
        statusNote: row.statusNote ?? null,
        canonical,
        createdAt: row.createdAt ?? null,
        validationRecords: row.validationRecords ?? [],
      };
    }
    const staff = platformActorId.parse(ulid());
    await host.admin.bindHostname(staff, {
      hostname,
      tenantId: input.node.tenantId,
      scopeId: input.appScopeId,
      surface,
      region: null,
      canonical,
    });
    if (active) await host.admin.setHostnameStatus(staff, hostname, 'active');
    return {
      hostname,
      surface,
      status: active ? 'active' : 'pending',
      statusNote: null,
      canonical,
      createdAt: null,
      validationRecords: [],
    };
  };

  if (input.customDomain) {
    const hostname = input.customDomain.trim().toLowerCase();
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(hostname)) {
      throw new Error(`'${input.customDomain}' is not a valid domain name`);
    }
    // Platform names are minted from the app's own label, never typed in — a free-text
    // path onto *.substrat.run would be a squatting vector for other tenants' labels.
    const platformBase = (input.appHostname ?? '').split('.').slice(1).join('.');
    if (hostname.endsWith('.substrat.run') || (platformBase && hostname.endsWith(`.${platformBase}`))) {
      throw new Error(`'${hostname}' is a platform name — add it as a platform hostname for the surface instead`);
    }
    await scope.invoke('dashboard/bind-app-hostname', {
      appScopeId: input.appScopeId,
      detail: `${hostname} (surface '${surface}')`,
    });
    return await bind(hostname, false);
  }

  // Platform mint. The app's default label carries the tenant suffix already
  // (`crm-sesamy`), so the surface rides between label and domain; the scope tail is
  // the collision belt, same ladder as the default hostname's.
  if (!input.appHostname || !input.appHostname.includes('.')) {
    throw new Error('the app has no platform hostname to derive a surface hostname from');
  }
  const [label, ...rest] = input.appHostname.toLowerCase().split('.');
  const surfaceLabel = slugify(surface);
  const tail = input.appScopeId.toLowerCase().slice(-4);
  const candidates = [`${label}-${surfaceLabel}`, `${label}-${surfaceLabel}-${tail}`].map(
    (l) => `${l}.${rest.join('.')}`,
  );
  await scope.invoke('dashboard/bind-app-hostname', {
    appScopeId: input.appScopeId,
    detail: `${candidates[0]} (surface '${surface}')`,
  });
  let lastError: unknown;
  for (const hostname of candidates) {
    try {
      return await bind(hostname, true);
    } catch (e) {
      lastError = e; // Global-uniqueness collision or transient — try the tailed label.
    }
  }
  throw lastError instanceof Error ? lastError : new Error('could not bind a platform hostname');
}

/**
 * Remove one binding from an app. The DEFAULT hostname is refused — it is the URL
 * provisioning promised and the row the dashboard stores; retiring it is an app
 * lifecycle decision (delete), not a Domains-tab row action. Unbinding a canonical
 * leaves the surface's aliases as they are — the caller's UI states the rule.
 */
export async function removeAppHostname(
  host: ScopeHost,
  input: {
    node: DashboardNode;
    appScopeId: ScopeId;
    hostname: string;
    /** The app's stored default hostname (refused for removal). */
    defaultHostname?: string | null;
    controlPlane?: TenantNarrowedControlPlane;
  },
): Promise<void> {
  const hostname = input.hostname.trim().toLowerCase();
  if (input.defaultHostname && hostname === input.defaultHostname.toLowerCase()) {
    throw new Error(`'${hostname}' is the app's default hostname — delete the app to retire it`);
  }
  const bound = await listAppHostnames(host, input);
  const row = bound.find((h) => h.hostname === hostname);
  if (!row) throw new Error(`'${hostname}' is not bound to this app`);
  const scope = await host.getScope(input.node.principal, input.node.tenantId, input.node.scopeId);
  await scope.invoke('dashboard/unbind-app-hostname', {
    appScopeId: input.appScopeId,
    detail: `${hostname} (surface '${row.surface}')`,
  });
  if (input.controlPlane) {
    await input.controlPlane.unbindHostname(input.appScopeId, hostname);
  } else {
    const staff = platformActorId.parse(ulid());
    await host.admin.unbindHostname(staff, hostname);
  }
}
