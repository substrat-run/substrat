import { reservedKeysOf, type ReservedKeySource } from '@substrat-run/contracts';

/**
 * The runtime half of a key reserved to a system principal (#2430, K-55), shared by both adapters
 * so they cannot refuse differently: the doors that confer a role refuse one that would hand a
 * person such a key.
 *
 * The reservation is read off the modules REGISTERED on the host, and those its declared
 * `permissions` lists (`holder: 'system'` on a manifest permission entry, the union rule of
 * `reservedKeysOf`), not off a list a push carried. At a Cloudflare scope node the scope class's own
 * modules count too. It judges the composition that actually runs, needs nothing delivered, and has
 * no version skew: a key none of them marks is a person's key, so nothing an older engine declared
 * is refused.
 *
 * - **A person's door** (`'person'`): `assignScopeRoleBounded`, `changeScopeRoleBounded` (the role
 *   moved to) and a membership add, where one person confers a role on another. No role carrying
 *   a reserved key passes. K-55's system-held role is the platform's to give its own host
 *   principal, never a person's to hand out.
 * - **The platform's door** (`'platform'`): `HostAdmin.assignRole`. A role that mixes reserved and
 *   other keys is refused, since no valid declaration produces one: a person's role holds no
 *   reserved key, and a system-held role holds nothing else. A role made only of reserved keys is
 *   admitted only when its stored holder is `system`. A legacy row with no holder keeps the
 *   old key-only behavior until its definition is written again.
 *
 * A person's door also refuses a role whose stored holder is `system` (#2447), whatever this host
 * knows: the holder a role definition carries is the reservation delivered with the role, so a
 * host that registers no module (and so reserves nothing) still keeps a system-held role from a
 * person. The provisioning owner seat and the owner hand-over are person doors too (#2447).
 *
 * Nothing already held is revoked: a seat that exists keeps working whatever a later engine
 * declares. A refusal is of the write it was asked for, and writes nothing.
 *
 * The person's refusal is also `canAssign`'s, which is the bound on taking a role away as well as
 * on giving it, so it is worded for both: no person's bound covers such a role.
 */
export function reservedRoleRefusal(
  role: RoleShape,
  reserved: ReadonlySet<string>,
  door: 'person' | 'platform',
): string | null {
  if (door === 'person' && role.holder === 'system') {
    return (
      `role '${role.key}' is declared holder: 'system', a role for a system principal: no person's bound covers it, to ` +
      `give the role or to take it back (K-55)`
    );
  }
  const held = role.permissions.filter((p) => reserved.has(p));
  if (held.length === 0) return null;
  const keys = held.join(', ');
  if (door === 'person') {
    return (
      `role '${role.key}' holds ${keys}, reserved to a system principal: no person's bound covers it, to give ` +
      `the role or to take it back (${RESERVED_BY})`
    );
  }
  const others = role.permissions.filter((p) => !reserved.has(p));
  if (others.length === 0) {
    // The wire and stored rows are untrusted at runtime: only a genuinely absent
    // holder retains the legacy decision. Unknown values fail as person-held.
    if (role.holder != null && role.holder !== 'system') {
      return `role '${role.key}' holds ${keys}, reserved to a system principal: its stored holder is person; a role made only of reserved keys must declare holder: 'system'`;
    }
    return null;
  }
  return (
    `role '${role.key}' holds ${keys}, reserved to a system principal, beside ${others.join(', ')}: a role carries ` +
    `a reserved key only when every key it holds is one (a system-held role, K-55)`
  );
}

/** A role as the reserved-key rule reads it: a definition, a stored row, or a projected one. */
export interface RoleShape {
  key: string;
  permissions: readonly string[];
  holder?: 'person' | 'system';
}

/**
 * What a host knows about keys (#2447): `reserved`, every key a module it registers or lists (and,
 * at a Cloudflare scope node, the scope class's) marks `holder: 'system'`; `declared`, every key
 * those modules declare at all. A declared key that is not reserved is a person's key.
 */
export interface HostReservations {
  reserved: ReadonlySet<string>;
  declared: ReadonlySet<string>;
}

