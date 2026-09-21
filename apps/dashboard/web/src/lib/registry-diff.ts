/**
 * The version-to-version permission diff (#336), shared by the app's Permissions tab and
 * the promote dialog (#1677) — one diff, so what a person is shown before an update and
 * what they are shown before a promote can never disagree about what "changed" means.
 *
 * The shapes are stated structurally rather than imported from `./api`: this file is
 * compiled by the worker's test project too (`promote-review.test.ts` runs it), and `./api`
 * is DOM-typed. `PermissionRegistry` satisfies `RegistryLike`.
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
