import {
  CONNECTOR_DISPATCH_KIND_PREFIX,
  VERTICAL_CONNECTOR_BINDING_PREFIX,
  connectionProbe,
  connectorBindResult,
  connectorCallConnection,
  connectorCallResponse,
  CONNECTOR_CALL_STATE_MAX_BYTES,
  CONNECTOR_CALL_STATE_MAX_KEYS,
  connectorCallState,
  connectorDispatchPayload,
  connectorSweepResult,
  scopeId as scopeIdSchema,
  verticalConnectorBinding,
  verticalConnectorBindingKey,
  verticalConnectorStateKey,
  verticalConnectorStatePrefix,
  type Connection,
  type ConnectionId,
  type ConnectionProbe,
  type ConnectorCallConnection,
  type ConnectorCallRequest,
  type ConnectorCallState,
  type ManifestConnectors,
  type PlatformActorId,
  type Scope,
  type ScopeId,
  type TenantId,
  type VerticalConnectorBinding,
  type VerticalConnectorDeclaration,
} from '@substrat-run/contracts';
import { isPrimaryScope, runningVersionOf, type ConnectionBinder, type ConnectorSweeper, type ScopeHost, type ServingPointer } from '@substrat-run/kernel';
import type { ConnectionScopeBinding } from '@substrat-run/control-plane-client';
import type { ConnectionInspector } from './api.js';
import type { PlatformRequestHandler } from './platform-drain.js';

/**
 * The platform side of a vertical-defined connector (docs/architecture/vertical-connectors.md §6):
 * the sweeper, binder, inspector and dispatch handler the control plane falls back to for a
 * `<namespace>.<name>` provider. Each keeps what the platform keeps for a first-party connector —
 * the sealed credential, the bindings, the connector state, the connection's health — and runs the
 * provider code by calling into the vertical's own deployment, one connection's worth per call.
 *
 * The transport is injected (`call`): the hosted control plane reaches the router's
 * `ConnectorCalls` entrypoint, which dispatches with the target version's `outbound` policy.
 */

/** Which deployment a call goes to, and the policy the router dispatches it under. */
export interface VerticalConnectorTarget {
  deploymentRef: string;
  slug: string;
  tenantId: string;
  scopeId: string | null;
  hosts: string[];
}

export interface VerticalConnectorDeps {
  host: ScopeHost;
  /** The actor the dispatch handler reads its connection row as. */
  actor: PlatformActorId;
  /** The declaration and the deployment that runs it: the scope's own running version when scopeId is given, else the vertical's serving version. */
  resolve(input: {
    tenantId: TenantId;
    vertical: string;
    scopeId: ScopeId | null;
    provider: string;
  }): Promise<{ declaration: VerticalConnectorDeclaration; target: VerticalConnectorTarget } | { refused: string }>;
  call(target: VerticalConnectorTarget, request: ConnectorCallRequest): Promise<{ status: number; body: unknown }>;
  now(): string;
}

/** The directory and registry reads {@link resolveVerticalConnectorTarget} decides from. */
export interface VerticalConnectorReads {
  scope(tenantId: TenantId, scopeId: ScopeId): Promise<Pick<Scope, 'vertical' | 'kind' | 'forkedFrom' | 'verticalVersionId' | 'servingRef'> | null | undefined>;
  /** What the vertical's stable serving script runs, or null before its first in-place serve. */
  serving(vertical: string): Promise<ServingPointer | null>;
  /** The version the vertical's `prod` channel points at, or null. */
  prodVersionId(vertical: string): Promise<string | null>;
  version(vertical: string, versionId: string): Promise<{ deploymentRef: string | null; outbound?: string[] | null } | null | undefined>;
  /** The connectors the version's STORED manifest declares (`connectorsOfManifestJson`). */
  connectors(vertical: string, versionId: string): Promise<ManifestConnectors>;
}

/** {@link VerticalConnectorReads} over a host's directory and registry, read as `actor`. */
export function verticalConnectorReadsOf(
  host: Pick<ScopeHost, 'admin'> & { versionConnectors(vertical: string, versionId: string): Promise<ManifestConnectors> },
  actor: PlatformActorId,
): VerticalConnectorReads {
  return {
    scope: (tenantId, scopeId) => host.admin.getScopeRecord(actor, tenantId, scopeId),
    serving: async (vertical) => {
      const serving = await host.admin.verticalServing(actor, vertical);
      return serving ? { ref: serving.ref, versionId: serving.versionId } : null;
    },
    prodVersionId: async (vertical) => (await host.admin.listChannels(actor, vertical)).find((c) => c.channel === 'prod')?.versionId ?? null,
    version: (vertical, versionId) => host.admin.getVersion(actor, versionId, vertical),
    connectors: (vertical, versionId) => host.versionConnectors(vertical, versionId),
  };
}