/**
 * Why `role` may not be DEFINED for a tenant whose roles are stored as `tenantRoles`, or null (#2447):
 * the write a role definition makes, judged before it is made, so a role that passed a door when
 * it was assigned cannot be widened afterwards with a key no person may hold. `tenantRoles` is
 * what the host stores for the tenant now, the definition this one replaces included; `seated`
 * says whether anyone but a system principal holds a live seat in the role's key, whether or not a
 * definition of it is stored
 * (`SCOPE_SEATED_ROLES_SQL`, `TENANT_SEATED_ROLES_SQL`).
 *
 * The keys judged reserved are the host's, plus every key one of the tenant's system-held roles
 * holds: K-55 lets a system-held role hold reserved keys only, so its keys are reserved, and the
 * stored holder (#2444) is how a host that registers no modules learns the reservation at all. A
 * key the host's own modules declare unmarked is a person's, whatever a stored role says.
 *
 * - **A first definition** of a key: a person's role (holder omitted or `person`) carrying a
 *   reserved key is refused, and so is a system-held role carrying a key a person may hold (one
 *   the host's modules declare unmarked, or one a person's role of the tenant holds).
 * - **A redefinition** is judged as that new definition, against the stored roles, so a key added
 *   to a role whose seats were made through a person's door meets the person's rule.
 * - **A stored system-held role redefined as a person's** is judged as a person's role with the
 *   stored role's keys counted as reserved: the stored holder is the evidence, and a redefinition
 *   does not erase it.
 * - **A system-held definition of a key anyone but a system principal holds a seat in** is refused
 *   unless a system-held definition is stored for it. What kind of principal holds a seat is not
 *   recorded, so a seat made before any definition, under a person's definition, or under a
 *   person's definition a projection since dropped may be a person's, and relabelling the role
 *   would make it a system principal's. Taking the seats back first, or defining a new key, is the
 *   way. A system-held role a release dropped is the exception: its tombstone (#2531) is passed in
 *   `tenantRoles` as the stored system-held definition (`reservedRoleSetRefusal`), so adding it back
 *   is judged as if it had stayed defined. The seats decide for a role stored before the holder was recorded (#2480: no holder) too:
 *   it may be declared `holder: 'system'` only while nobody but a system principal holds a seat in
 *   it, since an upgrade admitted beside such a seat would let a later system-held definition add
 *   keys to it.
 *
 * **A key the host knows nothing about is admitted, deliberately (fail-open).** A host judges only
 * the reservations of modules it knows and of the tenant's system-held roles. Refusing every key it
 * cannot place would refuse every role a module-less host is given; the push (`substrat push`, the
 * registry boundary) is where the vertical's whole surface is judged. So a key reserved only
 * through a schedule's `permissions`, which no system-held role of the tenant holds, is not caught
 * on a host that does not register its module (the control plane verifying a pushed registry's
 * marks is #2446).
 *
 * A refusal writes nothing, and so revokes nothing: a seat of the role as it was stored keeps
 * working. A definition is never refused for a key it takes out, only for what it still holds.
 */
export function reservedRoleDefinitionRefusal(
  role: RoleShape,
  host: HostReservations,
  tenantRoles: readonly RoleShape[],
  seated = false,
): string | null {
  return definitionRefusal(role, host, tenantRoles, seated)?.refusal ?? null;
}

/**
 * `reservedRoleDefinitionRefusal` with why it refused (#2555): `seated`, a system-held definition of a
 * key someone holds a seat in with no system-held definition stored; `keys`, a key the role may not hold.
 */
