/**
 * Entity lifecycles — the state machines, declared (#844).
 *
 * #697 declared the entities, #707 the operations over them. Both left the
 * *edges* undeclared: six entities across four engines and two demos carry a
 * `status` enum, and every one of them describes its transitions a second time,
 * as hand-written guards in operation bodies.
 *
 * ```ts
 * function requireStatus(row: OrderRow, ...allowed: OrderRow['status'][]): void {
 *   if (!allowed.includes(row.status)) throw conflict('invalid_transition', …);
 * }
 * ```
 *
 * That function is the whole state machine, spread across six call sites, held
 * to the enum by nothing. Booking does not even hold the state *set* in one
 * place — the same seven values are written twice, as two independent `z.enum`
 * literals in its `entities.ts` and its `index.ts`.
 *
 * ## What this is not
 *
 * It is not a workflow language, and the omissions are the design.
 *
 * There are no actions, no effects, no `context`, no parallel regions and no
 * expression language. An edge names the operation that performs it and nothing
 * more; the operation keeps its body. The moment an edge can carry a condition,
 * this is BPMN in TypeScript — the tarpit the master plan named in the same
 * breath as adopting durable execution, and the reason that row says
 * "conventions" rather than "build".
 *
 * Durable execution is a separate concern with a separate answer (the outbox →
 * `_substrat_deliveries` → sweeper substrate). A lifecycle says which states an
 * entity may be in and which operation moves it between them. It never says
 * when, and it never runs anything.
 *
 * ## Guards are NOT declared here
 *
 * The obvious next field is `guard` on an edge, and it would be a second
 * description of something already shipped. K-38 ratified manifest-declared
 * guards: a module contributes a named predicate, a manifest wires it with
 * `guards: [{ before, predicate, config }]`, and the kernel evaluates it inside
 * the guarded operation's own transaction. `before` names an operation — and
 * every edge here names its operation too, so a guard on an operation already
 * *is* a guard on that operation's edges.
 *
 * The join key exists, so the views that want guards on edges (the XState
 * config, the docs diagram) derive them. Declaring them twice is how they come
 * to disagree.
 */
import { z } from 'zod';
import { substratError } from './errors.js';
import type { EntityDef } from './model.js';

// ---------------------------------------------------------------------------
// Reading the state set off the entity that owns it.
// ---------------------------------------------------------------------------

/**
 * The values the state field may hold, read off the entity's OWN `fields`
 * schema.
 *
 * This is what makes the declaration bite. The states are not restated here —
 * they are `z.enum(['planned', 'in_progress', 'completed', 'closed'])` in
 * `workorderEntities`, and naming a fifth one is a compile error rather than an
 * edge that silently never resolves. It also runs the other way: `states` is a
 * TOTAL record over this union, so adding a value to the enum and forgetting
 * the machine fails to compile.
 */
export type StateValues<E, F extends string> = E extends { fields: infer S }
  ? S extends z.ZodObject<z.ZodRawShape>
    ? F extends keyof z.infer<S>
      ? z.infer<S>[F] & string
      : never
    : never
  : never;

/** The field names of one entity, for the `field` position. */
type FieldNames<E> = E extends { fields: infer S }
  ? S extends z.ZodObject<z.ZodRawShape>
    ? keyof z.infer<S> & string
    : never
  : never;

/**
 * One state.
 *
 * `on` and `allow` are separate because most state checks in the repo are not
 * transitions. Nine of booking's `requireState` call sites gate operations, and
 * several of them — `requireState(row, 'held', 'confirmed')` before attaching a
 * note — change no state at all. A format with only edges would have described
 * the majority of them as transitions, which is worse than not describing them:
 * the emitted diagram would show edges that do not exist.
 */
export interface StateDef<States extends string = string, Ops extends string = string> {
  /** Operations that move the entity OUT of this state, to the named target. */
  readonly on?: Readonly<Partial<Record<Ops, States>>>;
  /** Operations legal in this state that change no state. A precondition, not an edge. */
  readonly allow?: readonly Ops[];
  /**
   * This state admits vertical substates (K-17 `extensibleStates`).
   *
   * kernel-design §7.5 specifies substates as *"the engine's state-machine
   * declaration marks which states admit substates"*. This is that mark. An
   * invariant-bearing state — one holding something signed, exported or
   * otherwise frozen — declares nothing, and the absence reads as intent.
   */
  readonly extensible?: boolean;
  /**
   * No edges out, ever.
   *
   * Distinguished from "no edges yet" deliberately: an empty `on` is ambiguous
   * between a finished state and an unfinished declaration, and only one of
   * those should emit `type: 'final'`.
   */
  readonly terminal?: boolean;
}

/** One entity's machine. */
export interface LifecycleDef<States extends string = string, Ops extends string = string> {
  /** The column holding the state. Must be a field of the entity. */
  readonly field: string;
  /** Where a freshly created row starts. Must be a declared state. */
  readonly initial: States;
  /** Every state the field may hold — total over the field's enum, by construction. */
  readonly states: Readonly<Record<States, StateDef<States, Ops>>>;
}

