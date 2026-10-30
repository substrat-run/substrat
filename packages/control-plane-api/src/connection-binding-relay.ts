import {
  binderOf,
  ConnectorRevokeUnsupported,
  isPrimaryScope,
  onRequestLandingFor,
  ulid,
  type ConnectionBinder,
  type ConnectionLandingOptionsInput,
  type ScopeHost,
} from '@substrat-run/kernel';
import {
  connectionBindRequest,
  connectionBindResult,
  connectionUnbindRequest,
  connectionUnbindResult,
  type Connection,
  type PermissionKey,
  type ConnectionBindResult,
  type ConnectionUnbindResult,
  type PlatformActorId,
  type Scope,
} from '@substrat-run/contracts';
import type { z } from '@substrat-run/contracts';
import { ConnectionRelayError, PREVIEW_CONNECTIONS_REFUSAL, PROVEN_CALLER_REFUSAL } from './connection-relay.js';

/**
 * The binding relays (#2732): `/internal/connections/bind` and `/internal/connections/unbind`, how a
 * scope binds its OWN connection (one made with the upsert relay's `owner: 'scope'`) to itself, with
 * its own options, and unbinds it again, from the vertical's own screen.
 *
 * The same shape as the upsert relay (connections.md §3.5.2): the vertical's operation is the
 * authorizing act (`ctx.check`), and its worker makes the call. What is bound is never the
 * caller's to name:
 *
 * - **The vertical is the directory's**, re-derived from the scope's record.
 * - **The connection is the scope's own.** It is live, of that (tenant, vertical), and owned by the
 *   named scope. Any other answers exactly as an unknown connection does.
 * - **The landing is the running version's.** It is the `on-request` landing that version declares
 *   for the provider, so the operation and key come from the declaration (as the connector pass
 *   reads one), and the options are the scope's, validated by the connector's own bind.
 * - **Binding grants the declared key on that one scope**, in the pass's order. **Unbinding** takes
 *   it back there (`revokeFromConnection`) and drops the binding; what the scope landed stays.
 */
export interface ConnectionBindingRelayOptions {
  /** Whether the call's caller was established as the scope it names. Every call here requires it. */
  proven: boolean;
  /** The connector pass's own reader and binders, so a scope binds as the pass would. */
  landings: ConnectionLandingOptionsInput;
}

/** The fixed fields of a binding as a binder answers it; the rest are its options. */
const FIXED = new Set(['tenantId', 'scopeId', 'vertical', 'operation', 'permission', 'boundAt', 'connectionId', 'externalAccountRef', 'grantPreflighted', 'permissionHeld']);

function parsed<T extends z.ZodTypeAny>(schema: T, body: unknown, what: string): z.infer<T> {
  const r = schema.safeParse(body);
  if (r.success) return r.data;
  const first = r.error.issues[0];
  throw new ConnectionRelayError(`invalid ${what} request: ${first ? `${first.path.join('.') || '(root)'} — ${first.message}` : 'malformed body'}`, 400);
}

/** The scope, its own connection, the declared landing and the provider's binder, or the refusal. */
async function ownTarget(
  host: ScopeHost,
  actor: PlatformActorId,
  input: { tenantId: Scope['tenantId']; scopeId: Scope['id']; connectionId: Connection['id'] },
  options: ConnectionBindingRelayOptions,
): Promise<{ scope: Scope; connection: Connection; landing: { operation: string; permission: PermissionKey; options?: Record<string, unknown> }; binder: ConnectionBinder }> {
  if (!options.proven) throw new ConnectionRelayError(PROVEN_CALLER_REFUSAL, 403);
  const scope = await host.admin.getScopeRecord(actor, input.tenantId, input.scopeId);
  if (!scope?.vertical) throw new ConnectionRelayError('scope has no vertical bound', 404);
  if (!isPrimaryScope(scope)) throw new ConnectionRelayError(PREVIEW_CONNECTIONS_REFUSAL, 403);
  if (scope.status !== 'active') throw new ConnectionRelayError(`scope ${scope.id} is ${scope.status}, not active`, 409);
  const connection = (
    await host.admin.listConnections(actor, { tenantId: input.tenantId, vertical: scope.vertical, ownerScopeId: input.scopeId })
  ).find((c) => c.id === input.connectionId);
  if (!connection) throw new ConnectionRelayError('unknown connection', 404);
  const declared = await onRequestLandingFor(host.admin, actor, options.landings.read, scope, connection.provider);
  if ('refused' in declared) throw new ConnectionRelayError(declared.refused, 409);
  const binder = binderOf(options.landings, connection);
  if (!binder) throw new ConnectionRelayError(`no scope binding registered for provider '${connection.provider}'`, 501);
  return { scope, connection, landing: declared.landing, binder };
}

