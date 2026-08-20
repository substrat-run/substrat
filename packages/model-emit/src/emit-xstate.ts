/**
 * The declared lifecycle, rendered as an XState v5 machine config (#844).
 *
 * One direction, and that is the design. XState's statechart *semantics* are the
 * right vocabulary — nested states are K-17's substates exactly, and `setup()`
 * splitting implementations out of the config is why a guard can be referenced
 * by name here without it being a hack. Its *actor runtime* is not wanted: the
 * state lives in a column in a scope DO, the transition happens inside the
 * operation's transaction, and a second thing deciding transitions would be the
 * duplication the declaration exists to delete.
 *
 * So this emits, and nothing here parses. The conversion is TOTAL — every valid
 * lifecycle produces a valid machine — which is exactly what a narrow source
 * format buys: it can refuse `invoke`, `context`, `after` and parallel regions,
 * so the emitter never meets one.
 *
 * ## What it is for
 *
 * A **diagram** in an engine's docs page, and a **test oracle**: `xstate`'s own
 * `machine.transition()` is a pure function, so it can stand beside
 * `assertTransition` in a test and confirm the two agree on every state/event
 * pair, with `xstate` never leaving devDependencies.
 *
 * ## What it must never become
 *
 * A round-trip. Editing the emitted machine in a visual editor and reading it
 * back would make that editor a second authoring surface — the visual-builder
 * tarpit arriving through the back door, without anyone deciding to open it. Any
 * checked-in output of this belongs behind a `--check` re-emit, so an edit to it
 * goes red rather than becoming the source.
 */
import type { EmittedLifecycle } from '@substrat-run/contracts';

/** A guard wired in a manifest: `{ before, predicate }`, where `before` is an operation id. */
export interface GuardWiring {
  readonly before: string;
  readonly predicate: string;
}

export interface XStateTransition {
  readonly target: string;
  readonly guard?: string;
  readonly meta?: Record<string, unknown>;
}

export interface XStateNode {
  readonly type?: 'final';
  readonly on?: Record<string, XStateTransition | string>;
  readonly meta?: Record<string, unknown>;
}

export interface XStateMachine {
  readonly id: string;
  readonly initial: string;
  readonly states: Record<string, XStateNode>;
}

export interface EmitXStateOptions {
  /**
   * Manifest guard wirings, joined onto edges by operation id.
   *
   * Joined rather than declared: K-38 already puts guards in the manifest and has
   * the kernel evaluate them before the guarded operation. Every edge names its
   * operation, so the join key exists and a second declaration would only be a
   * second thing to disagree.
   */
  readonly guards?: readonly GuardWiring[];
}

/**
 * Event names are the operation ids verbatim — `workorder/complete`, not
 * `COMPLETE`.
 *
 * XState imposes no naming convention, and SCREAMING_SNAKE would be a lossy
 * rename: the diagram would stop naming the operation a reader can go and read.
 */
export function emitXState(
  entity: string,
  lifecycle: EmittedLifecycle,
  options: EmitXStateOptions = {},
): XStateMachine {
  const byOperation = new Map<string, string>();
  for (const g of options.guards ?? []) byOperation.set(g.before, g.predicate);

  const states: Record<string, XStateNode> = {};
  for (const name of Object.keys(lifecycle.states).sort()) {
    const state = lifecycle.states[name];
    if (!state) continue;
    const on: Record<string, XStateTransition | string> = {};
    for (const op of Object.keys(state.on ?? {}).sort()) {
      const target = state.on?.[op];
      if (target === undefined) continue;
      const guard = byOperation.get(op);
      on[op] = guard ? { target, guard } : target;
    }
    /**
     * `allow` deliberately does NOT become a self-transition.
     *
     * A self-loop in XState re-enters the state and fires its entry actions. The
     * declaration says the opposite — this operation is legal here and changes
     * nothing. Drawing it as an edge would put a loop on the diagram for every
     * note a technician can add to a work order, which is both wrong and
     * unreadable. It rides in `meta`, where a renderer can list it as what it is.
     */
    const meta = state.allow?.length ? { allow: [...state.allow] } : undefined;
    states[name] = {
      ...(state.terminal ? { type: 'final' as const } : {}),
      ...(Object.keys(on).length ? { on } : {}),
      ...(meta ? { meta } : {}),
    };
  }
  return { id: entity, initial: lifecycle.initial, states };
}