/**
 * The shape one entry must have, resolved against the entity it names and the
 * operations bag it draws from.
 *
 * Self-referential through `Self['field']`: the `states` keys depend on which
 * field was named in the same object literal. Written the obvious way — `field:
 * string` — every state name compiles and the check enforces nothing, which is
 * the failure `defineEntities` documents at length and `test/lifecycle.test.ts`
 * exists to prove has not returned.
 */
type LifecycleShape<Ent, Ops, Self> = Self extends { readonly field: infer F extends string }
  ? {
      readonly field: F & FieldNames<Ent>;
      readonly initial: StateValues<Ent, F>;
      readonly states: {
        readonly [S in StateValues<Ent, F>]: StateDef<StateValues<Ent, F>, keyof Ops & string>;
      };
    }
  : never;

/**
 * Declare an entity's lifecycle.
 *
 * Curried for the same reason `defineOperations` is: the entity registry and
 * the operation bag are both needed to check the declaration, and neither
 * should have to be re-stated at every call site.
 *
 * ```ts
 * export const workorderLifecycles = defineLifecycles(workorderEntities, workorderOperations)({
 *   workorder: {
 *     field: 'status',
 *     initial: 'planned',
 *     states: {
 *       planned:     { on: { 'workorder/start': 'in_progress' }, allow: ['workorder/assign'] },
 *       in_progress: { on: { 'workorder/complete': 'completed' }, extensible: true },
 *       completed:   { on: { 'workorder/close': 'closed' } },
 *       closed:      { terminal: true },
 *     },
 *   },
 * });
 * ```
 */
export function defineLifecycles<const E extends Record<string, EntityDef>, const O extends Record<string, unknown>>(
  _entities: E,
  _operations: O,
) {
  return function declare<
    const L extends {
      readonly [K in keyof L]: K extends keyof E ? LifecycleShape<E[K], O, L[K]> : never;
    },
  >(lifecycles: L): L {
    for (const [entity, lc] of Object.entries(lifecycles as Record<string, LifecycleDef>)) {
      assertCoherent(entity, lc, declaredValues(_entities[entity], lc.field));
    }
    return lifecycles;
  };
}

/**
 * The values the state column may actually hold, if it says so.
 *
 * `z.enum([...])` is the common case and the one worth checking. A state field
 * typed `z.string()` — manyfold holds its six statuses in a `const` array — is
 * not an error and simply cannot be checked here; returning `undefined` says
 * "unknown", which is different from "empty".
 */
function declaredValues(entity: EntityDef | undefined, field: string): readonly string[] | undefined {
  const schema = (entity?.fields.shape as Record<string, unknown> | undefined)?.[field];
  const options = (schema as { options?: unknown } | undefined)?.options;
  return Array.isArray(options) && options.every((o) => typeof o === 'string') ? (options as string[]) : undefined;
}

/**
 * The checks the type system cannot make, made loudly at module load.
 *
 * Exported so the emitters can run it over a registry they were handed rather
 * than one they built — the same posture as `primaryKeyOf`, which throws rather
 * than returning nothing because a table with no identity is not a shape the
 * model may express.
 *
 * **`allowed` is checked here rather than in the types**, and that placement is
 * measured rather than chosen: TypeScript applies no excess-property check when
 * a value satisfies a generic constraint, so a `states` object carrying a fifth
 * key the enum does not have compiles clean. The same caveat `defineEntities`
 * records for `renamedFrom`. A check that reads like it works and does not is
 * worse than an absent one, so this one is where it can bite.
 */
