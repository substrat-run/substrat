/**
 * The version-to-version permission diff (#336), shared by the dashboard's Permissions tab,
 * its promote dialog, and `substrat promote`'s refusal (#1677) — one diff, so what a person is
 * shown before an update, before a promote, and at a terminal can never disagree about what
 * "changed" means. It moved here from the dashboard so the CLI reads the same one.
 *
 * The shapes are stated structurally: `PermissionRegistry` satisfies `RegistryLike`.
 */
export interface RegistryLike {
  permissions: ReadonlyArray<{ key: string; description: string }>;
  roles: ReadonlyArray<{ key: string; permissions: readonly string[] }>;
  entityGrants: ReadonlyArray<{ entityType: string; permissions: readonly string[] }>;
}

export interface RegistryDiff {
  addedKeys: string[];
  removedKeys: string[];
  changedKeys: string[];
  /** Only roles that actually changed: gained/lost permissions, or appeared/vanished. */
  roleChanges: Array<{ key: string; added: string[]; removed: string[]; isNew: boolean; isGone: boolean }>;
  /** Entity-narrowed grant SHAPES that changed — which keys a per-entity grant may carry. */
  grantChanges: Array<{ entityType: string; added: string[]; removed: string[]; isNew: boolean; isGone: boolean }>;
}

/** The keys in `after` that `before` lacks — a list compared as a set, so order is no change. */
function gained(before: readonly string[] | undefined, after: readonly string[] | undefined): string[] {
  const had = new Set(before ?? []);
  return (after ?? []).filter((p) => !had.has(p));
}

/**
 * What the declared surface would gain, lose, or re-describe going from `from` to `to`. The
 * security-relevant signal is a WIDENED role (one that gains permissions), a genuinely new
 * permission key or a wider grant shape — the reasons the promotion checkpoint asks a human
 * to look before an update lands.
 */
export function diffRegistries(from: RegistryLike, to: RegistryLike): RegistryDiff {
  const fromKeys = new Map(from.permissions.map((p) => [p.key, p.description]));
  const toKeys = new Map(to.permissions.map((p) => [p.key, p.description]));
  const fromRoles = new Map(from.roles.map((r) => [r.key, r.permissions]));
  const toRoles = new Map(to.roles.map((r) => [r.key, r.permissions]));
  const roleChanges: RegistryDiff['roleChanges'] = [];
  for (const key of new Set([...fromRoles.keys(), ...toRoles.keys()])) {
    const before = fromRoles.get(key);
    const after = toRoles.get(key);
    const added = gained(before, after);
    const removed = gained(after, before);
    const isNew = !before && !!after;
    const isGone = !!before && !after;
    if (added.length || removed.length || isNew || isGone) roleChanges.push({ key, added, removed, isNew, isGone });
  }
  const fromGrants = new Map(from.entityGrants.map((g) => [g.entityType, g.permissions]));
  const toGrants = new Map(to.entityGrants.map((g) => [g.entityType, g.permissions]));
  const grantChanges: RegistryDiff['grantChanges'] = [];
  for (const entityType of new Set([...fromGrants.keys(), ...toGrants.keys()])) {
    const before = fromGrants.get(entityType);
    const after = toGrants.get(entityType);
    const added = gained(before, after);
    const removed = gained(after, before);
    const isNew = !before && !!after;
    const isGone = !!before && !after;
    if (added.length || removed.length || isNew || isGone) grantChanges.push({ entityType, added, removed, isNew, isGone });
  }
  return {
    addedKeys: [...toKeys.keys()].filter((k) => !fromKeys.has(k)),
    removedKeys: [...fromKeys.keys()].filter((k) => !toKeys.has(k)),
    changedKeys: [...toKeys.entries()].filter(([k, d]) => fromKeys.has(k) && fromKeys.get(k) !== d).map(([k]) => k),
    roleChanges,
    grantChanges,
  };
}

/** Whether the diff holds anything at all — a key, a role or a grant shape moved. */
export function hasRegistryChange(d: RegistryDiff): boolean {
  return (
    d.addedKeys.length > 0 ||
    d.removedKeys.length > 0 ||
    d.changedKeys.length > 0 ||
    d.roleChanges.length > 0 ||
    d.grantChanges.length > 0
  );
}

/**
 * Which way a change points, for the sentence that says it plainly. `adds` and `removes` are
 * claims that EVERYTHING in the diff goes that way: a role that gains one key and loses
 * another, or a re-worded description beside a new key, is `mixed`, never rounded to a side.
 */
export type RegistryDirection = 'none' | 'adds' | 'removes' | 'mixed';

export function registryDirection(d: RegistryDiff): RegistryDirection {
  const adds =
    d.addedKeys.length > 0 ||
    d.roleChanges.some((r) => r.isNew || r.added.length > 0) ||
    d.grantChanges.some((g) => g.isNew || g.added.length > 0);
  const removes =
    d.removedKeys.length > 0 ||
    d.roleChanges.some((r) => r.isGone || r.removed.length > 0) ||
    d.grantChanges.some((g) => g.isGone || g.removed.length > 0);
  // A description re-worded is a change that is neither: it keeps a diff from being "only".
  const other = d.changedKeys.length > 0;
  if (!hasRegistryChange(d)) return 'none';
  if (adds && !removes && !other) return 'adds';
  if (removes && !adds && !other) return 'removes';
  return 'mixed';
}

/** A value with object keys sorted, so two registries compare by content, not by key order. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

/**
 * The registry fields that differ between two versions while `diffRegistries` itemises nothing
 * for them (#1677). The permission digest hashes the whole registry, so it moves for changes the
 * diff does not list: an export or import (#1705), which module declares a key, a role's
 * `source`. A reader that printed only the diff would show a real change as "none"; this is
 * what it names instead.
 */
export function unitemisedRegistryChanges(
  from: RegistryLike & Record<string, unknown>,
  to: RegistryLike & Record<string, unknown>,
  diff: RegistryDiff = diffRegistries(from, to),
): string[] {
  const itemised: Record<string, boolean> = {
    permissions: diff.addedKeys.length + diff.removedKeys.length + diff.changedKeys.length > 0,
    roles: diff.roleChanges.length > 0,
    entityGrants: diff.grantChanges.length > 0,
  };
  const fields = [...new Set([...Object.keys(from), ...Object.keys(to)])].sort();
  return fields.filter((f) => !itemised[f] && canonical(from[f]) !== canonical(to[f]));
}
