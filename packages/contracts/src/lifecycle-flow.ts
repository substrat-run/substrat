/**
 * The process map's data (#1744): what one entity's declared lifecycle actually did in
 * a scope, over a window.
 *
 * A lifecycle (#844) says which states an entity may be in and which operation moves it
 * between them; nothing counted them. This is the count, derived from the outbox with no
 * new write path. Each edge names the operation that performs it, and the outbox records
 * the operation that emitted every event (#1243), so an entity's ordered events replay
 * its state sequence.
 *
 * The declaration travels IN the request rather than being looked up by the scope. The
 * dashboard already holds the running version's `model.json`, and a scope has no model
 * of its own to consult — so the read is a pure function of (declaration, outbox).
 */
import { z } from 'zod';
import { emittedLifecycle } from './model.js';
import type { EmittedLifecycle } from './lifecycle.js';

/** Most events one read replays. Past it the answer says `complete: false` rather than shrinking. */
export const LIFECYCLE_FLOW_EVENT_BUDGET = 20_000;
/** Longest-stuck instances returned per state. */
export const LIFECYCLE_FLOW_STUCK_MAX = 20;

/** An instant `Date.parse` reads — refused at the boundary, not deep inside the replay. */
const instant = z
  .string()
  .min(1)
  .max(64)
  .refine((v) => !Number.isNaN(Date.parse(v)), { message: 'not an ISO 8601 instant' });

export const lifecycleFlowInput = z.object({
  /** The entity whose events are replayed — the envelope's `entityType`, as the model names it. */
  entityType: z.string().min(1).max(128),
  /**
   * The machine to replay against, exactly as `model.json` emits it. Bounded, because it
   * arrives from a caller: a lifecycle of more states than any vertical declares is a
   * request to make the read do unbounded work.
   */
  lifecycle: emittedLifecycle.refine(
    (lc) =>
      Object.keys(lc.states).length <= 64 &&
      Object.values(lc.states).every((s) => Object.keys(s.on ?? {}).length + (s.allow?.length ?? 0) <= 256),
    { message: 'lifecycle is larger than any declared one: at most 64 states and 256 operations per state' },
  ),
  /** The window, half-open: events at or after `since` and before `until` are counted. */
  since: instant,
  /**
   * Required: the read has no clock of its own. It is also the instant "now" means —
   * events after it are not replayed, so `current` is the state as of `until`.
   */
  until: instant,
  stuckLimit: z.number().int().positive().max(LIFECYCLE_FLOW_STUCK_MAX).optional(),
});
/**
 * `lifecycle` is typed as the emitted form itself, so a `model.json` lifecycle — whose
 * interfaces are readonly — is passed as it is rather than copied to satisfy zod's
 * mutable inference.
 */
export type LifecycleFlowInput = Omit<z.infer<typeof lifecycleFlowInput>, 'lifecycle'> & { lifecycle: EmittedLifecycle };

/** How long instances spent in a state, over stays that ENDED inside the window. */
export const lifecycleDwell = z.object({
  samples: z.number().int().nonnegative(),
  medianMs: z.number().nonnegative(),
  p90Ms: z.number().nonnegative(),
});

export const lifecycleActorKind = z.enum(['principal', 'system', 'connection', 'capability', 'vertical', 'unknown']);
export type LifecycleActorKind = z.infer<typeof lifecycleActorKind>;

export const lifecycleFlowEdge = z.object({
  from: z.string(),
  to: z.string(),
  /**
   * The operation the move happened under. Null for a move no operation made: a consumer
   * emitted the event (the outbox records no operation for those), so the declaration —
   * which names only operations — can have no edge for it, and `declared` is false.
   */
  operation: z.string().nullable(),
  /** Transitions inside the window. A declared edge nobody took is listed with 0. */
  count: z.number().int().nonnegative(),
  /**
   * Who made those moves, by the kind of actor the outbox recorded: `principal` (a person
   * or a service principal signed in as one), `system` (a consumer), `connection` (a
   * connector), `capability` (whoever held a link), `vertical` (another app of the
   * tenant), `unknown` (a row the kernel could not decode). Sums to `count`.
   */
  actors: z.partialRecord(lifecycleActorKind, z.number().int().nonnegative()),
  /**
   * False for a move the declaration does not have: the payload says the entity went
   * from `from` to `to` under an operation that is no edge between them. A finding about
   * the model or the code, never a bucket to fold into a declared edge.
   */
  declared: z.boolean(),
  /**
   * True for a move first SEEN on a later event: the entity's payload showed a new state
   * under an operation that is no edge between the two, while the declaration does have
   * one. The call that made the move emitted nothing about this entity, so the operation is
   * unknown (null) and the time is when the move became visible, an upper bound. A count
   * here says an edge's operation should emit on the entity it moves.
   */
  seenLate: z.boolean(),
});

export const lifecycleFlowStuck = z.object({
  entityId: z.string(),
  /** When it entered the state it is still in. */
  since: z.string(),
  lastOperation: z.string().nullable(),
  lastAt: z.string(),
});

export const lifecycleFlowState = z.object({
  state: z.string(),
  terminal: z.boolean(),
  /** Instances in this state as of `until`. */
  current: z.number().int().nonnegative(),
  /** Moves INTO this state inside the window. */
  entered: z.number().int().nonnegative(),
  /** Null when no stay in this state ended inside the window — unknown, not zero. */
  dwell: lifecycleDwell.nullable(),
  /** The instances in this state longest, oldest entry first. Empty for a terminal state. */
  stuck: z.array(lifecycleFlowStuck),
});

export const lifecycleFlowResult = z.object({
  entityType: z.string(),
  since: z.string(),
  until: z.string(),
  edges: z.array(lifecycleFlowEdge),
  states: z.array(lifecycleFlowState),
  /**
   * Of the instances that STARTED inside the window (first seen in the initial state),
   * how many had been in each state by `until` — the funnel from the initial state.
   */
  funnel: z.object({ started: z.number().int().nonnegative(), reached: z.record(z.string(), z.number().int().nonnegative()) }),
  totals: z.object({
    started: z.number().int().nonnegative(),
    /** Instances that reached a terminal state inside the window. */
    finished: z.number().int().nonnegative(),
    /** Instances in a non-terminal state as of `until`, whenever they started. */
    inFlight: z.number().int().nonnegative(),
    /** First event to terminal state, over instances that finished inside the window. */
    medianLifecycleMs: z.number().nonnegative().nullable(),
  }),
  observation: z.object({
    entities: z.number().int().nonnegative(),
    events: z.number().int().nonnegative(),
    /**
     * Transitions whose target came from the declaration because the event's own
     * payload could not say: erased, classed as personal data (#1762), or not carrying
     * the lifecycle field. Replayed faithfully only while the code agrees with the model.
     */
    inferred: z.number().int().nonnegative(),
    /**
     * Events under an operation that is an edge SOMEWHERE in the machine, but neither an
     * edge nor allowed from the state the replay had the entity in, with no payload to
     * say where it went. The replay leaves the state unchanged and counts them here.
     */
    unexplained: z.number().int().nonnegative(),
    /** Moves first seen on a later event — see `seenLate` on an edge. Inside the window. */
    seenLate: z.number().int().nonnegative(),
    /**
     * False when the replay stopped at `LIFECYCLE_FLOW_EVENT_BUDGET`: every count is then a
     * lower bound, and a declared edge at 0 is not proof nobody took it.
     */
    complete: z.boolean(),
  }),
});
export type LifecycleFlowResult = z.infer<typeof lifecycleFlowResult>;