export async function relayConnectionBind(
  host: ScopeHost,
  actor: PlatformActorId,
  body: unknown,
  options: ConnectionBindingRelayOptions,
): Promise<ConnectionBindResult> {
  const input = parsed(connectionBindRequest, body, 'connection bind');
  const { scope, connection, landing, binder } = await ownTarget(host, actor, input, options);
  const current = (await binder.list(host, connection)).find((b) => b.scopeId === scope.id);
  // The declaration's options are the defaults; the scope's own are what make it this scope's.
  let bindingOptions: Record<string, unknown>;
  try {
    bindingOptions = binder.options ? binder.options({ ...landing.options, ...input.options }, current) : { ...input.options };
  } catch (err) {
    throw new ConnectionRelayError(err instanceof Error ? err.message : String(err), 422);
  }
  const target = { ...bindingOptions, tenantId: scope.tenantId, scopeId: scope.id, vertical: connection.vertical, operation: landing.operation, permission: landing.permission };
  const bind = async (write: () => Promise<unknown>) => {
    try {
      return await write();
    } catch (err) {
      throw new ConnectionRelayError(`the ${connection.provider} connector refused the binding: ${err instanceof Error ? err.message : String(err)}`, 422);
    }
  };
  // The landing pass's order: a binder that stages its binding before the grant does so, and the
  // grant follows; otherwise the grant comes first and the connector's bind checks it is held.
  let bound: unknown;
  if (binder.bindBeforeGrant) bound = await bind(() => binder.bindBeforeGrant!(host, connection, target));
  const held = await host.connectionGrantsInScope(scope.tenantId, scope.id);
  if (!held.some((g) => g.connectionId === connection.id && g.permission === landing.permission)) {
    await host.admin.grantToConnection(actor, {
      connectionId: connection.id,
      permission: landing.permission,
      node: { tenantId: scope.tenantId, scopeId: scope.id },
      grantedBy: actor,
    });
  }
  if (!binder.bindBeforeGrant) bound = await bind(() => binder.bind(host, connection, target));
  await host.admin.recordConnectionBindingChange(actor, {
    phase: 'applied',
    tenantId: scope.tenantId,
    scopeId: scope.id,
    operationId: ulid(),
    connectionId: connection.id,
    provider: connection.provider,
    operation: landing.operation,
    permission: landing.permission,
    requestedBy: input.boundBy,
  });
  const answered = bound !== null && typeof bound === 'object' ? (bound as Record<string, unknown>) : {};
  const stored = Object.fromEntries(Object.entries(answered).filter(([k]) => !FIXED.has(k)));
  return connectionBindResult.parse({
    connectionId: connection.id,
    scopeId: scope.id,
    options: Object.keys(stored).length > 0 ? stored : bindingOptions,
    boundAt: typeof answered.boundAt === 'string' ? answered.boundAt : new Date().toISOString(),
  });
}

export async function relayConnectionUnbind(
  host: ScopeHost,
  actor: PlatformActorId,
  body: unknown,
  options: ConnectionBindingRelayOptions,
): Promise<ConnectionUnbindResult> {
  const input = parsed(connectionUnbindRequest, body, 'connection unbind');
  const { scope, connection, landing, binder } = await ownTarget(host, actor, input, options);
  if (!binder.unbind) throw new ConnectionRelayError(`'${connection.provider}' bindings cannot be removed through the relay`, 501);
  // The key first, so a deployment that cannot take the revoke leaves the binding as it was.
  try {
    await host.admin.revokeFromConnection(actor, {
      connectionId: connection.id,
      permission: landing.permission,
      node: { tenantId: scope.tenantId, scopeId: scope.id },
      revokedBy: input.unboundBy,
    });
  } catch (err) {
    if (err instanceof ConnectorRevokeUnsupported) throw new ConnectionRelayError(err.message, 503);
    throw err;
  }
  // Audited by the revoke's own row (with `revokedBy`), when the key moved: a binding change is a bind's record.
  await binder.unbind(host, connection, scope.id);
  return connectionUnbindResult.parse({ connectionId: connection.id, scopeId: scope.id, unbound: true });
}
