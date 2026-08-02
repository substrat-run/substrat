import { ulid, type ScopeHost } from '@substrat-run/kernel';
import {
  principalId as principalIdSchema,
  scopeId as scopeIdSchema,
  tenantId as tenantIdSchema,
  provisionSiblingPayload,
  archiveScopePayload,
  provisionTenantPayload,
  setEntitlementsPayload,
  type PlatformActorId,
  type PlatformRequest,
  type ScopeId,
  type TenantId,
} from '@substrat-run/contracts';
import { ControlPlaneError } from './client.js';
import type { VerticalClient } from './vertical-client.js';
import { collectTenantStoreHandles } from './tenant-stores.js';
import type { PatchScriptBindingsFn } from './wfp.js';

/**
 * The platform-intent drain engine (Phase B2 of docs/design/platform-intents.md). A vertical
 * enqueues typed intents in its own scope DO (`ctx.requestPlatform`, Phase A); because those rows
 * live in the vertical's deployment (K-31), the platform PULLS them over the vertical's `/internal`
 * surface (`VerticalClient`, Phase B1's read/settle exposed there) and executes each with its own
 * `HostAdmin` authority. Identity is inherent: the caller already holds `(tenant, scope, vertical)`
 * for the scope being drained — nothing is asserted by the vertical.
 */

/** The scope an intent was drained from — the platform's authoritative context, from its directory. */
export interface PlatformRequestContext {
  tenantId: TenantId;
  scopeId: ScopeId;
  vertical: string;
}

/** What a handler reports for one intent; `result` is persisted (COALESCE'd) for two-phase idempotency. */
export interface PlatformRequestOutcome {
  status: 'done' | 'failed' | 'pending';
  result?: unknown;
  error?: string;
}

/** Executes one intent kind with platform authority. Registered per `kind` (mirrors connector sweepers). */
export type PlatformRequestHandler = (
  ctx: PlatformRequestContext,
  request: PlatformRequest,
) => Promise<PlatformRequestOutcome>;

export interface PlatformDrainReport {
  drained: number;
  done: number;
  failed: number;
  pending: number;
}

/**
 * Drain one scope's pending platform intents: list them from the vertical, dispatch each to the
 * handler for its `kind`, and settle the outcome back in the vertical. An unknown kind settles
 * `failed` (never silently dropped); a thrown handler settles `pending` (retried on the next drain).
 * The `VerticalClient` transport is narrowed so tests can pass a fake.
 */
export async function drainScopePlatformRequests(
  client: Pick<VerticalClient, 'listPlatformRequests' | 'settlePlatformRequest'>,
  ctx: PlatformRequestContext,
  handlers: Record<string, PlatformRequestHandler>,
): Promise<PlatformDrainReport> {
  const pending = await client.listPlatformRequests(ctx.tenantId, ctx.scopeId);
  const report: PlatformDrainReport = { drained: pending.length, done: 0, failed: 0, pending: 0 };
  for (const request of pending) {
    const handler = handlers[request.kind];
    let outcome: PlatformRequestOutcome;
    if (!handler) {
      outcome = { status: 'failed', error: `no handler for platform-request kind '${request.kind}'` };
    } else {
      try {
        outcome = await handler(ctx, request);
      } catch (e) {
        // A thrown handler is a transient failure — keep the intent drainable for the next pass.
        outcome = { status: 'pending', error: e instanceof Error ? e.message : String(e) };
      }
    }
    await client.settlePlatformRequest(ctx.tenantId, ctx.scopeId, request.id, {
      status: outcome.status,
      result: outcome.result,
      lastError: outcome.error ?? null,
    });
    report[outcome.status]++;
  }
  return report;
}

