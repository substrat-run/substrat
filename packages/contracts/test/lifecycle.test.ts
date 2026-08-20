/**
 * #844 — declared lifecycles, and proof that the checks are enforced.
 *
 * The `@ts-expect-error` cases below ARE the feature, for the reason
 * `model.test.ts` states: a type-level constraint fails *permissively*. Written
 * the obvious way — `field: string`, `states: Record<string, StateDef>` — every
 * case here compiles clean and enforces nothing, and from the happy path that
 * looks identical to working. If a check stops biting, `tsc` reports "Unused
 * '@ts-expect-error' directive" and the package's typecheck goes red.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { errorCodeOf } from '../src/errors.js';
import {
  assertTransition,
  defineLifecycles,
  emitLifecycles,
  operationsOf,
  transitionFor,
  type LifecycleDef,
} from '../src/lifecycle.js';
import { defineEntities, emitModel } from '../src/model.js';
import { defineOperations } from '../src/operations.js';

const entities = defineEntities({
  order: {
    table: 'shop_order',
    fields: z.object({
      id: z.string(),
      status: z.enum(['planned', 'in_progress', 'completed', 'closed']),
      note: z.string().nullable(),
    }),
  },
  customer: {
    table: 'shop_customer',
    fields: z.object({ id: z.string(), name: z.string() }),
  },
});

const PERMS = ['order:manage'] as const;
const orderId = z.object({ orderId: z.string() });

const operations = defineOperations(
  entities,
  PERMS,
)({
  'shop/start': { summary: 'Start', permission: 'order:manage', input: orderId, output: entities.order.fields },
  'shop/complete': { summary: 'Complete', permission: 'order:manage', input: orderId, output: entities.order.fields },
  'shop/close': { summary: 'Close', permission: 'order:manage', input: orderId, output: entities.order.fields },
  'shop/add-note': { summary: 'Note', permission: 'order:manage', input: orderId, output: entities.order.fields },
});

const lifecycles = defineLifecycles(
  entities,
  operations,
)({
  order: {
    field: 'status',
    initial: 'planned',
    states: {
      planned: { on: { 'shop/start': 'in_progress' }, allow: ['shop/add-note'] },
      in_progress: { on: { 'shop/complete': 'completed' }, allow: ['shop/add-note'], extensible: true },
      completed: { on: { 'shop/close': 'closed' } },
      closed: { terminal: true },
    },
  },
});

const order = lifecycles.order as LifecycleDef;

describe('the declaration is checked against the entity that owns the state', () => {
  /**
   * Both layers refuse these, and the directive is still the point: the runtime
   * check catches the value, `@ts-expect-error` catches the *declaration*. If
   * the type-level check silently stopped biting, this test would keep passing
   * on the runtime throw alone — so `tsc` reporting an unused directive is the
   * only thing that would notice.
   */
  it('rejects a field the entity does not have', () => {
    expect(() =>
      defineLifecycles(
        entities,
        operations,
      )({
        // @ts-expect-error — 'stage' is not a field of `order`
        order: { field: 'stage', initial: 'planned', states: {} },
      }),
    ).toThrow();
  });

  /**
   * Runtime, not compile time — and deliberately so. TypeScript applies no
   * excess-property check when a value satisfies a generic constraint, so the
   * extra key compiles clean however the constraint is written. Asserting it
   * here is the honest placement; a `@ts-expect-error` would sit unused.
   */
  it('rejects a state the field cannot hold', () => {
    expect(() =>
      defineLifecycles(
        entities,
        operations,
      )({
        order: {
          field: 'status',
          initial: 'planned',
          states: { planned: {}, in_progress: {}, completed: {}, closed: {}, archived: {} },
        },
      }),
    ).toThrow(/declares 'archived', which 'status' cannot hold/);
  });

  it('rejects a machine that has never heard of a value the column can hold', () => {
    expect(() =>
      defineLifecycles(
        entities,
        operations,
      )({
        // @ts-expect-error — 'closed' is missing from `states`
        order: { field: 'status', initial: 'planned', states: { planned: {}, in_progress: {}, completed: {} } },
      }),
    ).toThrow(/can hold 'closed' but order.states does not declare it/);
  });

  it('rejects an initial state the field cannot hold', () => {
    expect(() =>
      defineLifecycles(
        entities,
        operations,
      )({
        order: {
          field: 'status',
          // @ts-expect-error — 'draft' is not a member of the status enum
          initial: 'draft',
          states: { planned: {}, in_progress: {}, completed: {}, closed: {} },
        },
      }),
    ).toThrow(/initial is 'draft'/);
  });

  it('rejects an edge targeting an undeclared state', () => {
    expect(() =>
      defineLifecycles(
        entities,
        operations,
      )({
        order: {
          field: 'status',
          initial: 'planned',
          states: {
            // @ts-expect-error — 'done' is not a declared state
            planned: { on: { 'shop/start': 'done' } },
            in_progress: {},
            completed: {},
            closed: {},
          },
        },
      }),
    ).toThrow(/targets 'done'/);
  });

  it('rejects an operation the module does not declare', () => {
    defineLifecycles(
      entities,
      operations,
    )({
      order: {
        field: 'status',
        initial: 'planned',
        // @ts-expect-error — 'shop/reopen' is not a declared operation
        states: { planned: { on: { 'shop/reopen': 'in_progress' } }, in_progress: {}, completed: {}, closed: {} },
      },
    });
  });

  it('rejects a lifecycle for an entity that does not exist', () => {
    expect(() =>
      defineLifecycles(
        entities,
        operations,
      )({
        // @ts-expect-error — there is no `invoice` entity
        invoice: { field: 'status', initial: 'draft', states: {} },
      }),
    ).toThrow();
  });
});

