import type {
  Connection,
  ConnectionLandingOptions,
  ManifestConnectionLandings,
  PermissionKey,
  PlatformActorId,
  ProjectedConnectionGrant,
  Scope,
  ScopeId,
  TenantId,
} from '@substrat-run/contracts';
import type { ScopeFilter, ScopeHost } from './scope-host.js';
import { runningFactsOf } from './export-break.js';
import { isPrimaryScope } from './scope-identity.js';
import { message } from './map-bounded.js';
import { ulid } from './ulid.js';

/**
 * Connection landings, applied (#2316): the connector pass's step that turns a vertical's declared
 * `connections` into a held key and a binding for every live connection of that provider.
 *
 * Why it runs in the connector pass rather than at provision or reconcile: a connection arrives on
 * its own clock. A company's administrator approves a connect link days after the vertical was
 * deployed, and nothing is provisioned or reconciled then. The pass already visits every live
 * connection every few minutes, so this is where a new one is first seen.
 *
 * It writes only what is missing or different, so a pass over a settled connection writes nothing
 * and logs nothing:
 *
 * - **The binding** is written only when the connection has none for the scope or the one it has
 *   names a different operation, key, or declared option. A provider may retain an option the
 *   declaration does not name (one Planima organization, say), or give it a fixed default
 *   (Fortnox's ledger kind). Built-in poll connectors can stage it before the grant; without the
 *   grant, it cannot invoke the landing operation.
 * - **The key** is granted (`grantToConnection`, audited, delivered to the scope) only when the
 *   scope does not hold it, read from the scope's own enforced tuples, not the directory. For a
 *   staged binding this follows its write, so an interrupted pass leaves no new authority without
 *   its landing.
 *
 * A landing declared `bind: 'on-request'` (#2732) is passed over: its connections are granted and
 * bound one scope at a time, when that scope asks, so the pass writes nothing for them.
 *
 * A provider whose binder is `exclusive` (#3221, a payment provider) lands each scope through ONE
 * connection: the one already bound there, else the oldest active one. The others are passed over
 * for that scope, so a second connected account binds nowhere until a tenant chooses it for an
 * install, and a choice the tenant made is never undone by a later pass.
 *
 * Nothing is unbound. A version that stops declaring a landing (or makes it `on-request`) leaves its
 * bindings in place, and a pass that lands through an operation the version no longer has reports
 * the refusal on the connection's sweep row; `unbind` stays a person's act. A revoked connection is never reached:
 * the pass skips it, and the revoke itself tombstoned its grants and deleted its bindings.
 */

/**
 * What the connector pass needs from a provider to bind its connections: the connector's own bind
 * and binding list, the same ones the staff binding door calls (#2317).
 */
export interface ConnectionBinder {
  /** The bindings `connection` holds, one per scope. Fields beyond these three are its options. */
  list(host: ScopeHost, connection: Connection): Promise<readonly { scopeId: string; operation: string; permission: string }[]>;
  /** Bind `connection` to one scope. Refuses a connection that does not hold `permission` there. */
  bind(
    host: ScopeHost,
    connection: Connection,
    target: { tenantId: TenantId; scopeId: ScopeId; vertical: string; operation: string; permission: string } & Record<string, unknown>,
  ): Promise<unknown>;
  /**
   * Stage a durable binding without its grant. Implementations use this only when the landing pass
   * has validated the declaration; the grant is written immediately afterward. A failure between
   * these writes leaves a harmless binding that cannot invoke without its grant.
   */
  bindBeforeGrant?(
    host: ScopeHost,
    connection: Connection,
    target: { tenantId: TenantId; scopeId: ScopeId; vertical: string; operation: string; permission: string } & Record<string, unknown>,
  ): Promise<unknown>;
  /**
   * The provider's options, validated, from what a declaration carries. Throws with a reason a
   * person can act on; a provider that takes none refuses any. Absent means the provider takes none.
   * When `current` is supplied, a provider may preserve its options unless `raw` overrides them,
   * or refuse a change to an immutable option. This runs before a binding or new permission grant.
   * Do not copy binding metadata (including the sync cursor) into the options.
   */
  options?(
    raw: ConnectionLandingOptions | undefined,
    current?: { scopeId: string; operation: string; permission: string },
  ): Record<string, unknown>;
  /**
   * True when a binding that matches the declaration must still be re-written, for a fact the
   * connection carries and the declaration does not (Fortnox's company, recorded on bindings
   * written after #2316). Absent means a matching binding is always current.
   */
  stale?(binding: { scopeId: string; operation: string; permission: string }, connection: Connection): boolean;
  /**
   * Drop `connection`'s binding to one scope (#2732), `bind`'s inverse. Idempotent; what the scope
   * landed stays. Absent means the provider cannot unbind, and the relay refuses an unbind of it.
   */
  unbind?(host: ScopeHost, connection: Connection, scopeId: ScopeId): Promise<void>;
  /**
   * #3221: a scope lands through at most ONE connection of this provider, so the pass never adds a
   * second. A payment provider is the case: a checkout goes through the one connection bound to the
   * scope, and two bound is refused, since which account takes the money is never guessed. Under it
   * the pass binds a scope only to the connection already bound there (re-writing it as usual) or,
   * when none of the provider's tenant connections is, to the OLDEST active one. Every other
   * connection of the provider is passed over for that scope, key and binding both. Which one an
   * install uses is then the binding itself: the tenant moves it (`chooseScopeConnection`), and the
   * pass, finding the scope bound, keeps it. Disconnecting the bound one leaves the scope unbound, and
   * the next pass binds the oldest active one left. Absent, every live connection binds everywhere.
   */
  readonly exclusive?: true;
}