export interface ProvisionSiblingDeps {
  host: ScopeHost;
  actor: PlatformActorId;
  /** Resolve the `VerticalClient` that serves a scope (its serving script / bound version). */
  resolveVerticalForScope: (scope: {
    vertical: string | null;
    verticalVersionId: string | null;
    servingRef?: string | null;
  }) => Promise<VerticalClient | undefined>;
  /**
   * Attach per-tenant store D1 bindings on the dispatch script (#301) — threaded through
   * to `collectTenantStoreHandles` so a sibling provision heals a missing attach exactly
   * as a first install would. A sibling shares its tenant's stores (they are per TENANT,
   * not per scope), so this usually resolves existing handles and no-ops the patch.
   */
  patchScriptBindings?: PatchScriptBindingsFn;
}

export interface ProvisionSiblingInput {
  tenantId: TenantId;
  parentScopeId: ScopeId;
  scopeId: ScopeId;
  slug: string;
  name: string;
  owner: string;
}

export type ProvisionSiblingResult =
  | { ok: true; scopeId: ScopeId }
  | { ok: false; status: number; error: string };

/**
 * Provision a SIBLING scope of `parentScopeId` — the single home for the sequence M1's
 * `POST /tenants/:tenantId/scopes` route runs and the drain's `provision-sibling` handler runs.
 * Inherit the parent's vertical + jurisdiction (directory row FIRST, K-31 two-phase), materialize
 * the instance in the vertical's deployment, activate. `provisionInstance` throws
 * `ControlPlaneError` on a vertical-side refusal (the caller decides retry vs surface); a
 * missing parent or unbound deployment returns `{ ok: false }`.
 */
export async function provisionSiblingScope(
  deps: ProvisionSiblingDeps,
  input: ProvisionSiblingInput,
): Promise<ProvisionSiblingResult> {
  const { host, actor } = deps;
  const admin = host.admin;
  const parent = await admin.getScopeRecord(actor, input.tenantId, input.parentScopeId);
  if (!parent || !parent.vertical) {
    return { ok: false, status: 404, error: `unknown scope for tenant: (${input.tenantId}, ${input.parentScopeId})` };
  }
  await host.provisionScope(actor, {
    tenantId: input.tenantId,
    scopeId: input.scopeId,
    slug: input.slug,
    name: input.name,
    vertical: parent.vertical,
    jurisdiction: parent.jurisdiction ?? undefined,
  } as Parameters<ScopeHost['provisionScope']>[1]);
  const created = await admin.getScopeRecord(actor, input.tenantId, input.scopeId);
  const vertical = created ? await deps.resolveVerticalForScope(created) : undefined;
  if (!vertical) {
    return { ok: false, status: 501, error: `no deployment is bound for vertical '${parent.vertical}'` };
  }
  const entitlements = await admin.listEntitlements(actor, input.tenantId);
  // #301: a sibling's provision callback carries the tenant's store handles like a first
  // install's does — the stores are per (tenant, vertical), so this re-resolves what the
  // first install minted rather than minting anything new.
  const tenantStores = await collectTenantStoreHandles({
    host,
    actor,
    slug: parent.vertical,
    tenantId: input.tenantId,
    patchBindings: deps.patchScriptBindings,
  });
  await vertical.provisionInstance({
    tenantId: input.tenantId,
    scopeId: input.scopeId,
    owner: principalIdSchema.parse(input.owner),
    slug: input.slug,
    name: input.name,
    entitlements,
    ...(tenantStores.length ? { tenantStores } : {}),
  });
  await admin.activateScope(actor, input.tenantId, input.scopeId);
  return { ok: true, scopeId: input.scopeId };
}

/**
 * The `provision-sibling` platform-request handler — reuses `provisionSiblingScope` with the drained
 * scope as the parent. Two-phase idempotency: a scope id minted on an earlier pass (recorded in the
 * intent's `result`) is reused, so a retry targets the same sibling and provisioning is a no-op
 * (K-31). A `ControlPlaneError` from the vertical is transient (`pending`, retried); a structural
 * failure (missing parent, unbound deployment) is terminal (`failed`).
 */
