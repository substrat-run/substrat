/**
 * The version-to-version permission diff (#336), shared by the dashboard's Permissions tab,
 * its promote dialog, and `substrat promote`'s refusal (#1677) — one diff, so what a person is
 * shown before an update, before a promote, and at a terminal can never disagree about what
 * "changed" means. It moved here from the dashboard so the CLI reads the same one.
 *
 * The shapes are stated structurally: `PermissionRegistry` satisfies `RegistryLike`.
 */
export interface RegistryLike {
  /** #2430: `holder: 'system'` marks a key reserved to a system principal. */
  permissions: ReadonlyArray<{ key: string; description: string; holder?: 'system' }>;
  /** #2430: `holder: 'system'` marks a system-held role; `'person'` and absent are the same. */
  roles: ReadonlyArray<{ key: string; permissions: readonly string[]; holder?: 'person' | 'system' }>;
  entityGrants: ReadonlyArray<{
    entityType: string;
    permissions: readonly string[];
    bootstrap?: true;
    retired?: readonly string[];
    holder?: EntityGrantHolder;
    bind?: { permission: string };
  }>;
}

/** One grant shape of a {@link RegistryLike}. */
type EntityGrantShapeLike = RegistryLike['entityGrants'][number];

/** #2430: who a role is for, with an absent holder read as a person's. */
export type RoleHolder = 'person' | 'system';
const holderOf = (r: { holder?: 'person' | 'system' }): RoleHolder => (r.holder === 'system' ? 'system' : 'person');

/** How a bootstrap shape's holder is found from the data (`entityGrantShape.holder`), stated structurally. */
export type EntityGrantHolder = 'self' | 'grantee' | { table: string; idColumn: string; principalColumn: string };

export interface RegistryDiff {
  addedKeys: string[];
  removedKeys: string[];
  changedKeys: string[];
  /**
   * #2430: keys both versions declare whose reservation to a system principal moved — `reserved`
   * is what the incoming version says. A lifted reservation lets a person's role hold the key.
   */
  reservationChanges: Array<{ key: string; reserved: boolean }>;
  /** #2430: the `addedKeys` that arrive reserved to a system principal, which a reader marks. */
  reservedAddedKeys: string[];
  /**
   * Only roles that actually changed: gained/lost permissions, or appeared/vanished. #2430: `holder`
   * is set when a role both versions declare moved between a person's and a system principal's.
   */
  roleChanges: Array<{
    key: string;
    added: string[];
    removed: string[];
    isNew: boolean;
    isGone: boolean;
    holder?: { from: RoleHolder; to: RoleHolder };
  }>;
  /**
   * Entity-narrowed grant SHAPES that changed — which keys a per-entity grant may carry. #2082:
   * `retired` is the keys this version newly declares taken back from existing holders, and
   * `kept` the keys it drops from a bootstrap shape WITHOUT retiring them, which existing holders
   * keep. A sharing shape has no holders to keep or lose anything, so its `kept` is empty.
   */
  grantChanges: Array<{
    entityType: string;
    added: string[];
    removed: string[];
    retired: string[];
    kept: string[];
    /**
     * #1686: the shape's bind permission moved — `from`/`to` the key whose holders on a record
     * may bind its person with a link (null: the shape did not bind). Absent when unchanged.
     */
    bind?: { from: string | null; to: string | null };
    /**
     * #2178: where the shape's holder is read from moved — `from`/`to` as {@link holderLabel}
     * writes it (null: none declared). Absent when unchanged.
     */
    holder?: { from: string | null; to: string | null };
    isNew: boolean;
    isGone: boolean;
  }>;
}

/** The keys in `after` that `before` lacks — a list compared as a set, so order is no change. */
function gained(before: readonly string[] | undefined, after: readonly string[] | undefined): string[] {
  const had = new Set(before ?? []);
  return (after ?? []).filter((p) => !had.has(p));
}