export interface ConnectionLandingOptionsInput {
  /** The version's declared landings, read off its stored manifest (`connectionLandingsOfManifestJson`). */
  read(verticalSlug: string, versionId: string): Promise<ManifestConnectionLandings>;
  /** provider slug → its binder. A provider with none is never bound by a declaration. */
  binders: Record<string, ConnectionBinder>;
  /**
   * The binder for a connection `binders` has no entry for (a vertical-defined provider, whose
   * binder is built per connection). Asked only when the record has none; absent, such a
   * connection is never bound, as before.
   */
  binderFor?: (connection: Connection) => ConnectionBinder | undefined;
}

/** The binder a connection is bound through: the record's entry, else `binderFor`'s. */
export function binderOf(input: Pick<ConnectionLandingOptionsInput, 'binders' | 'binderFor'>, connection: Connection): ConnectionBinder | undefined {
  return input.binders[connection.provider] ?? input.binderFor?.(connection);
}

/** One landing a version declares for a provider, as the pass and the doors read it. */
export interface DeclaredLanding {
  operation: string;
  permission: PermissionKey;
  options?: ConnectionLandingOptions;
  bind?: 'every-install' | 'on-request';
}

/**
 * The landing `scope`'s RUNNING version declares for `provider`, or why there is none: read as the
 * landing pass reads a version, so a door is held to the declaration the pass would apply there.
 */
export async function declaredLandingFor(
  admin: Pick<ScopeHost['admin'], 'listVerticals'>,
  actor: PlatformActorId,
  read: ConnectionLandingOptionsInput['read'],
  scope: Scope,
  provider: string,
): Promise<{ landing: DeclaredLanding } | { refused: string }> {
  const [running] = await runningFactsOf<ManifestConnectionLandings>(admin, actor, [scope], read, (reason) => ({ kind: 'unreadable', reason }), 1);
  const fact = running?.fact;
  if (!fact || fact.kind === 'none') return { refused: `the version scope ${scope.id} runs declares no connection landings` };
  if (fact.kind === 'unreadable') return { refused: `the declared connection landings of the version scope ${scope.id} runs cannot be read: ${fact.reason}` };
  const landing = fact.rows.find((r) => r.provider === provider);
  if (!landing) return { refused: `the version scope ${scope.id} runs declares no landing for '${provider}'` };
  return {
    landing: {
      operation: landing.operation,
      permission: landing.permission,
      ...(landing.options ? { options: landing.options } : {}),
      ...(landing.bind ? { bind: landing.bind } : {}),
    },
  };
}

/**
 * The `on-request` landing `scope`'s RUNNING version declares for `provider` (#2732), the one a
 * scope binds its own connection through, or why there is none.
 */
export async function onRequestLandingFor(
  admin: Pick<ScopeHost['admin'], 'listVerticals'>,
  actor: PlatformActorId,
  read: ConnectionLandingOptionsInput['read'],
  scope: Scope,
  provider: string,
): Promise<{ landing: { operation: string; permission: PermissionKey; options?: ConnectionLandingOptions } } | { refused: string }> {
  const declared = await declaredLandingFor(admin, actor, read, scope, provider);
  if ('refused' in declared) return declared;
  const { bind, ...landing } = declared.landing;
  if (bind !== 'on-request') {
    return { refused: `the '${provider}' landing is bound to every install by the platform; only an on-request landing is bound by a scope` };
  }
  return { landing };
}