export function provisionSiblingHandler(deps: ProvisionSiblingDeps): PlatformRequestHandler {
  return async (ctx, request) => {
    const payload = provisionSiblingPayload.parse(request.payload);
    const prior = request.result;
    const scopeId =
      prior && typeof prior === 'object' && 'scopeId' in prior
        ? scopeIdSchema.parse((prior as { scopeId: string }).scopeId)
        : scopeIdSchema.parse(ulid());
    try {
      const r = await provisionSiblingScope(deps, {
        tenantId: ctx.tenantId,
        parentScopeId: ctx.scopeId,
        scopeId,
        slug: payload.slug,
        name: payload.name,
        owner: payload.owner,
      });
      return r.ok
        ? { status: 'done', result: { scopeId } }
        : { status: 'failed', result: { scopeId }, error: r.error };
    } catch (e) {
      if (e instanceof ControlPlaneError) return { status: 'pending', result: { scopeId }, error: e.message };
      throw e;
    }
  };
}

export interface ArchiveScopeDeps {
  host: ScopeHost;
  actor: PlatformActorId;
}

/**
 * The `archive-scope` platform-request handler — archives a sibling scope named in the intent.
 * The scope being drained proves the tenant; the target must be under that same tenant and run the
 * same vertical (checked against the directory), so a vertical can only ever archive its own
 * tenant's scopes. Idempotent: an already-archived/reaped/absent target is a no-op success, so a
 * retry never wedges.
 */
export function archiveScopeHandler(deps: ArchiveScopeDeps): PlatformRequestHandler {
  return async (ctx, request) => {
    const payload = archiveScopePayload.parse(request.payload);
    const admin = deps.host.admin;
    const target = await admin.getScopeRecord(deps.actor, ctx.tenantId, payload.scopeId);
    if (!target || target.status === 'archived' || target.status === 'reaped') {
      return { status: 'done', result: { archived: payload.scopeId } };
    }
    if (target.vertical !== ctx.vertical) {
      return { status: 'failed', error: `scope ${payload.scopeId} runs '${target.vertical ?? 'none'}', not '${ctx.vertical}'` };
    }
    await admin.archiveScope(deps.actor, ctx.tenantId, payload.scopeId);
    return { status: 'done', result: { archived: payload.scopeId } };
  };
}

/**
 * Deps for the MANAGED-TENANT handlers (#412) — `provision-tenant` / `set-entitlements`,
 * the capability that makes a vertical a manager (a console whose job is to add tenants).
 * Unlike `provision-sibling`, the target tenant is NOT proven by the drained scope (it may
 * not exist yet), so admissibility is bounded on the manager instead:
 *
 *  1. `provisioners` — the staff-granted provisioner capability. Deployment config today
 *     (the only manager is first-party); a directory-backed grant when third-party managers
 *     arrive. A vertical not listed settles `failed`.
 *  2. SKU bound — every entitlement key a payload names must be in the manager's
 *     registry-declared `entitlements` (its manifest's, carried on push), read at drain time.
 *
 * Still phased (#412 invariants 2/4, before any third-party manager): `tenants.provisionedBy`
 * ownership — until it exists, a listed manager can `set-entitlements` on any tenant — and
 * a declared-target-verticals bound (`manifest.provisions`).
 */
export interface ManagedTenantDeps {
  host: ScopeHost;
  actor: PlatformActorId;
  /** Manager verticals (registry slugs) holding the provisioner capability. */
  provisioners: readonly string[];
  /** Resolve the `VerticalClient` serving a scope — same ladder as `ProvisionSiblingDeps`. */
  resolveVerticalForScope: (scope: {
    vertical: string | null;
    verticalVersionId: string | null;
    servingRef?: string | null;
  }) => Promise<VerticalClient | undefined>;
  /** Attach per-tenant store D1 bindings (#301); a NEW tenant's first install mints here. */
  patchScriptBindings?: PatchScriptBindingsFn;
}

