/**
 * The pure half of the conformance kit: what CAN be driven, and what cannot.
 *
 * Split out of `entity-check-suite.ts` so the classification is reachable
 * without a test runner (#866). The suite next door imports `vitest` at module
 * load, which makes it unimportable outside vitest — and the trust-page emitter
 * (`tools/conformance-emit.mts`) needs exactly this partition and none of the
 * assertions. The suite's own note already said why this belongs on its own:
 * *"Exported and pure so the classification is testable on its own. It is the
 * part that decides what counts as covered, and a bug here is invisible in the
 * worst way."*
 *
 * Nothing here imports a runner, a host or a filesystem. It reads a declared
 * operation set and returns two lists.
 */
import type { EntityRef } from '@substrat-run/contracts';

/** What a vertical supplies so the kit can drive its operations. */
export interface EntityCheckFixture {
  /**
   * Create one entity of this declared type and return its id.
   *
   * Called for each case, so every case gets a world nobody else has touched —
   * the operation under test may well delete the thing it is given.
   */
  createEntity(entityType: string): Promise<string>;
  /**
   * Grant `permission` to the probe principal, narrowed to exactly this entity.
   *
   * Deliberately NOT the vertical's own sharing operation: using `share-list` to
   * set up the test for `share-list` would prove only that it agrees with
   * itself. Reach for the admin grant.
   */
  grantOnEntity(permission: string, entity: EntityRef): Promise<void>;
  /** Invoke as the probe principal — the one holding only narrowed grants. */
  invoke(operation: string, input: Record<string, unknown>): Promise<unknown>;
  /**
   * Is this error a permission denial? Defaults to `PermissionDenied`, which is
   * what a stub throws; a fixture driving HTTP would test for its 403 instead.
   */
  isDenial?(error: unknown): boolean;
}

export interface EntityCheckSuiteOptions {
  /**
   * Extra input fields per operation, beyond the entity id the kit supplies.
   *
   * Only needed where the operation's schema has REQUIRED fields besides the id
   * — the kit reads the schema to find out, so an operation taking nothing but
   * an id needs no entry here.
   */
  readonly inputs?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /**
   * Permissions an operation needs BEYOND the one it declares, granted on the
   * same target entity — with the reason it needs them.
   *
   * The first vertical this kit ran against produced one immediately.
   * `todo/share-list` declares `list:manage` and honours it, then calls
   * `ctx.grant` to hand `list:contribute` to the invitee — and delegation only
   * works for a permission the caller HOLDS. A principal granted `list:manage`
   * alone is refused, correctly, by the second gate.
   *
   * So an operation's declared permission is the gate it opens with, not
   * necessarily the whole authority it exercises. That gap is invisible in
   * production here only because todo's bootstrap grant hands every owner both
   * keys on their own entity, so nobody ever holds one without the other.
   *
   * `because` is required rather than a comment: this is the one place the gap
   * gets written down, and an entry without a reason is indistinguishable from
   * someone widening the grant until the test went green.
   */
  readonly alsoGrant?: Readonly<
    Record<string, { readonly permissions: readonly string[]; readonly because: string }>
  >;
  /**
   * Input fields that must carry a SECOND entity the kit makes, per operation
   * (#939): `{ 'ticket0/merge': { intoConversationId: 'conversation' } }`.
   *
   * `merge` folds `conversationId` into `intoConversationId` and checks the
   * declared key on both ends. A sample value in `inputs` cannot stand in for the
   * second one: a made-up id is refused before the check under test answers, and
   * an id minted once at collect time is granted to nobody — so case 1 is denied
   * on the survivor and reads as a broken handler. What the field needs is an
   * entity that EXISTS, fresh per case, that the probe holds the key on.
   *
   * So the kit creates it the way it creates the target — `createEntity(type)`,
   * per case — and grants the same keys on it, in BOTH cases. Case 2 still
   * separates: the probe holds the key on the co-entity and on A, and is refused
   * for B. The bare id is written into the field; a field taking a whole ref is
   * not this shape.
   *
   * What this does NOT assert, stated so the receipt cannot overclaim: that the
   * handler checks the co-entity at all. The pair measures the declared check on
   * the TARGET; a second check on the co-entity is the operation's own claim,
   * asserted where its scenario is written.
   */
  readonly coEntities?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /**
   * The in-scope operations this kit cannot generate, each with its reason.
   *
   * Asserted EXACTLY: an operation that becomes uncoverable, or one that stops
   * being, fails until this list is updated. That is the point — it is the
   * coverage gap made reviewable rather than invisible.
   */
  readonly uncovered?: Readonly<Record<string, string>>;
  /**
   * The entity type to drive a `refFrom` check with (#896).
   *
   * An engine narrowing to a ref the caller supplies whole has no type of its own
   * to name — that is the shape, not a gap in it. So the HARNESS names one and
   * `createEntity` makes it. Which type is deliberately not the engine's
   * business: an engine promising to honour whatever noun it is handed should not
   * care which one a test picked, and if it does care, that is the finding.
   *
   * Needed only where the operation set holds a `refFrom` check. Without it those
   * operations are reported as uncovered — never silently skipped.
   */
  readonly refEntityType?: string;
}