/**
 * For an {@link ConnectionBinder.exclusive} provider, the connections of one (tenant, vertical) a
 * scope may land through: each scope's bound ones, and the one an unbound scope is given (the oldest
 * active tenant connection, or none). Only the tenant's connections count: a scope's own is never
 * landed by the pass, and its checkout reads it beside these.
 */
export interface ExclusiveLandings {
  bound: ReadonlyMap<string, ReadonlySet<string>>;
  first: Connection['id'] | null;
}

export async function exclusiveLandingsOf(
  host: ScopeHost,
  actor: PlatformActorId,
  input: Pick<ConnectionLandingOptionsInput, 'binders' | 'binderFor'>,
  of: { tenantId: TenantId; vertical: string; provider: string },
): Promise<ExclusiveLandings> {
  const rows = (await host.admin.listConnections(actor, { tenantId: of.tenantId, vertical: of.vertical, provider: of.provider, ownerScopeId: null })).filter(
    (c) => c.revokedAt === null && c.ownerScopeId === null,
  );
  const bound = new Map<string, Set<string>>();
  for (const c of rows) {
    const binder = binderOf(input, c);
    if (!binder) continue;
    for (const b of await binder.list(host, c)) {
      let set = bound.get(b.scopeId);
      if (!set) bound.set(b.scopeId, (set = new Set()));
      set.add(c.id);
    }
  }
  const active = rows
    .filter((c) => c.status === 'active')
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { bound, first: active[0]?.id ?? null };
}

/** What one connection's landing step did, folded into its sweep row and the pass report. */
export interface LandingOutcome {
  /** Scopes whose key this step granted. */
  granted: ScopeId[];
  /** Scopes this step bound, or re-bound to a changed declaration. */
  bound: ScopeId[];
  /** Scopes it could not grant or bind, and why. The connection's sweep row reports each. */
  failed: { scopeId: string; error: string }[];
}

/** One install a landing targets, as the per-pass cache holds it. */
interface Target {
  scope: Scope;
  versionId: string | null;
  fact: ManifestConnectionLandings | undefined;
}

/**
 * The per-pass memory of the landing step: which installs each (tenant, vertical) has and what
 * they run, and the keys each scope holds. Each is read once per pass however many connections
 * ask, and kept as a promise so concurrent connections share one read.
 */
export class LandingPass {
  private readonly targets = new Map<string, Promise<Target[]>>();
  private readonly held = new Map<string, Promise<ProjectedConnectionGrant[]>>();
  private readonly exclusive = new Map<string, Promise<ExclusiveLandings>>();

  constructor(
    private readonly host: ScopeHost,
    private readonly actor: PlatformActorId,
    private readonly input: ConnectionLandingOptionsInput,
    private readonly concurrency: number,
    /**
     * How the pass reads a tenant's scopes: the sweep's own reader, so a directory row that does
     * not read as a scope is stepped over here too and named once with the pass's others, rather
     * than failing every landing in its tenant.
     */
    private readonly listScopes: (filter: ScopeFilter) => Promise<Scope[]>,
  ) {}