function definitionRefusal(
  role: RoleShape,
  host: HostReservations,
  tenantRoles: readonly RoleShape[],
  seated: boolean,
): { reason: 'seated' | 'keys'; refusal: string } | null {
  const stored = tenantRoles.find((r) => r.key === role.key);
  const others = tenantRoles.filter((r) => r.key !== role.key);
  const personKey = (p: string) => host.declared.has(p) && !host.reserved.has(p);
  const bySystemRole = new Map<string, string>();
  for (const r of others) if (r.holder === 'system') for (const p of r.permissions) if (!bySystemRole.has(p)) bySystemRole.set(p, `the system-held role '${r.key}'`);
  if (role.holder === 'system') {
    // Judged against the seats of the key, whether or not a definition is stored: a projection can
    // drop a role's row and leave its seats live, and a later definition must not relabel a seat
    // made under a person's definition. A dropped SYSTEM-held row is no relabelling: its tombstone
    // arrives here as `stored` (#2531, `storedDefinitionOf`), so its re-add passes this check.
    // A row stored before the holder was recorded (#2480) is no exception: an upgrade admitted beside
    // a person's seat would leave a system-held row a later definition widens unjudged by its seats.
    if (stored?.holder !== 'system' && seated) {
      return {
        reason: 'seated',
        refusal:
          `role '${role.key}' is held by a principal (${storedAs(stored)}), so it cannot be declared holder: 'system': what kind ` +
          `of principal holds a seat is not recorded, so the seat may be a person\'s. Take that seat back first, wherever it is ` +
          `held (a scope, or the tenant; a host principal\'s seat can be given again after), keep the role defined across ` +
          `releases, or define the system-held role under a new key (K-55)`,
      };
    }
    const personsKeys = new Map<string, string>();
    for (const r of others) if (r.holder !== 'system') for (const p of r.permissions) if (!personsKeys.has(p)) personsKeys.set(p, r.key);
    const offences = role.permissions.flatMap((p) => {
      if (host.reserved.has(p)) return [];
      if (host.declared.has(p)) return [`${p} (declared for a person by a module this host registers)`];
      const holder = personsKeys.get(p);
      return holder ? [`${p} (held by the person's role '${holder}')`] : [];
    });
    if (offences.length === 0) return null;
    return {
      reason: 'keys',
      refusal:
        `role '${role.key}' is declared holder: 'system' but holds ${offences.join(', ')}: a system-held role holds only ` +
        `keys reserved to a system principal (K-55)`,
    };
  }
  // The stored system-held definition this one replaces is evidence too: its keys are reserved.
  // A tombstone is no row a role listing shows (#2531), so the refusal says what it is: the role was
  // defined system-held, and has since been dropped.
  const evidence = stored && DROPPED.has(stored) ? 'its definition as a system-held role, since dropped' : 'its stored system-held definition';
  if (stored?.holder === 'system') for (const p of stored.permissions) if (!bySystemRole.has(p)) bySystemRole.set(p, evidence);
  const held = role.permissions.flatMap((p) => {
    if (host.reserved.has(p)) return [`${p} (${RESERVED_BY})`];
    if (personKey(p)) return [];
    const by = bySystemRole.get(p);
    return by ? [`${p} (held by ${by})`] : [];
  });
  if (held.length === 0) return null;
  return {
    reason: 'keys',
    refusal:
      `role '${role.key}' is a person's role and would hold ${held.join(', ')}, reserved to a system principal: take the key ` +
      `out, or declare a role made only of reserved keys holder: 'system' (K-55)`,
  };
}

/** How the seated-key refusal names the stored row of the key, so it says only what is true of it. */
function storedAs(stored: RoleShape | undefined): string {
  if (!stored) return 'with no definition stored';
  if (stored.holder === undefined) return 'stored with no holder, from before holders were recorded (#2480)';
  return "stored as a person's role";
}

/** What a host stores for a tenant's roles where a role set is defined, and which of them are seated. */
export interface StoredRoles {
  roles: readonly RoleShape[];
  /** Role keys anyone but a system principal holds a live seat in, defined or not. */
  seated: ReadonlySet<string>;
  /**
   * #2531: the tenant's roles a projection dropped, each kept as a tombstone with the keys and the
   * holder it had when dropped. A tombstone grants nothing; it is evidence of what the row was.
   * Absent where nothing is ever dropped (a host with no release projection) or from an older host.
   */
  dropped?: readonly RoleShape[];
}

/**
 * The definition a key's stored row is judged as (#2531): its live row, or else a tombstone the
 * projection left when it dropped a SYSTEM-held role. Such a tombstone counts as the stored
 * system-held definition it was, in both branches: a re-add as system-held is not refused for a
 * seat, and a re-add as a person's counts its keys as reserved. That is parity with keeping the
 * role defined across releases, not proof the seat is a host principal's: the platform's door can
 * seat a person in a system-held role whether its row is live or dropped. A tombstone of a person's
 * role, or of a row with no holder, is no evidence of anything a system principal holds, so the key
 * is judged as having no definition stored, as before.
 */