/** A holder as one readable string: `'self'`, `'grantee'`, or `table.principalColumn (by idColumn)`. */
export function holderLabel(h: EntityGrantHolder | undefined): string | null {
  if (h === undefined) return null;
  return typeof h === 'string' ? h : `${h.table}.${h.principalColumn} (by ${h.idColumn})`;
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
  // #2430: a reservation moving on a key both versions declare. A key arriving or leaving is
  // already an added or removed key, and readers show its mark there.
  const reservedIn = (reg: RegistryLike) => new Set(reg.permissions.filter((p) => p.holder === 'system').map((p) => p.key));
  const fromReserved = reservedIn(from);
  const toReserved = reservedIn(to);
  const reservationChanges = [...toKeys.keys()]
    .filter((k) => fromKeys.has(k) && fromReserved.has(k) !== toReserved.has(k))
    .map((key) => ({ key, reserved: toReserved.has(key) }));
  const fromRoles = new Map(from.roles.map((r) => [r.key, r]));
  const toRoles = new Map(to.roles.map((r) => [r.key, r]));
  const roleChanges: RegistryDiff['roleChanges'] = [];
  for (const key of new Set([...fromRoles.keys(), ...toRoles.keys()])) {
    const before = fromRoles.get(key);
    const after = toRoles.get(key);
    const added = gained(before?.permissions, after?.permissions);
    const removed = gained(after?.permissions, before?.permissions);
    const isNew = !before && !!after;
    const isGone = !!before && !after;
    const holderMoved = !!before && !!after && holderOf(before) !== holderOf(after);
    if (added.length || removed.length || isNew || isGone || holderMoved) {
      roleChanges.push({
        key,
        added,
        removed,
        isNew,
        isGone,
        ...(holderMoved ? { holder: { from: holderOf(before!), to: holderOf(after!) } } : {}),
      });
    }
  }
  const fromGrants = new Map(from.entityGrants.map((g) => [g.entityType, g]));
  const toGrants = new Map(to.entityGrants.map((g) => [g.entityType, g]));
  const grantChanges: RegistryDiff['grantChanges'] = [];
  for (const entityType of new Set([...fromGrants.keys(), ...toGrants.keys()])) {
    const before = fromGrants.get(entityType);
    const after = toGrants.get(entityType);
    const added = gained(before?.permissions, after?.permissions);
    const removed = gained(after?.permissions, before?.permissions);
    const retired = gained(before?.retired, after?.retired);
    const bootstrap = !!(before?.bootstrap || after?.bootstrap);
    const kept = bootstrap ? removed.filter((k) => !(after?.retired ?? []).includes(k)) : [];
    const isNew = !before && !!after;
    const isGone = !!before && !after;
    const bindFrom = before?.bind?.permission ?? null;
    const bindTo = after?.bind?.permission ?? null;
    const bindChanged = bindFrom !== bindTo;
    // A shape appearing or vanishing is said by `isNew`/`isGone`; its holder moves only between two.
    const holderFrom = holderLabel(before?.holder);
    const holderTo = holderLabel(after?.holder);
    const holderChanged = !!before && !!after && holderFrom !== holderTo;
    if (added.length || removed.length || retired.length || isNew || isGone || bindChanged || holderChanged) {
      grantChanges.push({
        entityType,
        added,
        removed,
        retired,
        kept,
        ...(bindChanged ? { bind: { from: bindFrom, to: bindTo } } : {}),
        ...(holderChanged ? { holder: { from: holderFrom, to: holderTo } } : {}),
        isNew,
        isGone,
      });
    }
  }
  const addedKeys = [...toKeys.keys()].filter((k) => !fromKeys.has(k));
  return {
    addedKeys,
    removedKeys: [...fromKeys.keys()].filter((k) => !toKeys.has(k)),
    changedKeys: [...toKeys.entries()].filter(([k, d]) => fromKeys.has(k) && fromKeys.get(k) !== d).map(([k]) => k),
    reservationChanges,
    reservedAddedKeys: addedKeys.filter((k) => toReserved.has(k)),
    roleChanges,
    grantChanges,
  };
}

/**
 * #2430: a moved reservation or role holder as one sentence each, for every reader of the diff to
 * show as written, as {@link grantShapeHolderNotes} does for a grant shape.
 */
export function reservationNote(c: RegistryDiff['reservationChanges'][number]): string {
  return c.reserved
    ? `${c.key} is now reserved to a system principal: no person's role or grant shape may hold it`
    : `${c.key} is no longer reserved to a system principal: a person's role may now hold it`;
}

/** #2430: how a reader marks an added key that arrives reserved (`reservedAddedKeys`). */
export const RESERVED_KEY_MARK = 'reserved to a system principal';