/**
 * Which declaration a call runs and where it goes (§6.3, §6.4) — `VerticalConnectorDeps.resolve`.
 * A scoped call runs the scope's RUNNING version (`runningVersionOf`) in the deployment that holds
 * its data: its serving script, else that version's own. A connection-level call runs the
 * vertical's serving version, else its prod channel's. The declaration is read off that version's
 * stored manifest on every call, so a promote that drops a connector stops it at the next one; the
 * hosts are that version's declared `outbound`.
 */
export async function resolveVerticalConnectorTarget(
  reads: VerticalConnectorReads,
  { tenantId, vertical, scopeId, provider }: Parameters<VerticalConnectorDeps['resolve']>[0],
): ReturnType<VerticalConnectorDeps['resolve']> {
  let versionId: string | null;
  let deploymentRef: string | null = null;
  if (scopeId) {
    const scope = await reads.scope(tenantId, scopeId);
    if (!scope || scope.vertical !== vertical) return { refused: `scope ${scopeId} is not an install of '${vertical}' in tenant ${tenantId}` };
    if (!isPrimaryScope(scope)) return { refused: `scope ${scopeId} is a preview or a fork, and those cause no outbound effects` };
    // The serving pointer matters only to a scope on the serving script (`runningVersionOf`).
    const serving = scope.servingRef ? await reads.serving(vertical) : null;
    versionId = runningVersionOf(scope, serving);
    deploymentRef = scope.servingRef ?? null;
  } else {
    const serving = await reads.serving(vertical);
    if (serving) {
      versionId = serving.versionId;
      deploymentRef = serving.ref;
    } else {
      versionId = await reads.prodVersionId(vertical);
    }
  }
  if (!versionId) return { refused: `no version of '${vertical}' runs${scopeId ? ` for scope ${scopeId}` : ''}` };
  const version = await reads.version(vertical, versionId);
  if (!version) return { refused: `version ${versionId} of '${vertical}' is not in the registry` };
  deploymentRef ??= version.deploymentRef;
  if (!deploymentRef) return { refused: `version ${versionId} of '${vertical}' has no deployment` };
  const fact = await reads.connectors(vertical, versionId);
  if (fact.kind === 'unreadable') return { refused: `the connectors version ${versionId} of '${vertical}' declares cannot be read: ${fact.reason}` };
  const declaration = fact.kind === 'connectors' ? fact.rows.find((d) => d.provider === provider) : undefined;
  if (!declaration) return { refused: `version ${versionId} of '${vertical}' does not declare the connector '${provider}'` };
  return { declaration, target: { deploymentRef, slug: vertical, tenantId, scopeId, hosts: version.outbound ?? [] } };
}

type ConnectionRow = Pick<Connection, 'id' | 'tenantId' | 'vertical' | 'provider' | 'externalAccountRef'>;
type CallOutcome = { ok: true; result: unknown } | { ok: false; refused: boolean; error: string };

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const USE_ERROR_MAX = 600;

/**
 * The live credential for `row`, as a call carries it. Refused when the live connection for its
 * (tenant, vertical, provider, account) is not `row` itself: the credential that is sent and the
 * connection the call's uses and state are recorded against must be the same row.
 */
async function openFor(deps: Pick<VerticalConnectorDeps, 'host'>, row: ConnectionRow): Promise<ConnectorCallConnection> {
  const open = await deps.host.admin.openConnection(row.tenantId, row.vertical, row.provider, row.externalAccountRef ?? undefined);
  if (!open) throw new Error(`no live '${row.provider}' connection for tenant ${row.tenantId} / vertical '${row.vertical}'`);
  if (open.id !== row.id) {
    throw new Error(
      `connection ${row.id} is not the live '${row.provider}' connection for tenant ${row.tenantId} / vertical ` +
        `'${row.vertical}' (that is ${open.id}): the credential sent and the connection recorded must be the same`,
    );
  }
  for (const [key, value] of Object.entries(open.secret as Record<string, unknown>)) {
    if (typeof value !== 'string') {
      throw new Error(`the stored credential of connection ${row.id} holds a non-string value under '${key}'; a vertical-defined connector is handed strings only`);
    }
  }
  return connectorCallConnection.parse({
    id: open.id,
    tenantId: row.tenantId,
    vertical: row.vertical,
    provider: row.provider,
    externalAccountRef: row.externalAccountRef,
    expiresAt: open.expiresAt,
    secret: open.secret,
  });
}

