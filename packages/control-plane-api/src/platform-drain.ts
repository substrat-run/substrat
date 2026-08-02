import { ulid, type ScopeHost } from '@substrat-run/kernel';
import {
  principalId as principalIdSchema,
  scopeId as scopeIdSchema,
  provisionSiblingPayload,
  archiveScopePayload,
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
