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
  permissionKey,
  connectionBindRequest,
  connectionBindResult,
  connectionUnbindRequest,
  connectionUnbindResult,
  type Connection,
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

/** The scope, its own connection and the provider's binder, or the refusal. All both relays need. */
async function ownConnection(
  host: ScopeHost,
  actor: PlatformActorId,
  input: { tenantId: Scope['tenantId']; scopeId: Scope['id']; connectionId: Connection['id'] },
  options: ConnectionBindingRelayOptions,
): Promise<{ scope: Scope; connection: Connection; binder: ConnectionBinder }> {
  if (!options.proven) throw new ConnectionRelayError(PROVEN_CALLER_REFUSAL, 403);
  const scope = await host.admin.getScopeRecord(actor, input.tenantId, input.scopeId);
  if (!scope?.vertical) throw new ConnectionRelayError('scope has no vertical bound', 404);
  if (!isPrimaryScope(scope)) throw new ConnectionRelayError(PREVIEW_CONNECTIONS_REFUSAL, 403);
  const connection = (
    await host.admin.listConnections(actor, { tenantId: input.tenantId, vertical: scope.vertical, ownerScopeId: input.scopeId })
  ).find((c) => c.id === input.connectionId);
  if (!connection) throw new ConnectionRelayError('unknown connection', 404);
  const binder = binderOf(options.landings, connection);
  if (!binder) throw new ConnectionRelayError(`no scope binding registered for provider '${connection.provider}'`, 501);
  return { scope, connection, binder };
}

const said = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** `revokeFromConnection`, with a deployment that cannot take it answered as the relay's 503. */
async function revokeHere(host: ScopeHost, actor: PlatformActorId, revoke: Parameters<ScopeHost['admin']['revokeFromConnection']>[1]) {
  try {
    await host.admin.revokeFromConnection(actor, revoke);
  } catch (err) {
    if (err instanceof ConnectorRevokeUnsupported) throw new ConnectionRelayError(err.message, 503);
    throw err;
  }
}

