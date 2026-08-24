/**
 * Does the HANDLER honour the entity check its operation DECLARED? (#747)
 *
 * #746 made an operation say what its permission checks against — `{ key,
 * entity, idFrom }` for one entity, a bare key for the node. Nothing verified
 * it. A declaration of `entity: 'list'` beside a handler calling
 * `ctx.check(perm)` typechecks perfectly and fails open: everyone holding the
 * key anywhere in the scope passes, which in a sharing app is every member
 * against every record.
 *
 * This generates the behavioural pair that tells the two apart, from the
 * declaration itself, for every operation that declares one.
 *
 * ## The two cases, and exactly what each one catches
 *
 * Both use a probe principal who holds the key ONLY through entity-narrowed
 * grants — never scope-wide.
 *
 * **Case 1 — grant on A, invoke against A. Expect no denial.**
 * A correct entity check resolves the grant on A and allows. A node check asks
 * whether the principal holds the key at the scope, and a narrowed grant does
 * not widen (`permission-suite`: *"No node-level access: the narrow grant does
 * not widen"*), so it denies. **This is the case that catches the node-check
 * bug** — and note which way round it fails: the broken implementation is MORE
 * restrictive for this principal, so in the wild it surfaces as a baffling
 * denial rather than as a breach. It is the direction nobody files a security
 * bug about.
 *
 * **Case 2 — grant on A, invoke against B. Expect a denial.**
 * The breach direction: a member reaching a record that is not theirs. Catches a
 * handler that checks nothing, one that checks a constant entity, and one that
 * reads the id from the wrong input field.
 *
 * **What case 2 does NOT catch, stated because a kit that overclaims is worse
 * than no kit:** it does not catch the node-check bug. Against B the correct
 * implementation denies, and so does the node check — for a different reason,
 * with the same outcome. Only case 1 separates them. Neither case, on its own,
 * is the test; the pair is.
 *
 * ## Why case 1 tolerates a non-permission failure
 *
 * It asserts "was not denied", not "succeeded". The harness supplies plausible
 * input, not a valid domain state — `protocol/sign` on a fresh instance may
 * legitimately refuse for a business reason. That refusal is not a permission
 * answer and must not be read as one. Case 2 is the opposite and is strict: it
 * demands a permission denial specifically, so a business error there is a
 * FAILURE, not a pass. That strictness also pins the ordering the platform
 * requires — the check is the operation's first line, so it answers before a
 * not-found ever can.
 *
 * ## Nothing is skipped quietly
 *
 * An operation declaring `resolved` cannot be generated: the id is not in the
 * input, so the harness has no way to reach the entity. An operation whose input
 * needs required fields the caller did not supply cannot be generated either.
 * Both are reported as UNCOVERED and asserted against a list the caller writes
 * down, so losing coverage — switching an `idFrom` to a `resolved`, say — turns
 * CI red and appears in the diff. A conformance kit that quietly covers the easy
 * half reads as "checked" when it is not.
 */
import { describe, expect, it } from 'vitest';
import type { EntityRef } from '@substrat-run/contracts';
import { PermissionDenied } from '@substrat-run/kernel';

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
   * The in-scope operations this kit cannot generate, each with its reason.
   *
   * Asserted EXACTLY: an operation that becomes uncoverable, or one that stops
   * being, fails until this list is updated. That is the point — it is the
   * coverage gap made reviewable rather than invisible.
   */
  readonly uncovered?: Readonly<Record<string, string>>;
}

interface DeclaredCheck {
  readonly key: string;
  /** One fixed type… */
  readonly entity?: string;
  /** …or the input field naming it, whose schema bounds the set (#890). */
  readonly entityFrom?: string;
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
  return permission.entity || permission.entityFrom ? permission : undefined;
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
  readonly idFrom: string;
  /** Input fields the schema fixes to one value, supplied by the kit (#890). */
  readonly fixed: Record<string, unknown>;
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
): { covered: PlannedCheck[]; uncovered: Record<string, string> } {
  const covered: PlannedCheck[] = [];
  const uncovered: Record<string, string> = {};

  for (const [name, raw] of Object.entries(operations).sort(([a], [b]) => a.localeCompare(b))) {
    const op = raw as DeclaredOp;
    const check = entityCheckOf(op);
    if (!check) continue;
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
    const missing = requiredExtras(op, check.idFrom, typeField).filter(
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
        idFrom: check.idFrom,
        fixed: {
          ...fixedFields(op, check.idFrom),
          ...(check.entityFrom ? { [check.entityFrom]: type } : {}),
        },
      });
    }
  }

  return { covered, uncovered };
}

