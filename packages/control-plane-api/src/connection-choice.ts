import {
  binderOf,
  ConnectorRevokeUnsupported,
  declaredLandingFor,
  exclusiveLandingsOf,
  isPrimaryScope,
  ulid,
  type ConnectionBinder,
  type ConnectionLandingOptionsInput,
  type ScopeHost,
} from '@substrat-run/kernel';
import { permissionKey, type Connection, type PlatformActorId, type Scope, type ScopeId, type TenantId } from '@substrat-run/contracts';
import { ConnectionRelayError, PREVIEW_CONNECTIONS_REFUSAL } from './connection-relay.js';

/**
 * Which connection an install lands through, for a provider that lands each install through ONE
 * (#3221): a payment provider, whose checkout goes through the one connection bound to the scope.
 *
 * The choice is not stored beside the binding: it IS the binding. The landing pass binds an
 * install only to the connection already bound there, or, when none is, to the oldest active one
 * (`ConnectionBinder.exclusive`), so what a tenant chooses here is kept by every later pass, and an
 * install nobody chose for keeps working with no change. Choosing binds the chosen connection in the
 * pass's own order (staged binding, then the declared key, or the key then the bind), audited as
 * the pass audits a bind, and only then takes every other tenant connection of the provider off the
 * install: its landing key revoked there and its binding dropped. A choice that fails part way
 * leaves the previous connection bound, so checkouts never lose their account to a refused bind.
 *
 * Only the tenant's connections are chosen among. A scope's own connection is bound by that scope
 * through the binding relay, never here.
 */
export interface ScopeConnectionChoice {
  provider: string;
  scopeId: string;
  /** The one tenant connection bound to the install, or `null` when none is, or several are. */
  chosen: string | null;
  /** Every tenant connection of the provider bound to the install. Two or more is a choice owed. */
  bound: string[];
}

export interface ConnectionChoiceOptions {
  /** The connector pass's reader and binders, so a choice binds as the pass would. */
  landings: ConnectionLandingOptionsInput;
}

const said = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The scope, primary and of a vertical, and the provider's exclusive binder; or the refusal. */
async function choiceTarget(
  host: ScopeHost,
  actor: PlatformActorId,
  input: { tenantId: TenantId; scopeId: ScopeId; provider: string },
  options: ConnectionChoiceOptions,
): Promise<{ scope: Scope & { vertical: string }; connections: Connection[]; binder: ConnectionBinder | undefined }> {
  const scope = await host.admin.getScopeRecord(actor, input.tenantId, input.scopeId);
  if (!scope) throw new ConnectionRelayError('unknown scope', 404);
  if (!scope.vertical) throw new ConnectionRelayError('scope has no vertical bound', 404);
  if (!isPrimaryScope(scope)) throw new ConnectionRelayError(PREVIEW_CONNECTIONS_REFUSAL, 403);
  const connections = (
    await host.admin.listConnections(actor, { tenantId: input.tenantId, vertical: scope.vertical, provider: input.provider, ownerScopeId: null })
  ).filter((c) => c.revokedAt === null && c.ownerScopeId === null);
  const binder = connections[0] ? binderOf(options.landings, connections[0]) : options.landings.binders[input.provider];
  if (binder && !binder.exclusive) {
    throw new ConnectionRelayError(`'${input.provider}' lands every install through every connection; there is no connection to choose`, 409);
  }
  return { scope: { ...scope, vertical: scope.vertical }, connections, binder };
}

/** `GET …/scopes/:scopeId/connections/:provider/choice`: which tenant connection the install lands through. */
export async function readScopeConnectionChoice(
  host: ScopeHost,
  actor: PlatformActorId,
  input: { tenantId: TenantId; scopeId: ScopeId; provider: string },
  options: ConnectionChoiceOptions,
): Promise<ScopeConnectionChoice> {
  const { scope, connections } = await choiceTarget(host, actor, input, options);
  if (connections.length === 0) return { provider: input.provider, scopeId: scope.id, chosen: null, bound: [] };
  const view = await exclusiveLandingsOf(host, actor, options.landings, { tenantId: scope.tenantId, vertical: scope.vertical, provider: input.provider });
  const bound = [...(view.bound.get(scope.id) ?? [])].sort();
  return { provider: input.provider, scopeId: scope.id, chosen: bound.length === 1 ? bound[0]! : null, bound };
}

