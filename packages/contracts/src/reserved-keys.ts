/**
 * Keys no person may hold (#2425, #2430): the one reading of `holder: 'system'` on a manifest's
 * permission declaration, applied wherever a permission surface is judged. `lint:permissions`
 * (`tools/reserved-keys.mts`), `buildPermissionRegistry` and so `substrat push`, the push boundary
 * (`pushedPermissionRegistry`), and a scope host's role doors (the kernel's `reservedRoleRefusal`)
 * all call these, so none of them can read the mark differently.
 *
 * A vertical's person-facing surface is its `ROLES` and its `ENTITY_GRANTS` shapes (what a
 * principal is handed per entity). A module's SYSTEM principal is a different declaration:
 * `manifest.schedules[].permissions` (`system:<module>`) and `manifest.peers[].permissions`
 * (`vertical:<slug>`). So "a system-only key" needs no new concept in the surface: it may appear
 * in the second place and never in the first. The one role that may carry one is a role declared
 * `holder: 'system'` (K-55), and it may carry nothing else.
 *
 * This is NOT the purge-only notion of K-45 (`entity-trash.ts`): that scopes a key a system
 * principal already holds to one schedule's call. It says where a system principal may USE a key,
 * not that a person may not be given it.
 *
 * Pure and dependency-free, so `tools/` can load it from source.
 */

/** What the manifests say about a key reserved to a system principal. */
export interface ReservedKey {
  description: string;
  /** Every module that declares the key `holder: 'system'`, sorted. */
  declaredBy: string[];
}

/** The part of a module a reservation is read from: its manifest's id and permission declarations. */
export interface ReservedKeySource {
  manifest: {
    id: string;
    permissions: readonly { key: string; description: string; holder?: 'system' }[];
    /** What a fresh install's owner is granted on day one: a person's grant (#2430). */
    ownerGrants?: readonly string[];
  };
}

/**
 * Every key a manifest declares `holder: 'system'`.
 *
 * A union, not a vote: one module declaring the key reserved reserves it, whatever another module
 * declaring the same key says. Otherwise a vertical could lift an engine's reservation by
 * re-declaring the key, unmarked, in a module of its own.
 */
export function reservedKeysOf(modules: readonly ReservedKeySource[]): Map<string, ReservedKey> {
  const seen = new Map<string, { description: string; declaredBy: Set<string> }>();
  for (const m of modules) {
    for (const p of m.manifest.permissions) {
      if (p.holder !== 'system') continue;
      let key = seen.get(p.key);
      if (!key) seen.set(p.key, (key = { description: p.description, declaredBy: new Set() }));
      key.declaredBy.add(m.manifest.id);
    }
  }
  return new Map([...seen].map(([k, v]) => [k, { description: v.description, declaredBy: [...v.declaredBy].sort() }]));
}

export interface ReservedKeyOffence {
  /**
   * Where it was granted: `role <key>`, `system-held role <key>`, `grant shape on <entityType>`, or
   * a person grant's own name (`owner grants of <module>`, `owner grants (substrat.ownerGrants)`).
   */
  where: string;
  key: string;
  /** Set for a system-held role holding a key that is not reserved to a system principal. */
  notReserved?: true;
  /** Set for a system-held role that holds no reserved key at all. */
  empty?: true;
}

/** The surface a reservation is judged against: the roles, the entity grant shapes, and person grants. */
export interface ReservedKeySurface {
  roles: readonly { key: string; permissions: readonly string[]; holder?: 'person' | 'system' }[];
  grants: readonly { entityType: string; permissions: readonly string[] }[];
  /** #2430: keys a person is granted directly, each set named as the refusal names it (`ownerGrantSets`). */
  personGrants?: readonly { where: string; permissions: readonly string[] }[];
}

/**
 * #2430: the owner grants a vertical declares, as named person grants — each module manifest's
 * `ownerGrants` and, when given, the deployment's own `substrat.ownerGrants` (package.json). An
 * install grants them to its owner, a person, so a reserved key among them is a person's grant.
 */
export function ownerGrantSets(
  modules: readonly ReservedKeySource[],
  deployment?: readonly string[],
): { where: string; permissions: readonly string[] }[] {
  return [
    ...modules
      .filter((m) => m.manifest.ownerGrants?.length)
      .map((m) => ({ where: `owner grants of ${m.manifest.id}`, permissions: m.manifest.ownerGrants! })),
    ...(deployment?.length ? [{ where: 'owner grants (substrat.ownerGrants)', permissions: deployment }] : []),
  ];
}