/** The sentence for a role whose holder moved, or null when it did not. */
export function roleHolderNote(r: Pick<RegistryDiff['roleChanges'][number], 'holder'>): string | null {
  if (!r.holder) return null;
  return r.holder.to === 'system'
    ? 'now held by a system principal (holder: system), no longer a role a person can hold'
    : 'now a role a person can hold, no longer held by a system principal';
}

/**
 * #2082: what a grant-shape change does to the people who ALREADY hold the shape, one sentence
 * per key, for every reader of the diff to show as written. A key retired is taken from every
 * holder — and one tuple is one authority, so a direct grant of it on the same entity goes too.
 * A key dropped without being retired stays with them: the reconcile takes back only what a
 * version declares retired.
 */
export function grantShapeHolderNotes(g: Pick<RegistryDiff['grantChanges'][number], 'retired' | 'kept' | 'bind' | 'holder'>): string[] {
  return [
    ...g.retired.map((k) => `existing holders lose ${k}, including any direct grant of ${k} on the same entity`),
    ...g.kept.map((k) => `existing holders keep ${k}: dropped from the shape but not retired`),
    // #1686: who may hand the shape out — a binding invite — is part of what a shape confers.
    ...(g.bind?.to ? [`whoever holds ${g.bind.to} on a record may bind its person to it with a link`] : []),
    ...(g.bind?.from && !g.bind.to ? [`links may no longer bind a person to a record (was ${g.bind.from})`] : []),
    // #2178: existing holders are not moved with it — they were found where the shape used to say.
    ...(g.holder ? [`holders are now read from ${g.holder.to ?? 'nowhere'} (was ${g.holder.from ?? 'nowhere'}); existing holders are not moved`] : []),
  ];
}

/**
 * #2178: one binding shape a version would leave its bound people holding with no lever left —
 * the gate's unit. People a link bound keep the shape until they are released (#1686): an unbind
 * needs the shape to still bind, an erasure finds them through the holder the scope recorded, and
 * a retirement needs the shape to still be a bootstrap shape. So a version that serves where one
 * binds may not:
 *
 * - `removed`: drop the shape;
 * - `holder`: read its holder from another table or column (the people bound through the old one
 *   are not moved, and the scope's record of where they are is replaced);
 * - `sharing`: keep it, but no longer as a bootstrap shape, which `retired` cannot be declared on;
 * - `kept`: keep it, but drop a key from `permissions` without listing it in `retired`. Bound
 *   people keep that key (`grantShapeHolderNotes`' "existing holders keep"), and a later version
 *   that retires the rest and drops the shape would never have to name it.
 *
 * — unless it retires every key the shape carried (`unretired` is what it does not). A shape with
 * no current key binds nothing to anyone, which is how a retirement makes the drop allowed: keep
 * the shape with `permissions: []` and the keys in `retired`, then drop it in a later version.
 * Dropping only `bind` is not one of these: the holder stays recorded and a retirement stays possible.
 *
 * #2184: a shape binds where its registry says `bind`, and ALSO where a scope has bound people
 * through it (`boundEver`, the types an install's reconcile reported from its sticky `shape-bound`
 * records) while it is still a bootstrap shape with a table holder ({@link mayHoldBound}): a version
 * that drops only `bind` leaves the people bound, so a later one may not strand them either.
 */
export interface BindingShapeBreak {
  entityType: string;
  change: 'removed' | 'holder' | 'sharing' | 'kept';
  /** The keys of the outgoing shape the incoming version does not retire: what bound people keep. */
  unretired: string[];
}

/**
 * #2184: a shape that can hold people a link bound: a bootstrap shape whose holder is a table
 * column. Only such a shape is ever bound (the kernel's reconcile records a binding for no other),
 * and a type that once bound and is now declared another way holds nobody through a link.
 */
export function mayHoldBound(shape: Pick<EntityGrantShapeLike, 'bootstrap' | 'holder'>): boolean {
  return !!shape.bootstrap && typeof shape.holder === 'object';
}

/**
 * Every binding shape `from` binds with that `to` would strand (see {@link BindingShapeBreak}).
 * `boundEver` (#2184): the types the judged scopes have bound, or `'unknown'` when they did not say,
 * which counts every shape that {@link mayHoldBound} as bound. Omitted: the registry's `bind` alone.
 */