/** `PUT …/scopes/:scopeId/connections/:provider/choice`: land the install through `connectionId` alone. */
export async function chooseScopeConnection(
  host: ScopeHost,
  actor: PlatformActorId,
  input: { tenantId: TenantId; scopeId: ScopeId; provider: string; connectionId: string; chosenBy?: string },
  options: ConnectionChoiceOptions,
): Promise<ScopeConnectionChoice & { unbound: string[] }> {
  const { scope, connections, binder } = await choiceTarget(host, actor, input, options);
  if (scope.status !== 'active') throw new ConnectionRelayError(`scope ${scope.id} is ${scope.status}, not active`, 409);
  const connection = connections.find((c) => c.id === input.connectionId);
  if (!connection) throw new ConnectionRelayError('unknown connection', 404);
  if (!binder) throw new ConnectionRelayError(`no scope binding registered for provider '${input.provider}'`, 501);
  if (!binder.unbind) throw new ConnectionRelayError(`'${input.provider}' bindings cannot be removed, so no connection can be chosen`, 501);
  if (connection.status !== 'active') {
    throw new ConnectionRelayError(`connection ${connection.id} is ${connection.status}; reconnect it before choosing it for an install`, 409);
  }
  const declared = await declaredLandingFor(host.admin, actor, options.landings.read, scope, input.provider);
  if ('refused' in declared) throw new ConnectionRelayError(declared.refused, 409);
  const { landing } = declared;
  if (landing.bind === 'on-request') {
    throw new ConnectionRelayError(`the '${input.provider}' landing is on-request: the app binds its own connection`, 409);
  }

  const node = { tenantId: scope.tenantId, scopeId: scope.id };
  const current = (await binder.list(host, connection)).find((b) => b.scopeId === scope.id);
  let bindingOptions: Record<string, unknown>;
  try {
    bindingOptions = binder.options ? binder.options(landing.options, current) : {};
  } catch (err) {
    throw new ConnectionRelayError(said(err), 422);
  }
  const target = { ...bindingOptions, tenantId: scope.tenantId, scopeId: scope.id, vertical: scope.vertical, operation: landing.operation, permission: landing.permission };
  const audit = async () =>
    host.admin.recordConnectionBindingChange(actor, {
      phase: 'applied',
      tenantId: scope.tenantId,
      scopeId: scope.id,
      operationId: ulid(),
      connectionId: connection.id,
      provider: connection.provider,
      operation: landing.operation,
      permission: landing.permission,
      ...bindingOptions,
      ...(input.chosenBy ? { requestedBy: input.chosenBy } : {}),
    });
  const refused = (err: unknown) => new ConnectionRelayError(`the ${connection.provider} connector refused the binding: ${said(err)}`, 422);
  const needsBind =
    !current ||
    current.operation !== landing.operation ||
    current.permission !== landing.permission ||
    Object.entries(bindingOptions).some(([k, v]) => JSON.stringify((current as Record<string, unknown>)[k] ?? null) !== JSON.stringify(v ?? null)) ||
    !!binder.stale?.(current, connection);

  // The pass's order. A refusal leaves the install as it was: what this call staged is dropped, and
  // the connection it is moving away from is only touched once the chosen one is bound.
  if (needsBind && binder.bindBeforeGrant) {
    try {
      await binder.bindBeforeGrant(host, connection, target);
    } catch (err) {
      throw refused(err);
    }
  }
  // A binding this call added, and only that: one the install already held stays as it was.
  const addedHere = needsBind && !current;
  // The grant read is inside the rollback too: a staged binding with no key behind it would still
  // count as bound, and the install's checkout would be refused for two.
  try {
    const held = await host.connectionGrantsInScope(scope.tenantId, scope.id);
    if (!held.some((g) => g.connectionId === connection.id && g.permission === landing.permission)) {
      await host.admin.grantToConnection(actor, { connectionId: connection.id, permission: landing.permission, node, grantedBy: actor });
    }
  } catch (err) {
    if (addedHere && binder.bindBeforeGrant) await binder.unbind(host, connection, scope.id);
    throw new ConnectionRelayError(`the landing key '${landing.permission}' cannot be granted to this connection: ${said(err)}`, 409);
  }
  if (needsBind && !binder.bindBeforeGrant) {
    try {
      await binder.bind(host, connection, target);
    } catch (err) {
      throw refused(err);
    }
  }
  if (needsBind) await audit();

  // Then every other tenant connection comes off the install: its key there first (the key the
  // binding records), then the binding, as the unbind relay does it.
  const unbound: string[] = [];
  for (const other of connections) {
    if (other.id === connection.id) continue;
    const binding = (await binder.list(host, other)).find((b) => b.scopeId === scope.id);
    if (!binding) continue;
    try {
      await host.admin.revokeFromConnection(actor, {
        connectionId: other.id,
        permission: permissionKey.parse(binding.permission),
        node,
        ...(input.chosenBy ? { revokedBy: input.chosenBy } : {}),
      });
    } catch (err) {
      if (err instanceof ConnectorRevokeUnsupported) {
        // The deployment cannot take the old key back, so the move cannot finish. Nothing taken off
        // yet, unless this is a later connection: put the install back on what it had by dropping the
        // binding this call added, so its checkouts keep their account instead of finding two.
        if (unbound.length === 0 && addedHere) await binder.unbind(host, connection, scope.id);
        throw new ConnectionRelayError(err.message, 503);
      }
      throw err;
    }
    await binder.unbind(host, other, scope.id);
    unbound.push(other.id);
  }
  // Two choices for one install can interleave (the plane holds no lock across these writes), and
  // each takes the other's connection off. Success is answered only when the install is left on the
  // chosen connection alone; otherwise the tenant is told to look again and choose.
  const after = await exclusiveLandingsOf(host, actor, options.landings, { tenantId: scope.tenantId, vertical: scope.vertical, provider: input.provider });
  const bound = [...(after.bound.get(scope.id) ?? [])].sort();
  if (bound.length !== 1 || bound[0] !== connection.id) {
    throw new ConnectionRelayError(
      `another change to this install's ${input.provider} account ran at the same time; it is now bound to ${bound.length === 0 ? 'none' : bound.join(', ')}, so choose again`,
      409,
    );
  }
  return { provider: input.provider, scopeId: scope.id, chosen: connection.id, bound, unbound };
}