export function assertCoherent(entity: string, lc: LifecycleDef, allowed?: readonly string[]): void {
  const states = Object.keys(lc.states);
  if (allowed) {
    for (const name of states) {
      if (!allowed.includes(name)) {
        throw new Error(
          `lifecycle: ${entity}.states declares '${name}', which '${lc.field}' cannot hold — ` +
            `it is ${allowed.map((v) => `'${v}'`).join(' | ')}`,
        );
      }
    }
    for (const value of allowed) {
      if (!states.includes(value)) {
        throw new Error(
          `lifecycle: '${lc.field}' can hold '${value}' but ${entity}.states does not declare it — ` +
            'a state the column can reach and the machine has never heard of is where an entity goes to get stuck',
        );
      }
    }
  }
  if (!states.includes(lc.initial)) {
    throw new Error(`lifecycle: ${entity}.initial is '${lc.initial}', which is not a declared state`);
  }
  for (const [name, state] of Object.entries(lc.states)) {
    const edges = Object.entries(state.on ?? {});
    if (state.terminal && edges.length > 0) {
      throw new Error(
        `lifecycle: ${entity}.${name} is terminal but declares ${edges.length} transition(s) — ` +
          'a terminal state has no edges out. Drop `terminal` or drop the edges',
      );
    }
    for (const [op, target] of edges) {
      if (!states.includes(target as string)) {
        throw new Error(`lifecycle: ${entity}.${name}.on['${op}'] targets '${target}', which is not a declared state`);
      }
    }
    // An operation that both moves the entity and is declared inert in the same
    // state is two answers to one question, and the evaluator would have to
    // pick one silently.
    for (const op of state.allow ?? []) {
      if (op in (state.on ?? {})) {
        throw new Error(
          `lifecycle: ${entity}.${name} declares '${op}' in both \`on\` and \`allow\` — ` +
            'it either moves the entity or it does not',
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The evaluator. Pure, synchronous, no host access.
// ---------------------------------------------------------------------------

/**
 * What an operation does to an entity in a given state.
 *
 * `allowed` is not a degenerate transition — the caller uses the distinction.
 * An engine writing `status = ?` after a `transition` outcome is correct; doing
 * it after an `allowed` one would move an entity the declaration says stays put.
 */
export type Outcome = { readonly kind: 'transition'; readonly to: string } | { readonly kind: 'allowed' };

/**
 * What `operation` does from `from`, or `null` if it is not legal there.
 *
 * Total and side-effect free, which is what lets `xstate`'s own
 * `machine.transition()` stand beside it in tests as an independent oracle
 * without either one shipping to production.
 */
export function transitionFor(lc: LifecycleDef, from: string, operation: string): Outcome | null {
  const state = lc.states[from];
  if (!state) return null;
  const to = state.on?.[operation];
  if (to !== undefined) return { kind: 'transition', to };
  if (state.allow?.includes(operation)) return { kind: 'allowed' };
  return null;
}

/**
 * The reason an illegal transition is refused with.
 *
 * Exported so an engine's own conflict vocabulary can REFERENCE it rather than
 * spell it again — the reason is raised here now, and an engine whose exported
 * `*_CONFLICT_REASONS` list said something subtly different would be publishing
 * a slug no consumer would ever match.
 */
export const INVALID_TRANSITION = 'invalid_transition';

/**
 * The replacement for every hand-written `requireStatus` / `requireState`.
 *
 * Throws the platform's own `conflict` with `reason: 'invalid_transition'` —
 * the reason four engines already narrow to, and the one two demos were
 * silently not using. `demos/shop` threw a bare `new Error(...)`, so a caller
 * branching on the refusal got a 500 where every engine gives a 409.
 *
 * The message names what WAS legal, because the failure a user hits is almost
 * never "this operation does not exist" — it is "someone else already moved it."
 */
export function assertTransition(lc: LifecycleDef, entity: string, from: string, operation: string): Outcome {
  const outcome = transitionFor(lc, from, operation);
  if (outcome) return outcome;
  const legal = Object.keys(lc.states)
    .filter((s) => transitionFor(lc, s, operation) !== null)
    .sort();
  throw substratError(
    'conflict',
    legal.length > 0
      ? `invalid transition: ${entity} is '${from}', but '${operation}' requires ${legal.join(' | ')}`
      : `invalid transition: '${operation}' is not legal in any state of ${entity}`,
    { reason: INVALID_TRANSITION },
  );
}

/** Every operation the declaration mentions, sorted. The join key for guards and docs. */
export function operationsOf(lc: LifecycleDef): readonly string[] {
  const ops = new Set<string>();
  for (const state of Object.values(lc.states)) {
    for (const op of Object.keys(state.on ?? {})) ops.add(op);
    for (const op of state.allow ?? []) ops.add(op);
  }
  return [...ops].sort();
}

// ---------------------------------------------------------------------------
// The emitted form.
// ---------------------------------------------------------------------------

/** One state, serialised. Absent optionals stay absent — a diff should show facts, not defaults. */
export interface EmittedState {
  readonly on?: Record<string, string>;
  readonly allow?: readonly string[];
  readonly extensible?: true;
  readonly terminal?: true;
}

export interface EmittedLifecycle {
  readonly field: string;
  readonly initial: string;
  readonly states: Record<string, EmittedState>;
}

/**
 * Render lifecycles to plain JSON for `model.json`.
 *
 * Deterministic in the same way `emitModel` is: entities, states and edges are
 * emitted in sorted order, so a reordered declaration is not a spurious diff
 * and the checked-in artifact stays reviewable.
 */
export function emitLifecycles(lifecycles: Record<string, LifecycleDef>): Record<string, EmittedLifecycle> {
  const out: Record<string, EmittedLifecycle> = {};
  for (const entity of Object.keys(lifecycles).sort()) {
    const lc = lifecycles[entity];
    if (!lc) continue;
    assertCoherent(entity, lc);
    const states: Record<string, EmittedState> = {};
    for (const name of Object.keys(lc.states).sort()) {
      const s = lc.states[name] as StateDef;
      const edges: Record<string, string> = {};
      for (const op of Object.keys(s.on ?? {}).sort()) {
        const target = (s.on as Record<string, string | undefined>)[op];
        if (target !== undefined) edges[op] = target;
      }
      states[name] = {
        ...(Object.keys(edges).length ? { on: edges } : {}),
        ...(s.allow?.length ? { allow: [...s.allow].sort() } : {}),
        ...(s.extensible ? { extensible: true as const } : {}),
        ...(s.terminal ? { terminal: true as const } : {}),
      };
    }
    out[entity] = { field: lc.field, initial: lc.initial, states };
  }
  return out;
}