/** The connector's state for one call — the connection's, or one scope's — without its storage prefix. */
async function stateOf(host: ScopeHost, id: ConnectionId, scopeId: string | null): Promise<ConnectorCallState> {
  const prefix = verticalConnectorStatePrefix(scopeId);
  const rows = await host.admin.listConnectorState(id, prefix);
  const parsed = connectorCallState.safeParse(
    rows.filter((r) => r.value !== null).map((r) => ({ key: r.key.slice(prefix.length), value: r.value })),
  );
  if (!parsed.success) {
    throw new Error(
      `the connector state of ${scopeId === null ? 'the connection' : `scope ${scopeId}`} does not fit one call: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
    );
  }
  return parsed.data;
}

/**
 * Make one call and apply its answer (§6.2, §6.3). A succeeded call's state writes land, then its
 * recorded uses; a failed one's uses only, so a cursor never moves past work that did not land. A
 * call that never produced an answer (a transport throw, a non-200, a body that is not a response)
 * records one failed use and is reported retryable.
 */
async function applyConnectorCall(
  deps: VerticalConnectorDeps,
  connectionId: ConnectionId,
  scopeId: string | null,
  target: VerticalConnectorTarget,
  request: ConnectorCallRequest,
): Promise<CallOutcome> {
  const unanswered = async (error: string): Promise<CallOutcome> => {
    await deps.host.admin.recordConnectionUse(connectionId, { ok: false, error: error.slice(0, USE_ERROR_MAX) });
    return { ok: false, refused: false, error };
  };
  let answer: { status: number; body: unknown };
  try {
    answer = await deps.call(target, request);
  } catch (e) {
    return unanswered(`the call into the vertical's connector did not complete: ${message(e)}`);
  }
  if (answer.status !== 200) return unanswered(`the vertical's connector answered HTTP ${answer.status}`);
  const parsed = connectorCallResponse.safeParse(answer.body);
  if (!parsed.success) return unanswered("the vertical's connector answered something that is not a connector-call response");
  const response = parsed.data;
  // The uses happened whatever becomes of the state, so every outcome records them; a succeeded
  // call's state lands first.
  const recordUses = async () => {
    for (const use of response.uses) await deps.host.admin.recordConnectionUse(connectionId, use);
  };
  if (!response.ok) {
    await recordUses();
    return { ok: false, refused: response.refused, error: response.error };
  }
  // The cap holds the TOTAL a later call carries, not only this call's writes: state that grew
  // past it would refuse every later call, and the connector could never run to delete keys.
  const over = response.state.length > 0 ? await stateCapAfter(deps.host, connectionId, scopeId, response.state) : null;
  if (over) {
    await recordUses();
    return { ok: false, refused: false, error: over };
  }
  for (const w of response.state) {
    await deps.host.admin.putConnectorState(connectionId, verticalConnectorStateKey(scopeId, w.key), w.value === undefined ? null : w.value);
  }
  await recordUses();
  return { ok: true, result: response.result };
}

/**
 * Why `writes` may not land on the stored state of `scopeId` (null for the connection's own), or
 * null when the merged state (stored, then the writes, a `null` deleting) fits one call's cap.
 */
async function stateCapAfter(
  host: ScopeHost,
  id: ConnectionId,
  scopeId: string | null,
  writes: readonly { key: string; value: unknown }[],
): Promise<string | null> {
  const prefix = verticalConnectorStatePrefix(scopeId);
  const merged = new Map<string, unknown>();
  for (const r of await host.admin.listConnectorState(id, prefix)) if (r.value !== null) merged.set(r.key.slice(prefix.length), r.value);
  for (const w of writes) {
    if (w.value === null || w.value === undefined) merged.delete(w.key);
    else merged.set(w.key, w.value);
  }
  const fits = connectorCallState.safeParse([...merged].map(([key, value]) => ({ key, value })));
  if (fits.success) return null;
  return (
    `connector state would exceed what one call carries (${CONNECTOR_CALL_STATE_MAX_KEYS} keys, ${CONNECTOR_CALL_STATE_MAX_BYTES} bytes ` +
    `serialised) with ${merged.size} keys: nothing was written; the connector must delete keys`
  );
}

/** The bindings the platform holds for a connection, tombstones and unreadable rows left out. */
async function storedBindings(host: ScopeHost, id: ConnectionId): Promise<VerticalConnectorBinding[]> {
  const rows = await host.admin.listConnectorState(id, VERTICAL_CONNECTOR_BINDING_PREFIX);
  return rows.flatMap((r) => {
    if (r.value === null) return [];
    const b = verticalConnectorBinding.safeParse(r.value);
    return b.success ? [b.data] : [];
  });
}

/**
 * The poll floor for one vertical-defined connection: one call per bound scope, to that scope's own
 * deployment, carrying that scope's state (§6.1). Built per connection, since the pass hands a
 * sweeper only an id. Answers `{ found, failed, landed }`, which the pass reads
 * (`connectorSweepAnswerOf`).
 */
export function verticalConnectorSweeper(deps: VerticalConnectorDeps, connection: Connection): ConnectorSweeper {
  return async (_host, connectionId) => {
    if (connectionId !== connection.id) throw new Error(`this sweeper was built for connection ${connection.id}, not ${connectionId}`);
    const rows = (await deps.host.admin.listConnectorState(connection.id, VERTICAL_CONNECTOR_BINDING_PREFIX)).filter((r) => r.value !== null);
    const failed: { scopeId: string; error: string }[] = [];
    let found = 0;
    let landed = 0;
    if (rows.length === 0) return { found, failed, landed };
    const opened = await openFor(deps, connection);
    for (const row of rows) {
      const scopeId = row.key.slice(VERTICAL_CONNECTOR_BINDING_PREFIX.length);
      found += 1;
      const binding = verticalConnectorBinding.safeParse(row.value);
      if (!binding.success || binding.data.scopeId !== scopeId) {
        failed.push({ scopeId, error: 'its stored binding does not read as one' });
        continue;
      }
      try {
        const resolved = await deps.resolve({ tenantId: connection.tenantId, vertical: connection.vertical, scopeId: binding.data.scopeId, provider: connection.provider });
        if ('refused' in resolved) {
          failed.push({ scopeId, error: resolved.refused });
          continue;
        }
        if (!resolved.declaration.sweeps) {
          // A connector with no sweep polls nothing; its binding is the dispatch's, not a poll's.
          found -= 1;
          continue;
        }
        const state = await stateOf(deps.host, connection.id, scopeId);
        const outcome = await applyConnectorCall(deps, connection.id, scopeId, resolved.target, {
          role: 'sweep',
          provider: connection.provider,
          connection: opened,
          binding: binding.data,
          state,
        });
        if (!outcome.ok) {
          failed.push({ scopeId, error: outcome.error });
          continue;
        }
        const result = connectorSweepResult.safeParse(outcome.result);
        if (result.success) landed += result.data.landed;
        else failed.push({ scopeId, error: 'the connector answered a sweep result that does not read as one' });
      } catch (e) {
        failed.push({ scopeId, error: message(e) });
      }
    }
    return { found, failed, landed };
  };
}

/** A binding target as both doors hand it: the five fixed fields, and the rest are options. */
type BindTarget = { tenantId: string; scopeId: string; vertical: string; operation: string; permission: string } & Record<string, unknown>;

/**
 * Write `connection`'s binding to one scope (§6.1). Refused unless the scope's enforced tuples give
 * the connection the binding's key; the connector's `bind` hook, when it declares one, normalises
 * the options first, and a connector without one takes none.
 */
async function bindScope(deps: VerticalConnectorDeps, host: ScopeHost, connection: Connection, target: BindTarget): Promise<VerticalConnectorBinding> {
  const { tenantId, scopeId: rawScope, vertical, operation, permission, ...raw } = target;
  if (tenantId !== connection.tenantId || vertical !== connection.vertical) {
    throw new Error(`connection ${connection.id} belongs to tenant ${connection.tenantId} / vertical '${connection.vertical}', not to the scope's`);
  }
  const scopeId = scopeIdSchema.parse(rawScope);
  const grants = await host.connectionGrantsInScope(connection.tenantId, scopeId);
  if (!grants.some((g) => g.connectionId === connection.id && g.permission === permission)) {
    throw new Error(
      `connection ${connection.id} does not hold '${permission}' on scope ${scopeId} — what it read could not land. ` +
        'Grant it first (grantToConnection), then bind.',
    );
  }
  const resolved = await deps.resolve({ tenantId: connection.tenantId, vertical: connection.vertical, scopeId, provider: connection.provider });
  if ('refused' in resolved) throw new Error(resolved.refused);
  let options: Record<string, unknown> = raw;
  if (resolved.declaration.binds) {
    const outcome = await applyConnectorCall(deps, connection.id, scopeId, resolved.target, {
      role: 'bind',
      provider: connection.provider,
      connection: await openFor(deps, connection),
      scopeId,
      options: raw,
    });
    if (!outcome.ok) throw new Error(`the ${connection.provider} connector ${outcome.refused ? 'refused' : 'could not complete'} the binding: ${outcome.error}`);
    const result = connectorBindResult.safeParse(outcome.result);
    if (!result.success) throw new Error(`the ${connection.provider} connector answered a binding that does not read as one`);
    options = result.data.options;
  } else if (Object.keys(raw).length > 0) {
    throw new Error(`'${connection.provider}' takes no binding options (its connector declares no bind); got ${Object.keys(raw).join(', ')}`);
  }
  const binding = verticalConnectorBinding.parse({ scopeId, operation, permission, options, declared: raw, boundAt: deps.now() });
  await host.admin.putConnectorState(connection.id, verticalConnectorBindingKey(scopeId), binding);
  return binding;
}

const LISTED_FIXED = new Set(['scopeId', 'operation', 'permission']);

/**
 * The binder the landing pass binds a vertical-defined connection with (#2316). It lists each
 * binding's DECLARED options, so the pass compares a declaration with what was declared, never with
 * what the connector's `bind` hook normalised it to.
 */
export function verticalConnectorBinder(deps: VerticalConnectorDeps): ConnectionBinder {
  return {
    list: async (host, connection) =>
      (await storedBindings(host, connection.id)).map((b) => ({ ...b.declared, scopeId: b.scopeId, operation: b.operation, permission: b.permission })),
    bind: (host, connection, target) => bindScope(deps, host, connection, target),
    // Validated at bind, by the connector. A current binding's options survive unless overridden.
    options: (raw, current) => ({
      ...(current ? Object.fromEntries(Object.entries(current).filter(([k]) => !LISTED_FIXED.has(k))) : {}),
      ...(raw ?? {}),
    }),
  };
}

const probeFailure = (error: string, refused = false): ConnectionProbe => ({
  ok: false,
  refused,
  accountRef: null,
  accountLabel: null,
  facts: [],
  error: error.slice(0, USE_ERROR_MAX),
});

/** A probe call's outcome as the probe routes read it. */
function probeOf(outcome: CallOutcome): ConnectionProbe {
  if (!outcome.ok) return probeFailure(outcome.error, outcome.refused);
  const probe = connectionProbe.safeParse(outcome.result);
  return probe.success ? probe.data : probeFailure('the connector answered a probe that does not read as one');
}

function scopeBindingOf(connection: Connection, b: VerticalConnectorBinding): ConnectionScopeBinding {
  return {
    ...b.options,
    operation: b.operation,
    permission: b.permission,
    tenantId: connection.tenantId,
    scopeId: b.scopeId,
    vertical: connection.vertical,
    boundAt: b.boundAt,
  };
}

/**
 * What the inspection routes and the relay's connect-time gate ask of a vertical-defined provider,
 * for one (tenant, vertical). `activity`, `credential` and `certificate` are absent, so those
 * routes keep answering 501 / 404 for such a connection.
 */
export function verticalConnectorInspector(
  deps: VerticalConnectorDeps,
  provider: string,
  context: { tenantId: TenantId; vertical: string; scopeId: ScopeId | null },
): Required<Pick<ConnectionInspector, 'probe' | 'probeCandidate' | 'bindScope' | 'bindings'>> {
  return {
    // A probe that cannot run is an answer the verify route shows, never a 500.
    probe: async (host, connection) => {
      try {
        const resolved = await deps.resolve({ tenantId: connection.tenantId, vertical: connection.vertical, scopeId: null, provider: connection.provider });
        if ('refused' in resolved) return probeFailure(resolved.refused);
        const opened = await openFor(deps, connection);
        const state = await stateOf(host, connection.id, null);
        return probeOf(
          await applyConnectorCall(deps, connection.id, null, resolved.target, { role: 'probe', provider: connection.provider, connection: opened, state }),
        );
      } catch (e) {
        return probeFailure(`the probe could not run: ${message(e)}`);
      }
    },
    // To the vertical's serving deployment (§6.3), so not the asking scope's. No connection exists
    // yet, so nothing is recorded and no state is applied.
    probeCandidate: async (secret) => {
      const resolved = await deps.resolve({ tenantId: context.tenantId, vertical: context.vertical, scopeId: null, provider });
      if ('refused' in resolved) return probeFailure(resolved.refused);
      let answer: { status: number; body: unknown };
      try {
        answer = await deps.call(resolved.target, { role: 'probe-candidate', provider, secret });
      } catch (e) {
        return probeFailure(`the call into the vertical's connector did not complete: ${message(e)}`);
      }
      if (answer.status !== 200) return probeFailure(`the vertical's connector answered HTTP ${answer.status}`);
      const parsed = connectorCallResponse.safeParse(answer.body);
      if (!parsed.success) return probeFailure("the vertical's connector answered something that is not a connector-call response");
      const r = parsed.data;
      return probeOf(r.ok ? { ok: true, result: r.result } : { ok: false, refused: r.refused, error: r.error });
    },
    bindScope: async (host, connection, target) => scopeBindingOf(connection, await bindScope(deps, host, connection, target as unknown as BindTarget)),
    bindings: async (host, connection) => (await storedBindings(host, connection.id)).map((b) => scopeBindingOf(connection, b)),
  };
}

/**
 * The `connector:<namespace>.<name>` handler: one routed event, dispatched into the drained scope's
 * own deployment with that scope's binding (or none) and state. Expressed as
 * `connectorDispatchHandler` expresses its outcomes: a refusal settles `failed`, anything retryable
 * throws (the drain settles it `pending`), and a delivered event is `done`.
 */
export function verticalConnectorDispatchHandler(deps: VerticalConnectorDeps): PlatformRequestHandler {
  return async (ctx, request) => {
    const provider = request.kind.slice(CONNECTOR_DISPATCH_KIND_PREFIX.length);
    const payload = connectorDispatchPayload.parse(request.payload);
    if (payload.event.tenantId !== ctx.tenantId || payload.event.scopeId !== ctx.scopeId) {
      return {
        status: 'failed',
        error:
          `routed event ${payload.event.id} is stamped (${payload.event.tenantId}, ${payload.event.scopeId}), ` +
          `which is not the drained scope (${ctx.tenantId}, ${ctx.scopeId})`,
      };
    }
    const rows = await deps.host.admin.listConnections(deps.actor, { tenantId: ctx.tenantId, vertical: ctx.vertical, provider });
    if (rows.length !== 1) {
      throw new Error(
        rows.length === 0
          ? `no live '${provider}' connection for tenant ${ctx.tenantId} / vertical '${ctx.vertical}'`
          : `tenant ${ctx.tenantId} holds ${rows.length} live '${provider}' connections for vertical '${ctx.vertical}'; a routed event names none of them`,
      );
    }
    const row = rows[0]!;
    const resolved = await deps.resolve({ tenantId: ctx.tenantId, vertical: ctx.vertical, scopeId: ctx.scopeId, provider });
    if ('refused' in resolved) throw new Error(resolved.refused);
    const opened = await openFor(deps, row);
    const stored = await deps.host.admin.getConnectorState(row.id, verticalConnectorBindingKey(ctx.scopeId));
    let binding: VerticalConnectorBinding | null = null;
    if (stored !== undefined && stored !== null) {
      const parsed = verticalConnectorBinding.safeParse(stored);
      if (!parsed.success) throw new Error(`the stored binding of connection ${row.id} to scope ${ctx.scopeId} does not read as one`);
      binding = parsed.data;
    }
    const state = await stateOf(deps.host, row.id, ctx.scopeId);
    const outcome = await applyConnectorCall(deps, row.id, ctx.scopeId, resolved.target, {
      role: 'dispatch',
      provider,
      connection: opened,
      scopeId: ctx.scopeId,
      binding,
      event: payload.event,
      state,
    });
    if (outcome.ok) return { status: 'done', result: { eventId: payload.event.id } };
    if (outcome.refused) return { status: 'failed', error: `the ${provider} connector refused event ${payload.event.id}: ${outcome.error}` };
    throw new Error(outcome.error);
  };
}
