import {
  isTerminalProviderError,
  ulid,
  type ConnectorHandler,
  type OpsFailureInput,
  type ScopeHost,
} from '@substrat-run/kernel';
import {
  principalId as principalIdSchema,
  scopeId as scopeIdSchema,
  tenantId as tenantIdSchema,
  provisionSiblingPayload,
  archiveScopePayload,
  provisionTenantPayload,
  setEntitlementsPayload,
  connectorDispatchPayload,
  type PlatformActorId,
  type PlatformRequest,
  type Scope,
  type ScopeId,
  type TenantId,
} from '@substrat-run/contracts';
import { ControlPlaneError } from './client.js';
import { connectionGrantsForScope, type VerticalClient } from './vertical-client.js';
import { collectBlobStoreHandles, collectTenantStoreHandles } from './tenant-stores.js';
import type { PatchScriptBindingsFn } from './wfp.js';

/**
 * The platform-intent drain engine (Phase B2 of docs/architecture/platform-intents.md). A vertical
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
 * How many drain passes a pending intent may burn before the platform stops retrying and
 * settles it `failed` (#570). Every pass through the ceiling means a HANDLER judged the
 * failure transient — but an intent that has been "transient" this many times is
 * structurally stuck (a wrong dispatch target, a refusal upstream of the platform), and
 * before this ceiling its only trace was an `attempts` column nobody reads. At the
 * ~15-min sweep cadence 100 attempts ≈ a day — generous for any genuinely transient
 * fault, short enough that the proposer learns the truth while it still matters.
 */
export const MAX_PLATFORM_REQUEST_ATTEMPTS = 100;