interface DeclaredCheck {
  readonly key: string;
  /** One fixed type… */
  readonly entity?: string;
  /** …or the input field naming it, whose schema bounds the set (#890). */
  readonly entityFrom?: string;
  /** …or the field carrying the whole ref, type included (#896). */
  readonly refFrom?: string;
  readonly idFrom?: string;
  readonly resolved?: string;
}

interface DeclaredOp {
  readonly permission?: string | DeclaredCheck;
  readonly input?: { readonly shape?: Record<string, unknown> };
}

/** An operation declaring an entity-narrowed check — the ones in scope here. */
function entityCheckOf(op: DeclaredOp): DeclaredCheck | undefined {
  const permission = op.permission;
  if (!permission || typeof permission === 'string') return undefined;
  return permission.entity || permission.entityFrom || permission.refFrom ? permission : undefined;
}

/**
 * The values a schema admits, when it admits a knowable few.
 *
 * `z.literal('workorder')` and `z.literal(['workorder', 'protocol'])` publish a
 * `values` Set; `z.enum([…])` publishes `options`. An open `z.string()` publishes
 * neither, and that is the answer the caller needs — not a guess.
 */
function admissibleValues(schema: unknown): unknown[] | undefined {
  const values = (schema as { values?: unknown }).values;
  if (values instanceof Set) return [...values];
  const options = (schema as { options?: unknown }).options;
  if (Array.isArray(options)) return options;
  return undefined;
}

/**
 * The fields whose value the SCHEMA already fixes — one admissible value each.
 *
 * #890. A timeline operation declares `entity: 'workorder'` and takes
 * `entityType: z.literal('workorder')`, so the fixture used to be handed
 * `{ entityType: 'workorder' }` by hand: the same constant written twice, in two
 * files, with nothing holding them together. Written as `'customer'` by mistake
 * and case 1 fails claiming the handler checks the node — a false accusation
 * against correct code, which is the kind of red that gets a suite disabled.
 *
 * So the kit reads the constant instead of being told it. A literal with more
 * than one admissible value is deliberately NOT read: driving it means driving
 * once per value, which is a different feature, and `.value` throws there rather
 * than picking one.
 */
function fixedFields(op: DeclaredOp, idField: string): Record<string, unknown> {
  const shape = op.input?.shape;
  if (!shape) return {};
  const fixed: Record<string, unknown> = {};
  for (const [field, schema] of Object.entries(shape)) {
    if (field === idField) continue;
    const values = admissibleValues(schema);
    if (values?.length === 1) fixed[field] = values[0];
  }
  return fixed;
}

/**
 * The input fields an operation REQUIRES, beyond the one carrying the entity id.
 *
 * Read off the schema rather than asked for: an operation taking only an id
 * needs no fixture entry, and one that needs more says so precisely instead of
 * failing later as a validation error the reader has to decode.
 *
 * A field the schema fixes to one value is not one of them, nor is the type field
 * an `entityFrom` check names — the kit supplies both, so demanding a sample
 * input for either would report a gap that is not there.
 */
function requiredExtras(op: DeclaredOp, idField: string, supplied: string[] = []): string[] {
  const shape = op.input?.shape;
  if (!shape) return [];
  const kitSupplies = new Set([idField, ...supplied, ...Object.keys(fixedFields(op, idField))]);
  return Object.entries(shape)
    .filter(([field]) => !kitSupplies.has(field))
    .filter(([, schema]) => {
      const parse = (schema as { safeParse?: (v: unknown) => { success: boolean } }).safeParse;
      // No `safeParse` means we cannot tell — treat it as required, because
      // guessing "optional" is the answer that silently drops the operation.
      return typeof parse !== 'function' || !parse.call(schema, undefined).success;
    })
    .map(([field]) => field);
}

/** One operation the kit can drive, with the declaration it was read from. */
export interface PlannedCheck {
  readonly name: string;
  readonly key: string;
  readonly entity: string;
  /**
   * Where the kit writes the target into the input.
   *
   * `{ kind: 'id' }` writes the bare id at `path` — the `idFrom` case. `{ kind:
   * 'ref' }` writes the whole `{ entityType, entityId }` there instead, which is
   * the `refFrom` case (#896); `path` may then be two segments, for a ref that
   * travels inside a larger object.
   */
  readonly target: { readonly kind: 'id' | 'ref'; readonly path: readonly string[] };
  /** Input fields the schema fixes to one value, supplied by the kit (#890). */
  readonly fixed: Record<string, unknown>;
  /**
   * Input fields the kit fills with a second entity it makes and grants on, by
   * declared type (#939). Empty for every operation that names none.
   */
  readonly coEntities: Readonly<Record<string, string>>;
}