export function bindingShapeBreaks(
  from: Pick<RegistryLike, 'entityGrants'>,
  to: Pick<RegistryLike, 'entityGrants'>,
  boundEver: readonly string[] | 'unknown' = [],
): BindingShapeBreak[] {
  const toGrants = new Map(to.entityGrants.map((g) => [g.entityType, g]));
  const breaks: BindingShapeBreak[] = [];
  const bound = (g: EntityGrantShapeLike) =>
    !!g.bind || (mayHoldBound(g) && (boundEver === 'unknown' || boundEver.includes(g.entityType)));
  for (const before of from.entityGrants) {
    if (!bound(before) || before.permissions.length === 0) continue;
    const after = toGrants.get(before.entityType);
    const change = !after ? 'removed' : !after.bootstrap ? 'sharing' : holderLabel(after.holder) !== holderLabel(before.holder) ? 'holder' : 'kept';
    // A shape kept where it was strands only the keys it drops; any other change, every key.
    const still = new Set(change === 'kept' ? after!.permissions : []);
    const retired = new Set(after?.retired ?? []);
    const unretired = before.permissions.filter((k) => !still.has(k) && !retired.has(k));
    if (unretired.length > 0) breaks.push({ entityType: before.entityType, change, unretired });
  }
  return breaks;
}

/** How {@link bindingShapeRefusal} begins: what a reader of the refusal recognises it by. */
export const BINDING_SHAPE_REFUSAL = 'this version would strand people bound to';

const BREAK_WORDS: Record<BindingShapeBreak['change'], string> = {
  removed: 'drops the shape',
  holder: 'reads its holder from elsewhere',
  sharing: 'makes it a sharing shape',
  kept: 'drops keys from it without retiring them',
};

/**
 * The refusal for a non-empty {@link bindingShapeBreaks}. No acknowledgement answers it: the way
 * through is the retirement, which is what takes the keys back from the people it strands.
 */
export function bindingShapeRefusal(breaks: readonly BindingShapeBreak[]): string {
  const each = breaks.map((b) => `${b.entityType} (${BREAK_WORDS[b.change]}; bound people keep ${b.unretired.join(', ')})`);
  return (
    `${BINDING_SHAPE_REFUSAL} ${each.join(', ')}. Retire those keys first: keep the shape with the keys ` +
    'in `retired` and none of them in `permissions`, then drop or move it in a later version. A ' +
    'version from before the shape existed (a rollback) is refused the same way, and no ' +
    'acknowledgement passes it: retire the keys in a new version instead. A retirement reaches an ' +
    'install only when it reconciles the retiring version, so the drop stays refused until every ' +
    'install it would move has'
  );
}

/** Whether the diff holds anything at all — a key, a role or a grant shape moved. */
export function hasRegistryChange(d: RegistryDiff): boolean {
  return (
    d.addedKeys.length > 0 ||
    d.removedKeys.length > 0 ||
    d.changedKeys.length > 0 ||
    d.reservationChanges.length > 0 ||
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
  // #2430: a lifted reservation widens who may hold a key, and a new one narrows it.
  const adds =
    d.addedKeys.length > 0 ||
    d.reservationChanges.some((c) => !c.reserved) ||
    d.roleChanges.some((r) => r.isNew || r.added.length > 0) ||
    d.grantChanges.some((g) => g.isNew || g.added.length > 0 || !!g.bind?.to);
  const removes =
    d.removedKeys.length > 0 ||
    d.reservationChanges.some((c) => c.reserved) ||
    d.roleChanges.some((r) => r.isGone || r.removed.length > 0) ||
    d.grantChanges.some((g) => g.isGone || g.removed.length > 0 || g.retired.length > 0 || !!g.bind?.from);
  // A description re-worded, or a holder moved (a grant shape's or a role's), is a change that is
  // neither: it keeps a diff from being "only".
  const other = d.changedKeys.length > 0 || d.grantChanges.some((g) => !!g.holder) || d.roleChanges.some((r) => !!r.holder);
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
    permissions: diff.addedKeys.length + diff.removedKeys.length + diff.changedKeys.length + diff.reservationChanges.length > 0,
    roles: diff.roleChanges.length > 0,
    entityGrants: diff.grantChanges.length > 0,
  };
  const fields = [...new Set([...Object.keys(from), ...Object.keys(to)])].sort();
  return fields.filter((f) => !itemised[f] && canonical(from[f]) !== canonical(to[f]));
}