function storedDefinitionOf(stored: StoredRoles | undefined, key: string): RoleShape | undefined {
  const live = stored?.roles.find((r) => r.key === key);
  if (live) return live;
  const found = stored?.dropped?.find((r) => r.key === key && r.holder === 'system');
  if (!found) return undefined;
  // A copy, so the mark is this one judgement's and never the caller's object, which it may pass
  // again as a live role.
  const tomb: RoleShape = { ...found };
  DROPPED.add(tomb);
  return tomb;
}

/** The copies of tombstones `storedDefinitionOf` handed on as a stored definition, so a refusal can name them as dropped. */
const DROPPED = new WeakSet<RoleShape>();

/**
 * `reservedRoleDefinitionRefusal` over a whole role set defined at once (a provision's or a
 * restore's projection, which replaces the tenant's roles in a scope): each role judged against the
 * rest of the set and the definition of its own key stored there now (`stored`; a system-held
 * tombstone counts, `storedDefinitionOf`), with its seats. The first refusal, or null.
 */
export function reservedRoleSetRefusal(roles: readonly RoleShape[], host: HostReservations, stored?: StoredRoles): string | null {
  return firstRefusedRole(roles, host, stored)?.refusal ?? null;
}

/**
 * #2531: `reservedRoleSetRefusal`'s answer with the key of the role it refused: the same walk, for a
 * unit that judges a set it is writing and answers a fixed sentence naming the role key only
 * (`inUnitRoleRefusal`). The rule's own wording stays the pre-check's.
 */
export function reservedRoleSetRefusedRole(
  roles: readonly RoleShape[],
  host: HostReservations,
  stored?: StoredRoles,
): { key: string; refusal: string } | null {
  const refused = firstRefusedRole(roles, host, stored);
  return refused ? { key: refused.key, refusal: refused.refusal } : null;
}

/**
 * #2531: the sentence a role set refused inside the unit that writes it answers: fixed, naming the
 * role key only. The unit rolls back, so nothing it would have written is written.
 */
export function inUnitRoleRefusal(roleKey: string): string {
  return (
    `role '${roleKey}' is refused by the reserved-key rule, judged against the roles and seats this scope holds as ` +
    `the write lands (K-55); nothing was written`
  );
}

/**
 * `reservedRoleSetRefusal`'s walk: the first role of the set refused, with the refusal, or null.
 * `judged` narrows which roles are asked about; every role of the set stays their context.
 */
function firstRefusedRole(
  roles: readonly RoleShape[],
  host: HostReservations,
  stored?: StoredRoles,
  judged: (role: RoleShape) => boolean = () => true,
): { key: string; reason: 'seated' | 'keys'; refusal: string } | null {
  for (const role of roles) {
    if (!judged(role)) continue;
    const own = storedDefinitionOf(stored, role.key);
    const tenantRoles = [...roles.filter((r) => r.key !== role.key), ...(own ? [own] : [])];
    const refused = definitionRefusal(role, host, tenantRoles, stored?.seated.has(role.key) ?? false);
    if (refused) return { key: role.key, ...refused };
  }
  return null;
}

/**
 * #2555: why a dump may not be loaded into a scope of a host the control plane runs (`restoreScope`,
 * `importScope`), or null. The load brings the dump's scope-level seats, and the roles that apply to
 * them are the tenant's roles as the directory stores them NOW (`roles`). So that set is judged as a
 * restore's projection is (`reservedRoleSetRefusal`), against the dump's own role rows and seats for
 * the tenant it was captured from (`dumpRoleState`). A seat the dump holds in a role the directory
 * has since made system-held is refused, unless the dump stores that role system-held itself. A dump
 * with no role rows (a pure-SQLite scope file, or a scope that read its roles over RPC) says nothing
 * about the definition its seats were made under, so such a seat is judged as a person's, the rule's
 * reading of a seat whose holder is not recorded. A scope holding a seat in a system-held role
 * therefore cannot be restored from its own export on a host whose dump carries no role rows.
 *
 * Only the roles the dump seats or stores are asked about, so a directory role the dump has no part
 * in never refuses a load (the directory's own doors judge it); the whole set stays their context.
 *
 * Asked before anything is replaced, so a refused load moves nothing. The answer is one of two fixed
 * sentences naming the role key only: the rule's own wording is kept out of it, since it is read by
 * whoever sent the dump. The second is chosen from the rule's reason, not from the dump's shape: the
 * seat rule refused, and the dump carries no definition of the role to show its seats were made as a
 * system principal's. A refusal over the keys the tenant's definition holds takes the first.
 */