  /** Grant and bind what `connection`'s installs declare for its provider, and say what happened. */
  async apply(connection: Connection): Promise<LandingOutcome> {
    const out: LandingOutcome = { granted: [], bound: [], failed: [] };
    // #2732: a scope's own connection is bound by that scope when it asks, never by this pass.
    if (connection.ownerScopeId !== null) return out;
    const binder = binderOf(this.input, connection);
    if (!binder) return out;
    const targets = await this.targetsOf(connection.tenantId, connection.vertical);
    // #3221: read once per (tenant, vertical, provider) per pass. A bind this pass makes is not seen
    // by it, and need not be: an unbound scope is only ever given the one oldest active connection.
    const exclusive = binder.exclusive && targets.length > 0 ? await this.exclusiveOf(connection) : undefined;
    let existing: Awaited<ReturnType<ConnectionBinder['list']>> | undefined;
    for (const t of targets) {
      const scopeId = t.scope.id;
      if (!t.fact || t.fact.kind === 'none') continue;
      if (t.fact.kind === 'unreadable') {
        out.failed.push({ scopeId, error: `the declared connection landings of version ${t.versionId ?? '(none)'} cannot be read: ${t.fact.reason}` });
        continue;
      }
      const landing = t.fact.rows.find((r) => r.provider === connection.provider);
      // #2732: an `on-request` landing is bound by the scope that asks, never by this pass.
      if (!landing || landing.bind === 'on-request') continue;
      if (exclusive) {
        const holders = exclusive.bound.get(scopeId);
        // Bound elsewhere: that is the install's choice, and this connection is passed over there.
        if (holders && holders.size > 0 ? !holders.has(connection.id) : exclusive.first !== connection.id) continue;
      }
      try {
        existing ??= await binder.list(this.host, connection);
        const current = existing.find((b) => b.scopeId === scopeId);
        // Validate the effective target against the held binding before granting any new key.
        // Providers may refuse a kind change even when the declaration omits its default kind.
        const bindingOptions = binder.options ? binder.options(landing.options, current) : {};
        const needsBind = !current || !sameLanding(current, landing.operation, landing.permission, bindingOptions) || !!binder.stale?.(current, connection);
        const operationId = ulid();
        const audit = {
          tenantId: connection.tenantId,
          scopeId,
          operationId,
          connectionId: connection.id,
          provider: connection.provider,
          operation: landing.operation,
          permission: landing.permission,
          ...bindingOptions,
        };
        const target = {
          ...bindingOptions,
          tenantId: connection.tenantId,
          scopeId,
          vertical: connection.vertical,
          operation: landing.operation,
          permission: landing.permission,
        };
        // Each bind is audited right after its write, as the staff door's `applied` row: a bind that
        // threw is reported on the sweep row instead, and is retried by the next pass. A staged
        // binding is audited before its grant, because a pass after a failed grant sees the binding
        // already in place and does not bind (or audit) it again.
        const applied = () => this.host.admin.recordConnectionBindingChange(this.actor, { ...audit, phase: 'applied' });
        if (needsBind && binder.bindBeforeGrant) {
          await binder.bindBeforeGrant(this.host, connection, target);
          out.bound.push(scopeId);
          await applied();
        }
        const grants = await this.grantsIn(connection.tenantId, scopeId);
        if (!grants.some((g) => g.connectionId === connection.id && g.permission === landing.permission)) {
          await this.host.admin.grantToConnection(this.actor, {
            connectionId: connection.id,
            permission: landing.permission,
            node: { tenantId: connection.tenantId, scopeId },
            grantedBy: this.actor,
          });
          out.granted.push(scopeId);
        }
        if (needsBind && !binder.bindBeforeGrant) {
          await binder.bind(this.host, connection, target);
          out.bound.push(scopeId);
          await applied();
        }
      } catch (err) {
        out.failed.push({ scopeId, error: message(err) });
      }
    }
    return out;
  }

  /** Every primary, active install of `vertical` in `tenantId`, with what its running version declares. */
  private targetsOf(tenantId: TenantId, vertical: string): Promise<Target[]> {
    const key = `${tenantId}\u0000${vertical}`;
    let found = this.targets.get(key);
    if (!found) {
      found = (async () => {
        const scopes = (await this.listScopes({ tenantId })).filter(
          (s) => s.vertical === vertical && s.status === 'active' && isPrimaryScope(s),
        );
        if (scopes.length === 0) return [];
        const running = await runningFactsOf<ManifestConnectionLandings>(
          this.host.admin,
          this.actor,
          scopes,
          (slug, versionId) => this.input.read(slug, versionId),
          (reason) => ({ kind: 'unreadable', reason }),
          this.concurrency,
        );
        return running.map((r) => ({ scope: r.scope, versionId: r.versionId, fact: r.fact }));
      })();
      this.targets.set(key, found);
    }
    return found;
  }

  /** {@link exclusiveLandingsOf} for `connection`'s provider, read once per pass. */
  private exclusiveOf(connection: Connection): Promise<ExclusiveLandings> {
    const key = `${connection.tenantId}\u0000${connection.vertical}\u0000${connection.provider}`;
    let found = this.exclusive.get(key);
    if (!found) {
      found = exclusiveLandingsOf(this.host, this.actor, this.input, connection);
      this.exclusive.set(key, found);
    }
    return found;
  }

  /** The keys connections hold on one scope, as its enforced tuples say. */
  private grantsIn(tenantId: TenantId, scopeId: ScopeId): Promise<ProjectedConnectionGrant[]> {
    const key = `${tenantId}\u0000${scopeId}`;
    let found = this.held.get(key);
    if (!found) {
      found = this.host.connectionGrantsInScope(tenantId, scopeId);
      this.held.set(key, found);
    }
    return found;
  }
}

/** A binding matches a declaration when its operation, key and every DECLARED option agree. */
function sameLanding(
  binding: { operation: string; permission: string },
  operation: string,
  permission: string,
  options: Record<string, unknown>,
): boolean {
  if (binding.operation !== operation || binding.permission !== permission) return false;
  const held = binding as Readonly<Record<string, unknown>>;
  return Object.entries(options).every(([k, v]) => JSON.stringify(held[k] ?? null) === JSON.stringify(v ?? null));
}
