import { reservedKeysOf, type ModuleManifest } from '@substrat-run/contracts';

/**
 * The runtime half of a key reserved to a system principal (#2430, K-55), shared by both adapters
 * so they cannot refuse differently: the doors that confer a role refuse one that would hand a
 * person such a key.
 *
 * The reservation is read off the modules REGISTERED on the host (`holder: 'system'` on a manifest
 * permission entry, the union rule of `reservedKeysOf`), not off a list a push carried. It judges
 * the composition that actually runs, needs nothing delivered, and has no version skew: a key no
 * registered module marks is a person's key, so nothing an older engine declared is refused.
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
      `role '${role.key}' cannot be given to a person: it holds ${keys}, reserved to a system principal ` +
      `(a module this host registers declares it \`holder: 'system'\`)`
    );
  }
  const others = role.permissions.filter((p) => !reserved.has(p));
  if (others.length === 0) return null;
  return (
    `role '${role.key}' holds ${keys}, reserved to a system principal, beside ${others.join(', ')}: a role carries ` +
    `a reserved key only when every key it holds is one (a system-held role, K-55)`
  );
}

/** Add what `manifest` reserves to a host's set — a union over every module it registers. */
export function noteReservedKeys(reserved: Set<string>, manifest: Pick<ModuleManifest, 'id' | 'permissions'>): void {
  for (const key of reservedKeysOf([{ manifest }]).keys()) reserved.add(key);
}

/**
 * The permission surface a scope host may be given (#2430): the vertical's `definePermissions(...)`
 * value, the one `substrat push` and `lint:permissions` read. Only its module ids are read here.
 */
export interface DeclaredPermissions {
  modules: readonly { manifest: { id: string } }[];
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