/**
 * Enforce the manager bound: provisioner capability + declared-SKU universe. Returns the
 * declared SKU list on admission (the reconcile in `set-entitlements` needs it — it bounds
 * the revoke side too), or the `failed` outcome to settle.
 */
async function admitManager(
  deps: ManagedTenantDeps,
  ctx: PlatformRequestContext,
  requestedKeys: string[],
): Promise<{ declared: string[] } | { refusal: PlatformRequestOutcome }> {
  if (!deps.provisioners.includes(ctx.vertical)) {
    return {
      refusal: {
        status: 'failed',
        error: `vertical '${ctx.vertical}' does not hold the tenant-provisioner capability`,
      },
    };
  }
  const registered = (await deps.host.admin.listVerticals(deps.actor)).find(
    (v) => v.slug === ctx.vertical,
  );
  const declared = registered?.entitlements ?? [];
  for (const key of requestedKeys) {
    if (!declared.includes(key)) {
      return {
        refusal: {
          status: 'failed',
          error: `entitlement '${key}' is not among the SKUs '${ctx.vertical}' declares`,
        },
      };
    }
  }
  return { declared };
}

/**
 * The `provision-tenant` platform-request handler (#412): create a NEW customer tenant, its
 * first scope running the PAYLOAD's vertical (never inherited — the manager and the managed
 * product are different verticals), grant its entitlements, then the same materialization a
 * first install runs: resolve the serving deployment, mint/collect the tenant's stores
 * (#301), `provisionInstance` (which projects the entitlements, #310), deliver `config`,
 * activate. Every id is proposed in the payload (idempotent join keys), so an at-least-once
 * drain converges without minting anything on retry: `createTenant`/`provisionScope`/
 * `provisionInstance` are all idempotent no-ops the second time. A `ControlPlaneError` from
 * the vertical is transient (`pending`); a structural refusal (capability, SKU bound, slug
 * taken by a different tenant, unbound deployment) is terminal (`failed`).
 */