/**
 * Partition an operation set into what this kit can drive and what it cannot.
 *
 * Exported and pure so the classification is testable on its own. It is the part
 * that decides what counts as covered, and a bug here is invisible in the worst
 * way — it would drop an operation from the suite while every remaining test
 * still passed.
 *
 * Out of scope entirely (neither covered nor uncovered): an operation with a
 * bare-key node check, or one declaring `narrows`. Neither claims an entity
 * check, so neither has one to honour.
 *
 * An `entityFrom` operation appears ONCE PER ADMISSIBLE TYPE (#890) — the pair is
 * what tells a correct check from a node check, and it is worth no less for the
 * second type than for the first. So `callout/timeline` is driven twice, over a
 * work order and over a protocol, and a handler that honoured the check for one
 * and not the other has nowhere left to hide.
 */
export function planEntityCheckCoverage(
  operations: Readonly<Record<string, object>>,
  inputs: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {},
  refEntityType?: string,
  coEntities: Readonly<Record<string, Readonly<Record<string, string>>>> = {},
): { covered: PlannedCheck[]; uncovered: Record<string, string> } {
  const covered: PlannedCheck[] = [];
  const uncovered: Record<string, string> = {};

  for (const [name, raw] of Object.entries(operations).sort(([a], [b]) => a.localeCompare(b))) {
    const op = raw as DeclaredOp;
    const check = entityCheckOf(op);
    if (!check) continue;

    // A co-entity (#939) is supplied by the kit, so its field is never a missing
    // sample — but only where the field exists, and is not the target's own. A
    // declaration naming a field the schema does not have is a stale note, and a
    // stale note that quietly counted as coverage would be the overclaim this
    // whole partition exists to avoid.
    const co = coEntities[name] ?? {};
    const targetField = check.refFrom ? check.refFrom.split('.')[0]! : check.idFrom;
    const misnamed = Object.keys(co).filter(
      (field) => field === targetField || !(field in (op.input?.shape ?? {})),
    );
    if (misnamed.length > 0) {
      uncovered[name] =
        `names a co-entity for '${misnamed.join("', '")}', which is not an input field ` +
        'beside the target';
      continue;
    }
    const coFields = Object.keys(co);

    // The ref case first: it names neither a type nor an id field, because the
    // field it names carries both (#896).
    if (check.refFrom) {
      const path = check.refFrom.split('.');
      if (!refEntityType) {
        uncovered[name] =
          `declares 'refFrom: ${check.refFrom}' and the suite named no 'refEntityType' — the ` +
          'check narrows to a type this module cannot know, so the harness has to say which ' +
          'one it can create';
        continue;
      }
      if (!(path[0]! in (op.input?.shape ?? {}))) {
        uncovered[name] = `declares 'refFrom: ${check.refFrom}', which names no input field`;
        continue;
      }
      const missing = requiredExtras(op, '', [path[0]!, ...coFields]).filter(
        (f) => inputs[name]?.[f] === undefined,
      );
      if (missing.length > 0) {
        uncovered[name] = `no sample input for required field(s): ${missing.join(', ')}`;
        continue;
      }
      covered.push({
        name,
        key: check.key,
        entity: refEntityType,
        target: { kind: 'ref', path },
        fixed: fixedFields(op, path[0]!),
        coEntities: co,
      });
      continue;
    }

    if (!check.idFrom) {
      uncovered[name] =
        `declares 'resolved' (${check.resolved ?? 'no reason given'}) — the entity id is not ` +
        'in the input, so the harness cannot reach the entity';
      continue;
    }

    // One fixed type, or the several the type field's schema admits (#890). An
    // `entityFrom` pointing at a field that enumerates nothing is a gap with a
    // name: the kit will not invent a type, because driving one arm of an
    // operation and reporting the operation covered is the overclaim this whole
    // suite exists to avoid.
    let types: unknown[];
    if (check.entity) {
      types = [check.entity];
    } else {
      const field = check.entityFrom as string;
      const values = admissibleValues(op.input?.shape?.[field]);
      if (!values || values.length === 0) {
        uncovered[name] =
          `declares 'entityFrom: ${field}', whose schema does not enumerate the types it ` +
          'admits — the kit cannot know which entity to create, and will not guess one';
        continue;
      }
      types = values;
    }

    const typeField = check.entityFrom ? [check.entityFrom] : [];
    const missing = requiredExtras(op, check.idFrom, [...typeField, ...coFields]).filter(
      (f) => inputs[name]?.[f] === undefined,
    );
    if (missing.length > 0) {
      uncovered[name] = `no sample input for required field(s): ${missing.join(', ')}`;
      continue;
    }

    for (const type of types) {
      covered.push({
        name,
        key: check.key,
        entity: String(type),
        target: { kind: 'id', path: [check.idFrom] },
        fixed: {
          ...fixedFields(op, check.idFrom),
          ...(check.entityFrom ? { [check.entityFrom]: type } : {}),
        },
        coEntities: co,
      });
    }
  }

  return { covered, uncovered };
}
