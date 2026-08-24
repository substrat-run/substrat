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
import { PermissionDenied } from '@substrat-run/kernel';

export type { EntityCheckFixture, EntityCheckSuiteOptions, PlannedCheck } from './entity-check-plan.js';
export { planEntityCheckCoverage } from './entity-check-plan.js';
import type { EntityCheckFixture, EntityCheckSuiteOptions } from './entity-check-plan.js';
import { planEntityCheckCoverage } from './entity-check-plan.js';

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
  const { covered, uncovered } = planEntityCheckCoverage(
    operations,
    supplied,
    options.refEntityType,
  );

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

    for (const { name, key, entity, target, fixed } of covered) {
      const where =
        target.kind === 'ref'
          ? `ref from '${target.path.join('.')}'`
          : `id from '${target.path[0]}'`;

      /**
       * The input the pair is driven with. A `refFrom` check is handed the whole
       * ref — which is the assertion, since an engine declaring this shape claims
       * to honour whatever noun arrives.
       */
      const inputFor = (
        entityId: string,
        extras: Record<string, unknown>,
      ): Record<string, unknown> => {
        const value = target.kind === 'ref' ? { entityType: entity, entityId } : entityId;
        const [head, ...rest] = target.path;
        if (rest.length === 0) return { ...extras, [head!]: value };
        // One level in: the ref travels beside other fields the caller supplied,
        // so the sibling keys the fixture gave for that object are preserved.
        const outer = (extras[head!] ?? {}) as Record<string, unknown>;
        return { ...extras, [head!]: { ...outer, [rest.join('.')]: value } };
      };

      describe(`${name} — ${key} on ${entity}, ${where}`, () => {
        /**
         * Schema-fixed constants first, so an explicit fixture entry still wins —
         * it is the reviewable way to say "this one needs something else".
         *
         * Read per CASE, not once per describe. A fixture entry legitimately
         * holds a value that does not exist yet at collect time: rally's spare
         * member is created in `beforeAll` and written into the object the kit
         * was handed, which is the documented way to supply an id the harness
         * must make first. Spreading in the describe body captured the empty
         * placeholder instead, and nothing said so — case 1 only asserts "was
         * not denied", and case 2's permission answer arrived before anything
         * looked at the field. Once the host parses a declared input (#893) the
         * same fixture fails the parse, which is what surfaced this.
         */
        const extrasNow = () => ({ ...fixed, ...(supplied[name] ?? {}) });
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
          const targetId = await fixture.createEntity(entity);
          await grantAllOn(fixture, targetId);

          const outcome = await denialFrom(fixture, inputFor(targetId, extrasNow()));
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

          const outcome = await denialFrom(fixture, inputFor(other, extrasNow()));
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