export function dumpRoleRefusal(
  roles: readonly RoleShape[],
  host: HostReservations,
  dump: { tenantId: string; tables: readonly DumpTable[] },
  now: string,
): string | null {
  // #2531: the dump's tombstones come with it (`dumpRoleState`), so the walk reads a system-held one as
  // the stored definition it was (`storedDefinitionOf`), and a role the dump keeps only as a tombstone
  // is one it defines: judged, and answered as defined rather than as having no definition.
  const stored = dumpRoleState(dump.tables, dump.tenantId, now);
  const inDump = (key: string) => stored.roles.some((r) => r.key === key) || (stored.dropped ?? []).some((r) => r.key === key);
  const refused = firstRefusedRole(roles, host, stored, (r) => stored.seated.has(r.key) || inDump(r.key));
  if (!refused) return null;
  if (refused.reason === 'seated' && !inDump(refused.key)) {
    return (
      `restore refused: the dump seats role '${refused.key}' but carries no definition of it, so its seats cannot be told ` +
      `from a person's, and the tenant now defines the role for a system principal (K-55); nothing was loaded`
    );
  }
  return `restore refused: role '${refused.key}', which the dump seats or defines, cannot be applied as the tenant defines it now (K-55); nothing was loaded`;
}

/**
 * #2446: a scope's stored roles and seated role keys as they cross the wire (`roleStateLocal`, the
 * vertical's `/internal/role-state`): what `StoredRoles` holds, with the set as a list. Role keys,
 * permissions and holders only; no principal is named. `dropped` (#2531) is optional on the wire: a
 * host from before tombstones sends none, and a reader from before them strips it and judges as if
 * no tombstone were kept, which refuses at least as much.
 */
export interface RoleState {
  roles: RoleShape[];
  seated: string[];
  dropped?: RoleShape[];
}

/**
 * #2446: the reservations a pushed registry's rows mark — `reserved`, every key marked
 * `holder: 'system'`; `declared`, every key it lists. The push boundary holds those marks to the
 * module declarations shipped beside them (`pushedModuleRegistryProblems`), so they are what the
 * incoming version's modules reserve and declare, the reservation its reconcile judges with.
 */
export function registryReservations(registry: { permissions: readonly { key: string; holder?: 'system' }[] }): HostReservations {
  return {
    reserved: new Set(registry.permissions.filter((p) => p.holder === 'system').map((p) => p.key)),
    declared: new Set(registry.permissions.map((p) => p.key)),
  };
}

/**
 * #2446: why a release's role set would be refused where a scope stores `state`, or null: the
 * question that scope's reconcile asks (`reservedRoleSetRefusal`, with the incoming version's
 * reservations), asked before a promote moves it. A promote that would hold a seated scope's
 * reconcile is refused instead.
 */
export function releaseRoleSetRefusal(
  registry: { permissions: readonly { key: string; holder?: 'system' }[]; roles: readonly RoleShape[] },
  state: RoleState,
): string | null {
  return reservedRoleSetRefusal(registry.roles, registryReservations(registry), {
    roles: state.roles,
    seated: new Set(state.seated),
    ...(state.dropped ? { dropped: state.dropped } : {}),
  });
}

/**
 * #2446: whether a release's role set can be refused by any scope's stored state, so its promote
 * must ask the scopes it moves. A system-held role meets the seat rule and the stored definitions
 * (`reservedRoleDefinitionRefusal`). A person's role is judged against stored state only for a key
 * its registry does not declare: every declared key is a reserved one, refused at push, or a
 * person's, which no stored row overrides. A release with neither asks no scope.
 */
