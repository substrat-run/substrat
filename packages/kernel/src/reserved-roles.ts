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
 *   admitted. That is the shape a system-held role has, and a stored role does not record its
 *   holder, so here it cannot be told from a person's role made the same way (K-55's residual).
 *
 * Never asked on a provisioning seat or the owner hand-over, and nothing already held is revoked:
 * a seat that exists keeps working whatever a later engine declares.
 *
 * The person's refusal is also `canAssign`'s, which is the bound on taking a role away as well as
 * on giving it, so it is worded for both: no person's bound covers such a role.
 */
export function reservedRoleRefusal(
  role: { key: string; permissions: readonly string[] },
  reserved: ReadonlySet<string>,
  door: 'person' | 'platform',
): string | null {
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
  if (others.length === 0) return null;
  return (
    `role '${role.key}' holds ${keys}, reserved to a system principal, beside ${others.join(', ')}: a role carries ` +
    `a reserved key only when every key it holds is one (a system-held role, K-55)`
  );
}

/**
 * Why `permissions` may not be granted directly to a principal or an org, or null (#2430): a raw
 * grant (`HostAdmin.grant`, `grantToOrg`, `grantEntityShape`, `ctx.grant`) names a person, or an
 * org of people. A system principal holds a reserved key through a schedule's or a peer's
 * `permissions`, or a role declared `holder: 'system'` (K-55), never through such a grant, whoever
 * makes it. A key no module registered on the host marks is a person's key, and passes.
 */
export function reservedGrantRefusal(permissions: readonly string[], reserved: ReadonlySet<string>): string | null {
  const held = permissions.filter((p) => reserved.has(p));
  if (held.length === 0) return null;
  return `${held.join(', ')} cannot be granted to a principal or an org: reserved to a system principal (${RESERVED_BY})`;
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