/**
 * Generate the conformance pair for every operation declaring an entity check.
 *
 * ```ts
 * entityCheckConformanceSuite('todo', todoOperations, makeFixture, {
 *   inputs: { 'todo/rename-list': { name: 'renamed' } },
 *   uncovered: { 'todo/set-item-done': 'resolved — the id is not in the input' },
 * });
 * ```
 */
export function entityCheckConformanceSuite(
  subjectName: string,
  operations: Readonly<Record<string, object>>,
  makeFixture: () => Promise<EntityCheckFixture>,
  options: EntityCheckSuiteOptions = {},
): void {
  const declaredUncovered = options.uncovered ?? {};
  const supplied = options.inputs ?? {};

  // Partitioned at collection time so the generated tests can be named.
  const { covered, uncovered } = planEntityCheckCoverage(operations, supplied);

  describe(`declared entity checks are honoured: ${subjectName}`, () => {
    it('covers every entity check it can, and names every one it cannot', () => {
      // The whole partition asserted at once. A new operation with an entity
      // check joins `covered` silently (it is simply tested); one the kit cannot
      // drive has to be written down here, where a reviewer sees it.
      expect(uncovered).toEqual(declaredUncovered);
    });

    it('grants nothing extra to an operation it does not drive', () => {
      // An `alsoGrant` entry naming an operation that is uncovered or absent is
      // either a stale note or a grant widened against the wrong name. Both read
      // as coverage that is not there.
      const driven = new Set(covered.map((c) => c.name));
      expect(Object.keys(options.alsoGrant ?? {}).filter((n) => !driven.has(n))).toEqual([]);
    });

    it('generated a pair for at least one operation', () => {
      // A suite that generated nothing passes every assertion above it. This is
      // the zero guard: silence must not read as success.
      expect(covered.length).toBeGreaterThan(0);
    });

    for (const { name, key, entity, idFrom, fixed } of covered) {
      describe(`${name} — ${key} on ${entity}, id from '${idFrom}'`, () => {
        // Schema-fixed constants first, so an explicit fixture entry still wins —
        // it is the reviewable way to say "this one needs something else".
        const extras = { ...fixed, ...(supplied[name] ?? {}) };
        const extraKeys = options.alsoGrant?.[name]?.permissions ?? [];

        /**
         * The declared key on the target, plus anything the operation needs to
         * delegate. All of them NARROWED to the one entity — never scope-wide,
         * which is what keeps case 1 able to catch a node check.
         */
        const grantAllOn = async (fixture: EntityCheckFixture, entityId: string) => {
          const ref = { entityType: entity, entityId };
          await fixture.grantOnEntity(key, ref);
          for (const extra of extraKeys) await fixture.grantOnEntity(extra, ref);
        };

        const denialFrom = async (
          fixture: EntityCheckFixture,
          input: Record<string, unknown>,
        ): Promise<unknown | undefined> => {
          const isDenial = fixture.isDenial ?? ((e: unknown) => e instanceof PermissionDenied);
          try {
            await fixture.invoke(name, input);
            return undefined;
          } catch (error) {
            if (isDenial(error)) return error;
            // Not a permission answer. Case 1 tolerates it; case 2 must not, so
            // it is handed back rather than swallowed.
            return { notADenial: error };
          }
        };

        it('allows a principal granted on THAT entity (the node-check catcher)', async () => {
          const fixture = await makeFixture();
          const target = await fixture.createEntity(entity);
          await grantAllOn(fixture, target);

          const outcome = await denialFrom(fixture, { ...extras, [idFrom]: target });
          const denied = outcome !== undefined && !(outcome as { notADenial?: unknown }).notADenial;
          expect(
            denied,
            `${name} denied a principal holding ${key} on the very ${entity} it was ` +
              'invoked against — the handler is checking the node, not the entity',
          ).toBe(false);
        });

        it('denies the same principal against an entity they were NOT granted', async () => {
          const fixture = await makeFixture();
          // Granted somewhere, so the denial below is about THIS entity rather
          // than about a principal who holds nothing at all.
          const granted = await fixture.createEntity(entity);
          await grantAllOn(fixture, granted);
          const other = await fixture.createEntity(entity);

          const outcome = await denialFrom(fixture, { ...extras, [idFrom]: other });
          const notADenial = (outcome as { notADenial?: unknown } | undefined)?.notADenial;
          expect(
            outcome,
            `${name} allowed a principal to reach a ${entity} they hold no grant on`,
          ).toBeDefined();
          expect(
            notADenial,
            `${name} failed against an ungranted ${entity}, but not with a permission ` +
              'denial — the check must answer before anything else can',
          ).toBeUndefined();
        });
      });
    }
  });
}