describe('the checks the type system cannot make', () => {
  it('refuses a terminal state that declares edges', () => {
    expect(() =>
      defineLifecycles(
        entities,
        operations,
      )({
        order: {
          field: 'status',
          initial: 'planned',
          states: {
            planned: {},
            in_progress: {},
            completed: {},
            closed: { terminal: true, on: { 'shop/start': 'planned' } },
          },
        },
      }),
    ).toThrow(/terminal but declares 1 transition/);
  });

  it('refuses an operation that is both an edge and inert in one state', () => {
    expect(() =>
      defineLifecycles(
        entities,
        operations,
      )({
        order: {
          field: 'status',
          initial: 'planned',
          states: {
            planned: { on: { 'shop/start': 'in_progress' }, allow: ['shop/start'] },
            in_progress: {},
            completed: {},
            closed: {},
          },
        },
      }),
    ).toThrow(/both `on` and `allow`/);
  });

  it('refuses a lifecycle over an entity the registry does not declare', () => {
    expect(() => emitModel(entities, { lifecycles: { invoice: order } })).toThrow(
      /lifecycle is declared for 'invoice', which is not a declared entity/,
    );
  });
});

describe('the evaluator', () => {
  it('reports a transition and its target', () => {
    expect(transitionFor(order, 'planned', 'shop/start')).toEqual({ kind: 'transition', to: 'in_progress' });
  });

  /**
   * The distinction booking's nine call sites forced. `shop/add-note` is legal
   * in `planned` and changes nothing; a format with only edges would have
   * reported it as a transition to itself, and the emitted diagram would show a
   * self-loop that does not exist.
   */
  it('separates a precondition from an edge', () => {
    expect(transitionFor(order, 'planned', 'shop/add-note')).toEqual({ kind: 'allowed' });
  });

  it('reports nothing for an operation illegal in this state', () => {
    expect(transitionFor(order, 'closed', 'shop/start')).toBeNull();
  });

  it('reports nothing for a state that is not declared', () => {
    expect(transitionFor(order, 'nonsense', 'shop/start')).toBeNull();
  });

  it('throws a platform conflict naming the states that would have worked', () => {
    expect(() => assertTransition(order, 'order', 'closed', 'shop/complete')).toThrow(
      /invalid transition: order is 'closed', but 'shop\/complete' requires in_progress/,
    );
  });

  it('carries the reason four engines already narrow to', () => {
    try {
      assertTransition(order, 'order', 'closed', 'shop/complete');
      throw new Error('should have thrown');
    } catch (err) {
      expect(errorCodeOf(err)).toBe('conflict');
      expect((err as { extensions?: { reason?: string } }).extensions?.reason).toBe('invalid_transition');
    }
  });

  it('says so plainly when an operation is legal nowhere', () => {
    expect(() => assertTransition(order, 'order', 'planned', 'shop/vanish')).toThrow(
      /'shop\/vanish' is not legal in any state of order/,
    );
  });

  it('lists every operation the machine mentions', () => {
    expect(operationsOf(order)).toEqual(['shop/add-note', 'shop/close', 'shop/complete', 'shop/start']);
  });
});

describe('the emitted form', () => {
  it('sorts states and edges so a reordered declaration is not a diff', () => {
    const a = emitLifecycles({ order });
    const reordered = emitLifecycles({
      order: {
        field: 'status',
        initial: 'planned',
        states: {
          closed: order.states.closed!,
          completed: order.states.completed!,
          in_progress: order.states.in_progress!,
          planned: order.states.planned!,
        },
      },
    });
    expect(JSON.stringify(a)).toBe(JSON.stringify(reordered));
  });

  it('omits absent optionals rather than emitting defaults', () => {
    const emitted = emitLifecycles({ order });
    expect(emitted.order!.states.completed).toEqual({ on: { 'shop/close': 'closed' } });
    expect(emitted.order!.states.closed).toEqual({ terminal: true });
  });

  it('marks the state that admits substates', () => {
    expect(emitLifecycles({ order }).order!.states.in_progress!.extensible).toBe(true);
  });

  it('rides along in model.json, and stays absent when nothing declares one', () => {
    expect(emitModel(entities).lifecycles).toBeUndefined();
    expect(emitModel(entities, { lifecycles: { order } }).lifecycles!.order!.initial).toBe('planned');
  });
});