export function releaseRolesAskScopes(registry: { permissions: readonly { key: string }[]; roles: readonly RoleShape[] }): boolean {
  const declared = new Set(registry.permissions.map((p) => p.key));
  return registry.roles.some((r) => r.holder === 'system' || r.permissions.some((p) => !declared.has(p)));
}

/**
 * #2447: the role keys a scope's own tuples seat anyone but a system principal in, live now — what
 * a role set defined on the scope is judged against. One parameter: now (ISO text).
 */
export const SCOPE_SEATED_ROLES_SQL =
  "SELECT DISTINCT substr(relation, 6) AS role_key FROM _substrat_tuples WHERE relation LIKE 'role:%' AND subject NOT LIKE 'system:%' AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)";

/** A scope dump's table, as a restore carries it: its name, its columns, and its rows in that order. */
export interface DumpTable {
  name: string;
  columns: readonly string[];
  rows: readonly (readonly unknown[])[];
}

/**
 * #2447: what a scope dump stores for a tenant's roles, and the role keys anyone but a system
 * principal holds a live scope-level seat in there — `SCOPE_SEATED_ROLES_SQL`'s reading, over a dump's
 * rows instead of a table. A dump's projected tenant-level tuples are not seats here: the repair a
 * restore runs projects none, so they do not survive it, and the tenant's own seats are the
 * directory's. A restore judges the role set its repair defines against it before it imports the dump.
 */
export function dumpRoleState(tables: readonly DumpTable[], tenantId: string, now: string): StoredRoles {
  const read = (name: string) => {
    const t = tables.find((x) => x.name === name);
    return t ? t.rows.map((r) => Object.fromEntries(t.columns.map((c, i) => [c, r[i]])) as Record<string, unknown>) : [];
  };
  const live = (r: Record<string, unknown>) => r.revoked_at == null && (r.expires_at == null || String(r.expires_at) > now);
  const shapeOf = (r: Record<string, unknown>): RoleShape => ({
    key: String(r.role_key),
    permissions: JSON.parse(String(r.permissions)) as string[],
    ...(r.holder === 'person' || r.holder === 'system' ? { holder: r.holder as 'person' | 'system' } : {}),
  });
  const tenantRows = read('_substrat_roles').filter((r) => r.tenant_id === tenantId);
  const roles = tenantRows.filter((r) => r.revoked_at == null).map(shapeOf);
  // #2531: a dropped role's tombstone travels with the dump, as the evidence it is in the scope.
  const dropped = tenantRows.filter((r) => r.revoked_at != null).map(shapeOf);
  const seats = read('_substrat_tuples');
  const seated = new Set(
    seats
      .filter((r) => String(r.relation).startsWith('role:') && !String(r.subject).startsWith('system:') && live(r))
      .map((r) => String(r.relation).slice('role:'.length)),
  );
  return { roles, seated, dropped };
}

/**
 * #2447: the scope statuses whose seats count as held when a role definition is judged: every one
 * but `reaped` (whose storage is gone), a scope archived straight from `provisioning` included: it
 * can hold a seat (the platform's door seats into a provisioning scope), and unarchive brings it back.
 * Each adapter reads such a scope without creating storage it never had, and where it cannot, fails
 * closed. An archived scope comes back on unarchive with its seats, so
 * a definition judged without them would relabel those seats; both adapters read this one list.
 */
export const SEAT_HOLDING_SCOPE_STATUSES = ['provisioning', 'active', 'suspended', 'archiving', 'archived'] as const;

/** #2447: `SCOPE_SEATED_ROLES_SQL` for a tenant's tenant-level tuples. Parameters: tenantId, now. */
export const TENANT_SEATED_ROLES_SQL =
  "SELECT DISTINCT substr(relation, 6) AS role_key FROM _substrat_tenant_tuples WHERE tenant_id = ? AND relation LIKE 'role:%' AND subject NOT LIKE 'system:%' AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)";