/**
 * #2430: package.json `substrat.ownerGrants` as the owner-grant list `ownerGrantSets` takes, or why
 * it is not one. Absent is no owner grant; anything but an array of keys is a broken declaration,
 * refused rather than read as none, since what it means to grant is exactly what cannot be judged.
 */
export function declaredOwnerGrants(value: unknown): { grants: string[] } | { problem: string } {
  if (value === undefined) return { grants: [] };
  if (Array.isArray(value) && value.every((k): k is string => typeof k === 'string')) return { grants: value };
  return {
    problem:
      `declares \`substrat.ownerGrants\` as ${JSON.stringify(value)}, not an array of permission keys. List the keys a ` +
      'fresh install\'s owner is granted (`"ownerGrants": ["todo:list-create"]`), or leave the field out',
  };
}

/** Every person-facing grant of a reserved key, and every malformed system-held role, in surface order. */
export function reservedKeyOffences(surface: ReservedKeySurface, reserved: { has(key: string): boolean }): ReservedKeyOffence[] {
  const out: ReservedKeyOffence[] = [];
  for (const r of surface.roles) {
    // A system-held role that holds no reserved key is a standing principal granting nothing
    // today and widenable by editing only the permission list: refuse it as vacuous.
    if (r.holder === 'system' && !r.permissions.some((p) => reserved.has(p))) {
      out.push({ where: `system-held role ${r.key}`, key: '(none)', notReserved: true, empty: true });
    }
    for (const p of r.permissions) {
      // A system-held role (K-55) is the one role shape that may carry a reserved key. It may
      // carry NOTHING ELSE: a standing host principal's authority is exactly the keys reserved
      // to it, so a person-grade key slipped in beside them is an offence of its own.
      if (r.holder === 'system') {
        if (!reserved.has(p)) out.push({ where: `system-held role ${r.key}`, key: p, notReserved: true });
      } else if (reserved.has(p)) out.push({ where: `role ${r.key}`, key: p });
    }
  }
  for (const g of surface.grants) {
    for (const p of g.permissions) {
      if (reserved.has(p)) out.push({ where: `grant shape on ${g.entityType}`, key: p });
    }
  }
  for (const g of surface.personGrants ?? []) {
    for (const p of g.permissions) {
      if (reserved.has(p)) out.push({ where: g.where, key: p });
    }
  }
  return out;
}

/**
 * One offence on one line: where, which key, and why it is refused. `reserved` names the module
 * that marks the key; without it (the push boundary, which has only the registry's rows, whose
 * `declaredBy` lists every declarer, marked or not) the line attributes the mark to nobody.
 */
export function reservedKeyLine(o: ReservedKeyOffence, reserved?: ReadonlyMap<string, ReservedKey>): string {
  if (o.empty) return `${o.where} → ${o.key}: a system-held role must hold at least one key reserved to a system principal`;
  if (o.notReserved) {
    return `${o.where} → ${o.key}: a system-held role holds only keys reserved to a system principal (a key its module declares \`holder: 'system'\`)`;
  }
  const r = reserved?.get(o.key);
  return r
    ? `${o.where} → ${o.key}: declared \`holder: 'system'\` by ${r.declaredBy.join(', ')} (${r.description})`
    : `${o.where} → ${o.key}: reserved to a system principal (\`holder: 'system'\` on its registry row)`;
}

/** The refusal's text, naming the vertical, the file, each grant, who reserved the key and the remedy. */
export function reservedKeyMessage(
  rel: string,
  entry: string,
  offences: readonly ReservedKeyOffence[],
  reserved: ReadonlyMap<string, ReservedKey>,
): string {
  const person = offences.filter((o) => !o.notReserved);
  const system = offences.filter((o) => o.notReserved);
  const lines = (os: readonly ReservedKeyOffence[]) => os.map((o) => `    ${reservedKeyLine(o, reserved)}`).join('\n');
  const parts: string[] = [];
  if (person.length) {
    parts.push(
      `${rel}/${entry} grants a key reserved to a system principal to a person's role, grant shape or owner grant:\n` +
        lines(person) +
        `\n\n  Remedy: take the key out of the role, shape or owner grant. A module's own system principal gets it\n` +
        `  from a schedule's \`permissions\` (or a peer's); a platform host's standing principal gets it\n` +
        `  from a role declared \`holder: 'system'\` (K-55). Never from a role a person can hold.`,
    );
  }
  if (system.length) {
    parts.push(
      `${rel}/${entry} declares a system-held role that is not made of keys reserved to a system principal:\n` +
        lines(system) +
        `\n\n  Remedy: keep only reserved keys in a \`holder: 'system'\` role (and at least one), and move any\n` +
        `  person-grade key to a role a person can hold.`,
    );
  }
  return parts.join('\n\n');
}
