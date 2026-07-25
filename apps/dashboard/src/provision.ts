import {
  platformActorId,
  scopeId as scopeIdSchema,
  type PermissionKey,
  type PlatformActorId,
  type PrincipalId,
  type RoleDefinition,
  type ScopeId,
  type TenantId,
} from '@substrat-run/contracts';
import { ulid, type ScopeHost } from '@substrat-run/kernel';
import { invitesModule } from '@substrat-run/engine-invites';
import { MEMBER_ROLES, dashboardModule, type DashboardAppRow } from './module.js';
import { TenantNarrowedControlPlane, type SnapshotRecord } from './authority.js';

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

  // 2. Effect the app scope IN THE CALLER'S OWN TENANT (node.tenantId, ambient —
  //    never a request argument). Connected: on the shared plane, tenant-narrowed.
  //    Embedded: in this deployment's own host. On failure (the vertical refused, a
  //    hostname wouldn't bind, …) mark the row `failed` so it doesn't sit silently at
  //    `provisioning`, then re-throw the original error (the caller surfaces it).
  let hostname: string | null;
  try {
    hostname = input.controlPlane
      ? await provisionOnSharedPlane(input.controlPlane, input)
      : await provisionEmbedded(host, input);
  } catch (e) {
    // Record WHY on the app's audit trail (e.g. "no deployment is bound for vertical 'meridian'"),
    // not just the toast — so the failure is visible on the app's Activity panel afterward.
    const reason = e instanceof Error ? e.message : String(e);
    await scope.invoke('dashboard/mark-app-failed', { appScopeId: input.appScopeId, reason }).catch(() => {});
    throw e;
  }

  // 3. Flip the account's record to active, recording the hostname if one bound.
  return scope.invoke('dashboard/mark-app-active', {
    appScopeId: input.appScopeId,
    ...(hostname ? { hostname } : {}),
  });
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
 * CONNECTED mode: provision through the shared control plane, tenant-narrowed —
 * the production path (dashboard.md §6). Mirrors the operator console's proven
 * create-instance sequence (apps/console/src/lib/create-instance.ts): a directory
 * row (`provisionScope`), the vertical instance (`provisionInstance` → the vertical
 * grants entitlements + assigns the owner its role), activation, then a bound
 * default hostname the router resolves. No `bindScopeVersion`: with WfP off the
 * router dispatches on a static `VERTICAL_<slug>` binding, which needs no version.
 */
async function provisionOnSharedPlane(cp: TenantNarrowedControlPlane, input: CreateAppInput): Promise<string | null> {
  const nameSlug = slugify(input.name);
  const scopeTail = input.appScopeId.toLowerCase().slice(-6);
  // The SCOPE slug must be UNIQUE within the tenant. Suffixing the scope id keeps two apps
  // with the same name — or a fresh attempt after one left an orphaned scope (a failed
  // provision marks the row failed but doesn't release its shared-plane scope) — from
  // colliding on "scope slug 'x' already taken". The hostname below still prefers the clean
  // name, so the URL stays `meridian.global.substrat.run` whenever it's free.
  const slug = `${nameSlug}-${scopeTail}`;
  const tenantSlug = `t-${cp.tenantId.toLowerCase().replace(/[^a-z0-9]/g, '').slice(-10)}`;
  await cp.ensureTenant(tenantSlug, input.tenantName ?? 'Workspace');
  // Belt-and-braces: the vertical grants these too, but an idempotent grant here
  // keeps the shared directory's entitlement view complete regardless.
  for (const key of input.appEntitlements ?? [input.verticalSlug]) await cp.grantEntitlement(key);
  await cp.provisionScope({ scopeId: input.appScopeId, slug, name: input.name, vertical: input.verticalSlug, jurisdiction: 'global' });
  await cp.provisionInstance(input.verticalSlug, { scopeId: input.appScopeId, owner: input.node.principal, slug, name: input.name });
  await cp.activateScope(input.appScopeId);

  // Pin the scope to the vertical's prod version so the router dispatches on it once
  // Workers-for-Platforms is enabled (D-35). No promoted version today ⇒ this is a
  // no-op and the router serves via the static `VERTICAL_<slug>` binding. It is the
  // ONLY thing that differs between the static bring-up and dynamic dispatch, so the
  // dashboard needs NO change when WfP flips on — only the deploy mechanism does.
  const prod = (await cp.listChannels(input.verticalSlug)).find((ch) => ch.channel === 'prod');
  if (prod) await cp.bindScopeVersion(input.appScopeId, prod.versionId);

  const domain = input.baseDomain ?? 'substrat.run';
  // Tenant-suffixed by preference (`callout-sesamy`), the scope-tailed slug as the
  // collision fallback; the unsuffixed ladder only for callers with no handle.
  const labels = input.teamHandle
    ? [`${nameSlug}-${input.teamHandle}`, `${slug}-${input.teamHandle}`]
    : [nameSlug, slug];
  for (const hostname of labels.map((l) => `${l}.global.${domain}`)) {
    try {
      await cp.bindHostname({ hostname, scopeId: input.appScopeId, surface: 'app', canonical: true });
      await cp.setHostnameStatus(hostname, 'active');
      return hostname;
    } catch {
      // Global-uniqueness collision or transient — try the next candidate.
    }
  }
  return null;
}

/** EMBEDDED mode (M0 / tests): provision into this deployment's own host + directory. */
async function provisionEmbedded(host: ScopeHost, input: CreateAppInput): Promise<string | null> {
  const staff = platformActorId.parse(ulid());
  const tenantId = input.node.tenantId;
  for (const key of input.appEntitlements ?? [input.verticalSlug]) {
    await host.admin.grantEntitlement(staff, tenantId, key);
  }
  await host.provisionScope(staff, { tenantId, scopeId: input.appScopeId, jurisdiction: 'global', vertical: input.verticalSlug });
  await host.admin.activateScope(staff, tenantId, input.appScopeId);
  for (const permission of input.appOwnerGrants ?? []) {
    await host.admin.grant(staff, {
      principalId: input.node.principal,
      permission,
      node: { tenantId, scopeId: input.appScopeId },
      grantedBy: input.node.principal,
    });
  }
  return bindDefaultHostname(host, {
    staff,
    tenantId,
    scopeId: input.appScopeId,
    name: input.name,
    teamHandle: input.teamHandle,
    jurisdiction: 'global',
    baseDomain: input.baseDomain ?? 'substrat.run',
  });
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
  args: { staff: PlatformActorId; tenantId: TenantId; scopeId: ScopeId; name: string; teamHandle?: string; jurisdiction: string; baseDomain: string },
): Promise<string | null> {
  const base = slugify(args.name);
  const tail = args.scopeId.toLowerCase().slice(-4);
  // Tenant-suffixed by preference (`callout-sesamy`), scope tail as collision belt.
  const labels = args.teamHandle
    ? [`${base}-${args.teamHandle}`, `${base}-${tail}-${args.teamHandle}`]
    : [base, `${base}-${tail}`];
  const candidates = labels.map((l) => `${l}.${args.jurisdiction}.${args.baseDomain}`);
  for (const hostname of candidates) {
    try {
      await host.admin.bindHostname(args.staff, {
        hostname,
        tenantId: args.tenantId,
        scopeId: args.scopeId,
        surface: 'app',
        region: null,
        canonical: true,
      });
      await host.admin.setHostnameStatus(args.staff, hostname, 'active');
      return hostname;
    } catch {
      // Collision or transient — try the next candidate.
    }
  }
  return null;
}