/**
 * Why `permissions` may not be granted directly to a principal, an org or a connection, or null
 * (#2430): a raw grant (`HostAdmin.grant`, `grantToOrg`, `grantEntityShape`, `ctx.grant`) names a
 * person, or an org of people, and a connection grant (`grantToConnection`) names the external
 * provider that holds the connection's token. A system principal holds a reserved key through a
 * schedule's or a peer's `permissions`, or a role declared `holder: 'system'` (K-55), never through
 * such a grant, whoever makes it. A key no module registered on the host marks passes.
 */
export function reservedGrantRefusal(permissions: readonly string[], reserved: ReadonlySet<string>): string | null {
  const held = permissions.filter((p) => reserved.has(p));
  if (held.length === 0) return null;
  return `${held.join(', ')} cannot be granted to a principal, an org or a connection: reserved to a system principal (${RESERVED_BY})`;
}

/**
 * Why a reconcile of declared entity-grant shapes is refused, or null (#2430): a shape whose
 * `permissions` hold a reserved key. Every holder of a shape is a person given it on a record, and
 * the reconcile tops each holder up to the shape's keys and records what a binding link grants, so
 * such a shape would hand the key to people with no door asked. A key the shape only `retired` is
 * taken back, never given, and passes.
 */
export function reservedShapeRefusal(
  shapes: readonly { entityType: string; permissions: readonly string[] }[],
  reserved: ReadonlySet<string>,
): string | null {
  for (const shape of shapes) {
    const refusal = reservedGrantRefusal(shape.permissions, reserved);
    if (refusal) return `the entity grant shape on ${shape.entityType}: ${refusal}`;
  }
  return null;
}

/**
 * Where a host's reservations come from, as every refusal names it: the modules it registers, the
 * modules its declared `permissions` lists, and, at a Cloudflare scope node, the modules the scope's
 * own class registers.
 */
const RESERVED_BY = "a module this host registers or lists in its `permissions`, or one registered at the scope node, declares it `holder: 'system'`";

/**
 * Add what `manifest` reserves to a host's set — a union over every module it registers, and every
 * module its declared `permissions` lists (a manifest there with no permission list adds nothing).
 */
export function noteReservedKeys(reserved: Set<string>, manifest: DeclaredManifest): void {
  for (const key of reservedKeysOf([{ manifest: { id: manifest.id, permissions: manifest.permissions ?? [] } }]).keys()) reserved.add(key);
}

/** #2447: add every key `manifest` declares, marked or not, to a host's `declared` set (`HostReservations`). */
export function noteDeclaredKeys(declared: Set<string>, manifest: DeclaredManifest): void {
  for (const p of manifest.permissions ?? []) declared.add(p.key);
}

/** A manifest as far as a reservation and the declared-module check read it. */
export type DeclaredManifest = Omit<ReservedKeySource['manifest'], 'permissions'> & { permissions?: ReservedKeySource['manifest']['permissions'] };

/**
 * The permission surface a scope host may be given (#2430): the vertical's `definePermissions(...)`
 * value, the one `substrat push` and `lint:permissions` read. Its module ids are what registration
 * is held to, and what its manifests reserve joins what the registered ones reserve, so a module
 * registered under a listed id with different declarations cannot shed a reservation the list makes.
 */
export interface DeclaredPermissions {
  modules: readonly { manifest: DeclaredManifest }[];
}

/**
 * A host given its vertical's `permissions` refuses to register a module that list leaves out
 * (#2430). Every check `lint:permissions` and `substrat push` make reads that list, so a module
 * registered beside it (its keys, its roles' keys, its schedules, its reservations) is judged by
 * neither. The reverse, a listed module never registered, cannot be judged at registration time,
 * since modules register one at a time; a listed module is only read more strictly than it runs.
 */
export function assertModuleDeclared(permissions: DeclaredPermissions | undefined, moduleId: string): void {
  if (!permissions || permissions.modules.some((m) => m.manifest.id === moduleId)) return;
  throw new Error(
    `registerModule: ${moduleId} is not in this host's permission surface (the \`permissions\` it was given lists ` +
      `${permissions.modules.map((m) => m.manifest.id).join(', ') || 'no module'}). \`lint:permissions\` and ` +
      `\`substrat push\` read that list, so nothing this module declares would be judged. Add it to the ` +
      `\`modules\` given to definePermissions, the array this host registers.`,
  );
}