export interface PlatformDrainOptions {
  /**
   * Land a durable ops-failure row (#559) when the drain gives up on an intent at the
   * attempt ceiling. Fire-and-forget at the call site: a recorder that throws must never
   * mask the settle it is recording. The drain adds the `actor` upstream.
   */
  recordFailure?: (entry: Omit<OpsFailureInput, 'actor'>) => void;
  /** Test override of {@link MAX_PLATFORM_REQUEST_ATTEMPTS}. */
  maxAttempts?: number;
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
  opts?: PlatformDrainOptions,
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
    // The attempt ceiling (#570): `attempts` counts SETTLED passes, so this pass is
    // attempts + 1. At the ceiling a still-pending outcome settles `failed` carrying its
    // last error — the truth the proposer's read actually surfaces — and the give-up
    // lands an ops-failure row (#559) so a six-day retry loop is an operator's headline,
    // not a spine-table archaeology find.
    const maxAttempts = opts?.maxAttempts ?? MAX_PLATFORM_REQUEST_ATTEMPTS;
    if (outcome.status === 'pending' && request.attempts + 1 >= maxAttempts) {
      outcome = {
        status: 'failed',
        result: outcome.result,
        error: `gave up after ${request.attempts + 1} drain attempts — last error: ${outcome.error ?? 'unknown'}`,
      };
      opts?.recordFailure?.({
        operation: `intent.${request.kind}`,
        stage: 'attempt-ceiling',
        tenantId: ctx.tenantId,
        scopeId: ctx.scopeId,
        vertical: ctx.vertical,
        message: `platform intent ${request.id} ${outcome.error}`,
      });
    } else if (outcome.status === 'failed') {
      // #618: a TERMINAL settle is the ceiling's own argument arriving early — the intent is
      // over, nobody is coming back to it, and until now its only trace was a `last_error`
      // column in the vertical's own DO. An unknown kind, a refused payload, a provider's 4xx:
      // each is an operator's headline for the same reason a give-up is.
      opts?.recordFailure?.({
        operation: `intent.${request.kind}`,
        stage: 'terminal',
        tenantId: ctx.tenantId,
        scopeId: ctx.scopeId,
        vertical: ctx.vertical,
        message: `platform intent ${request.id} failed: ${outcome.error ?? 'unknown'}`,
      });
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

/**
 * Align a still-provisioning scope with its vertical's serving script (#570). A scope
 * born without `servingRef` while its vertical serves in place (#286) — a directory
 * predating the insert-time inherit, or early passes that named a not-yet-matching slug —
 * makes provisioning dispatch to the pinned VERSION's script, while the tenant-store
 * binding patch targets the SERVING script (tenant-stores.ts): two halves of the same
 * handler aimed at two different scripts, so a store-backed vertical refuses every retry
 * and the intent can never converge. Stamping the serving pointer before resolving the
 * client makes provisioning, the binding patch, and the router agree on one script.
 *
 * Deliberately bounded to `status === 'provisioning'`: such a scope has never activated,
 * so its DO holds only re-derivable provisioning state (role/entitlement projections) and
 * there is no data to hop — unlike `adopt-serving`, which exists for scopes with data.
 */
async function adoptServingForProvisioning(
  host: ScopeHost,
  actor: PlatformActorId,
  scope: Scope | undefined,
): Promise<Scope | undefined> {
  if (!scope?.vertical || scope.servingRef || scope.status !== 'provisioning') return scope;
  const serving = await host.admin.verticalServing(actor, scope.vertical).catch(() => null);
  if (!serving) return scope;
  await host.admin.setScopeServingRef(actor, scope.tenantId, scope.id, serving.ref);
  await host.admin.bindScopeVersion(actor, scope.tenantId, scope.id, serving.versionId);
  return { ...scope, servingRef: serving.ref, verticalVersionId: serving.versionId };
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
  const created = await adoptServingForProvisioning(
    host,
    actor,
    await admin.getScopeRecord(actor, input.tenantId, input.scopeId),
  );
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
  // #473: mint + attach the tenant's blob stores on the sibling-provision path too, so a
  // reconcile heals a missing attachment-bucket binding exactly as it heals a store one.
  await collectBlobStoreHandles({
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
 *  1. the `tenantProvisioner` registry flag — the staff-granted provisioner capability
 *     (#444), flipped by `setVerticalTenantProvisioner` and read here at drain time.
 *     An ungranted vertical settles `failed` — the refusal distinguishes *undeclared*
 *     (the manifest never asked, #455) from *declared-but-ungranted* (awaiting the staff
 *     grant), so a vertical author gets a self-serve diagnosis instead of a dead end.
 *  2. SKU bound — every entitlement key a payload names must be in the manager's
 *     registry-declared `entitlements` (its manifest's, carried on push), read at drain time.
 *  3. target bound (#412 invariant 4) — when the manager DECLARES `provisions`, a
 *     `provision-tenant` payload's vertical must be among the declared targets. Phased:
 *     a granted manager with no declaration keeps its unbounded #444 behavior until its
 *     next push declares (then the bound engages, reviewably).
 *
 * Still phased (#412 invariant 2, before any third-party manager): `tenants.provisionedBy`
 * ownership — until it exists, a listed manager can `set-entitlements` on any tenant.
 */
export interface ManagedTenantDeps {
  host: ScopeHost;
  actor: PlatformActorId;
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
  targetVertical?: string,
): Promise<{ declared: string[] } | { refusal: PlatformRequestOutcome }> {
  const registered = (await deps.host.admin.listVerticals(deps.actor)).find(
    (v) => v.slug === ctx.vertical,
  );
  if (!registered?.tenantProvisioner) {
    // Undeclared vs declared-but-ungranted (#455): the former is a manifest fix the
    // vertical author makes alone; the latter is a request already on the console's
    // review surface, waiting for the staff grant.
    const error = registered?.provisions?.length
      ? `vertical '${ctx.vertical}' declares provisions [${registered.provisions.join(', ')}] but the tenant-provisioner capability has not been granted — staff approves the request in the console (setVerticalTenantProvisioner)`
      : `vertical '${ctx.vertical}' does not hold the tenant-provisioner capability and its manifest declares no \`provisions\` — declare the target verticals it provisions (package.json \`substrat.provisions\`) and push, then staff grants the capability in the console`;
    return { refusal: { status: 'failed', error } };
  }
  // Target bound (#412 invariant 4): only when the manager declares — an undeclared
  // grant keeps the pre-#455 unbounded behavior until the next push declares.
  if (targetVertical !== undefined && registered.provisions?.length && !registered.provisions.includes(targetVertical)) {
    return {
      refusal: {
        status: 'failed',
        error: `vertical '${ctx.vertical}' declares provisions [${registered.provisions.join(', ')}], which does not include the payload's vertical '${targetVertical}'`,
      },
    };
  }
  const declared = registered.entitlements ?? [];
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
    const admitted = await admitManager(
      deps,
      ctx,
      payload.entitlements.map((e) => e.key),
      payload.instance.vertical,
    );
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
        // Provenance (#412): stamp the MANAGER's tenant (the authoritative context the
        // host derived from the provisioning scope's directory row — the vertical never
        // asserts it), so the fleet can tell an app-provisioned tenant from a direct one.
        provisionedByTenant: ctx.tenantId,
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
    const created = await adoptServingForProvisioning(
      host,
      actor,
      await admin.getScopeRecord(actor, tenantId, scopeId),
    );
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
    // #473: same blob-store minting on the manager-driven provision-tenant path.
    await collectBlobStoreHandles({
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
export interface ConnectorDispatchDeps {
  host: ScopeHost;
  /**
   * The provider's handler — the SAME closure a self-host registers in-process
   * (e.g. `scriveConnector({...})`). The connector does not fork for hosting; only
   * the host running it changes.
   */
  connector: ConnectorHandler;
  /** Per-request egress timeout for this provider. Default 30s, the registration default. */
  timeoutMs?: number;
}

/**
 * The `connector:<provider>` platform-request handler (#574 phase 3) — the outbound half
 * of the platform-run connector pass. A CP-less vertical's host routed one connector
 * delivery here as an intent; this executes it with platform authority: open the tenant's
 * connection from THIS directory, egress to the provider, mint the webhook token, write
 * the dispatch ledger — all inside the connector's own closure via `host.dispatchConnector`
 * — and the drain settles the intent from the outcome. Registered once per provider the
 * platform operates, exactly as its sweepers are.
 *
 * A thrown handler (provider unreachable, no live connection yet) settles `pending` and
 * retries on later drains up to the attempt ceiling; the connector's dispatch ledger makes
 * those retries idempotent. An event whose kernel-stamped tenant/scope disagree with the
 * drained scope's is terminal: intents ride the scope's own spine table, so the drained
 * scope is the proven origin and a mismatched payload can only be a forgery or a bug.
 */
export function connectorDispatchHandler(deps: ConnectorDispatchDeps): PlatformRequestHandler {
  return async (ctx, request) => {
    const payload = connectorDispatchPayload.parse(request.payload);
    if (payload.event.tenantId !== ctx.tenantId || payload.event.scopeId !== ctx.scopeId) {
      return {
        status: 'failed',
        error:
          `routed event ${payload.event.id} is stamped (${payload.event.tenantId}, ${payload.event.scopeId}), ` +
          `which is not the drained scope (${ctx.tenantId}, ${ctx.scopeId})`,
      };
    }
    try {
      await deps.host.dispatchConnector(
        ctx.tenantId,
        ctx.scopeId,
        deps.connector,
        payload.event,
        deps.timeoutMs === undefined ? undefined : { timeoutMs: deps.timeoutMs },
      );
    } catch (e) {
      // #618: a 4xx is the provider telling the CALLER its request is wrong, and attempt 101
      // sends the identical bytes. Settling it terminal here — rather than letting the drain's
      // blanket catch call every throw transient — is what turns a payload bug into an answer
      // the same day instead of a fortnight of silent retries. The provider's own words ride
      // `lastError` into the journal, which is what a console now reads back.
      if (isTerminalProviderError(e)) {
        return {
          status: 'failed',
          error: `${e instanceof Error ? e.message : String(e)} — a client error the provider will refuse identically on retry, so this delivery was not retried`,
        };
      }
      throw e; // transient (5xx, timeout, rate limit, no live connection yet) — drain retries
    }
    return { status: 'done', result: { eventId: payload.event.id } };
  };
}

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
    // #592: every reconcile re-delivers the tenant's live connection grants, whoever
    // triggered it — this drain-side reconcile must not silently wipe or omit them.
    const connectionGrants = connectionGrantsForScope(
      await admin.listConnectionGrants(actor, tenantId),
      scope.vertical,
      scopeId,
    );
    // #687: sealing keys ride every reconcile too, for the same reason grants do — a
    // drain-side reconcile must not leave a scope unable to seal to a connector it could
    // seal to a moment ago.
    const connectionKeys = scope.vertical
      ? await admin.connectionSealingKeys(tenantId, scope.vertical)
      : [];
    try {
      await vertical.reconcileInstance({
        tenantId,
        scopeId,
        entitlements,
        identityLinks,
        connectionGrants,
        connectionKeys,
      });
    } catch (e) {
      if (e instanceof ControlPlaneError) return { status: 'pending', error: e.message };
      throw e;
    }
    return { status: 'done', result: { tenantId, plan: payload.plan } };
  };
}