export async function relayConnectionBind(
  host: ScopeHost,
  actor: PlatformActorId,
  body: unknown,
  options: ConnectionBindingRelayOptions,
): Promise<ConnectionBindResult> {
  const input = parsed(connectionBindRequest, body, 'connection bind');
  const { scope, connection, binder } = await ownConnection(host, actor, input, options);
  if (scope.status !== 'active') throw new ConnectionRelayError(`scope ${scope.id} is ${scope.status}, not active`, 409);
  const declared = await onRequestLandingFor(host.admin, actor, options.landings.read, scope, connection.provider);
  if ('refused' in declared) throw new ConnectionRelayError(declared.refused, 409);
  const { landing } = declared;
  const current = (await binder.list(host, connection)).find((b) => b.scopeId === scope.id);
  // The declaration's options fill only what the binding does not hold yet, and the scope's own
  // override both: a rebind keeps the scope's options, never resetting them to the defaults.
  const defaults = Object.fromEntries(Object.entries(landing.options ?? {}).filter(([k]) => !current || !(k in current)));
  let bindingOptions: Record<string, unknown>;
  try {
    bindingOptions = binder.options ? binder.options({ ...defaults, ...input.options }, current) : { ...defaults, ...input.options };
  } catch (err) {
    throw new ConnectionRelayError(said(err), 422);
  }
  const target = { ...bindingOptions, tenantId: scope.tenantId, scopeId: scope.id, vertical: connection.vertical, operation: landing.operation, permission: landing.permission };
  const refused = (err: unknown) => new ConnectionRelayError(`the ${connection.provider} connector refused the binding: ${said(err)}`, 422);
  const node = { tenantId: scope.tenantId, scopeId: scope.id };

  // A rebind under a landing whose key changed takes the binding's previous key back FIRST, while
  // the binding still records it: a revoke that fails then changes nothing and the scope can ask
  // again, where one after the new bind could leave a key nothing records. Only once the options
  // passed, so a refused option never touches the working binding.
  if (current && current.permission !== landing.permission) {
    await revokeHere(host, actor, { connectionId: connection.id, permission: permissionKey.parse(current.permission), node, revokedBy: input.boundBy });
  }

  // The landing pass's order: a binder that stages its binding before the grant does so, and the
  // grant follows; otherwise the grant comes first and the connector's bind checks it is held. A
  // refusal at any step leaves nothing this call added: a key it granted is taken back, a binding
  // it staged is dropped.
  let bound: unknown;
  if (binder.bindBeforeGrant) {
    try {
      bound = await binder.bindBeforeGrant(host, connection, target);
    } catch (err) {
      throw refused(err);
    }
  }
  const held = await host.connectionGrantsInScope(scope.tenantId, scope.id);
  const granted = !held.some((g) => g.connectionId === connection.id && g.permission === landing.permission);
  if (granted) {
    try {
      await host.admin.grantToConnection(actor, { connectionId: connection.id, permission: landing.permission, node, grantedBy: actor });
    } catch (err) {
      if (binder.bindBeforeGrant && !current) await binder.unbind?.(host, connection, scope.id);
      throw new ConnectionRelayError(`the landing key '${landing.permission}' cannot be granted to this connection: ${said(err)}`, 409);
    }
  }
  if (!binder.bindBeforeGrant) {
    try {
      bound = await binder.bind(host, connection, target);
    } catch (err) {
      // With no binding before this call, the key has nothing to land for: take it back whoever
      // granted it (the revoke is idempotent), so a retry after a revoke that failed clears it. The
      // connector's reason stays in the answer even when taking the key back fails.
      if (granted || !current) {
        try {
          await host.admin.revokeFromConnection(actor, { connectionId: connection.id, permission: landing.permission, node, revokedBy: input.boundBy });
        } catch (revokeErr) {
          throw new ConnectionRelayError(`${refused(err).message}; taking the landing key back failed, ask again: ${said(revokeErr)}`, 503);
        }
      }
      throw refused(err);
    }
  }
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
  // The options as the connector stored them, when its bind answers the binding; otherwise the
  // validated options it was handed.
  const answered = bound !== null && typeof bound === 'object' ? (bound as Record<string, unknown>) : undefined;
  return connectionBindResult.parse({
    connectionId: connection.id,
    scopeId: scope.id,
    options: answered ? Object.fromEntries(Object.entries(answered).filter(([k]) => !FIXED.has(k))) : bindingOptions,
    boundAt: typeof answered?.boundAt === 'string' ? answered.boundAt : new Date().toISOString(),
  });
}

export async function relayConnectionUnbind(
  host: ScopeHost,
  actor: PlatformActorId,
  body: unknown,
  options: ConnectionBindingRelayOptions,
): Promise<ConnectionUnbindResult> {
  const input = parsed(connectionUnbindRequest, body, 'connection unbind');
  // Ownership alone: a version that has since dropped the landing, or changed its key or mode,
  // still lets the scope take back what it holds.
  const { scope, connection, binder } = await ownConnection(host, actor, input, options);
  if (!binder.unbind) throw new ConnectionRelayError(`'${connection.provider}' bindings cannot be removed through the relay`, 501);
  // The key the binding itself records, first: whatever version wrote it, and never a standing
  // grant the connection holds for another reason. A deployment that cannot take the revoke leaves
  // the binding as it was. The revoke is audited on its own row (with `revokedBy`), when it moved:
  // a binding change is a bind's record.
  const binding = (await binder.list(host, connection)).find((b) => b.scopeId === scope.id);
  if (binding) {
    await revokeHere(host, actor, {
      connectionId: connection.id,
      permission: permissionKey.parse(binding.permission),
      node: { tenantId: scope.tenantId, scopeId: scope.id },
      revokedBy: input.unboundBy,
    });
  }
  await binder.unbind(host, connection, scope.id);
  return connectionUnbindResult.parse({ connectionId: connection.id, scopeId: scope.id, unbound: true });
}