export function provisionTenantHandler(deps: ManagedTenantDeps): PlatformRequestHandler {
  return async (ctx, request) => {
    const payload = provisionTenantPayload.parse(request.payload);
    const admitted = await admitManager(deps, ctx, payload.entitlements.map((e) => e.key));
    if ('refusal' in admitted) return admitted.refusal;
    const { host, actor } = deps;
    const admin = host.admin;
    const tenantId = tenantIdSchema.parse(payload.tenant.id);
    const scopeId = scopeIdSchema.parse(payload.instance.scopeId);
    try {
      await admin.createTenant(actor, {
        id: tenantId,
        slug: payload.tenant.slug,
        name: payload.tenant.name,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // Both adapters fail closed on a slug owned by a DIFFERENT tenant id with this
      // phrasing — a retry can never converge, so settle terminal instead of pending.
      if (message.includes('slugs are unique')) return { status: 'failed', error: message };
      throw e;
    }
    // Granted BEFORE provisionInstance so the #310 projection carries them on day one.
    for (const grant of payload.entitlements) {
      await admin.grantEntitlement(actor, tenantId, grant.key, { plan: grant.plan });
    }
    await host.provisionScope(actor, {
      tenantId,
      scopeId,
      slug: payload.instance.slug,
      name: payload.instance.name,
      vertical: payload.instance.vertical,
    } as Parameters<ScopeHost['provisionScope']>[1]);
    const created = await admin.getScopeRecord(actor, tenantId, scopeId);
    const vertical = created ? await deps.resolveVerticalForScope(created) : undefined;
    if (!vertical) {
      return {
        status: 'failed',
        result: { tenantId, scopeId },
        error: `no deployment is bound for vertical '${payload.instance.vertical}'`,
      };
    }
    const entitlements = await admin.listEntitlements(actor, tenantId);
    // #301: a NEW tenant's first install is exactly the minting path — the stores are
    // per (tenant, target vertical), keyed by the PAYLOAD's vertical, not the manager's.
    const tenantStores = await collectTenantStoreHandles({
      host,
      actor,
      slug: payload.instance.vertical,
      tenantId,
      patchBindings: deps.patchScriptBindings,
    });
    try {
      await vertical.provisionInstance({
        tenantId,
        scopeId,
        owner: principalIdSchema.parse(payload.instance.owner),
        slug: payload.instance.slug,
        name: payload.instance.name,
        entitlements,
        ...(tenantStores.length ? { tenantStores } : {}),
      });
      if (payload.config && Object.keys(payload.config).length) {
        try {
          await vertical.configureInstance({
            tenantId,
            scopeId,
            entries: Object.entries(payload.config).map(([key, value]) => ({ key, value })),
          });
        } catch (e) {
          // 501 = the vertical has no live-config support — authored but not delivered,
          // the same tolerance the settings route extends. Anything else is transient.
          if (!(e instanceof ControlPlaneError && e.status === 501)) throw e;
        }
      }
    } catch (e) {
      if (e instanceof ControlPlaneError) {
        return { status: 'pending', result: { tenantId, scopeId }, error: e.message };
      }
      throw e;
    }
    await admin.activateScope(actor, tenantId, scopeId);
    return { status: 'done', result: { tenantId, scopeId } };
  };
}

/**
 * The `set-entitlements` platform-request handler (#412): reconcile a managed tenant's
 * grants to the payload's TARGET set, bounded both ways by the manager's declared SKU
 * universe — grant what the target names, revoke any declared key absent from it — then
 * re-project into the tenant's auth scope via the vertical's idempotent reconcile
 * (entitlements re-gathered authoritative + identity links, exactly as the repair route,
 * #310/#406; the vertical-side projection is a full replace, so a downgrade revokes
 * cleanly). Keys OUTSIDE the declared universe are never touched, so a platform-granted
 * entitlement (e.g. the tenant's own product SKU) survives any manager reconcile.
 */
export function setEntitlementsHandler(deps: ManagedTenantDeps): PlatformRequestHandler {
  return async (ctx, request) => {
    const payload = setEntitlementsPayload.parse(request.payload);
    const admitted = await admitManager(deps, ctx, payload.entitlements.map((e) => e.key));
    if ('refusal' in admitted) return admitted.refusal;
    const { actor } = deps;
    const admin = deps.host.admin;
    const tenantId = tenantIdSchema.parse(payload.tenantId);
    const scopeId = scopeIdSchema.parse(payload.authScopeId);
    const scope = await admin.getScopeRecord(actor, tenantId, scopeId);
    if (!scope) {
      return { status: 'failed', error: `unknown scope for tenant: (${tenantId}, ${scopeId})` };
    }
    const target = new Map(payload.entitlements.map((e) => [e.key, e.plan]));
    for (const key of admitted.declared) {
      if (target.has(key)) {
        await admin.grantEntitlement(actor, tenantId, key, { plan: target.get(key) });
      } else {
        await admin.revokeEntitlement(actor, tenantId, key);
      }
    }
    const vertical = await deps.resolveVerticalForScope(scope);
    if (!vertical) {
      return {
        status: 'failed',
        error: `no deployment is bound for vertical '${scope.vertical ?? 'none'}'`,
      };
    }
    const entitlements = await admin.listEntitlements(actor, tenantId);
    const identityLinks = (await admin.listIdentityLinks(actor, tenantId)).map(
      ({ tenantId: _tenantId, ...link }) => link,
    );
    try {
      await vertical.reconcileInstance({ tenantId, scopeId, entitlements, identityLinks });
    } catch (e) {
      if (e instanceof ControlPlaneError) return { status: 'pending', error: e.message };
      throw e;
    }
    return { status: 'done', result: { tenantId, plan: payload.plan } };
  };
}
