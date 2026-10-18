/**
 * The seam a request trace is recorded through (#2358).
 *
 * Plain TypeScript with no runtime import, for the reason `invocation-record.ts` is: the
 * middleware that feeds a sink is bundled into the platform entry in front of every
 * vertical, and that bundle may not carry zod. The matching zod schemas — what a recorder
 * WRITES and `substrat logs` READS — are in `request-trace.ts`; a type-level test holds the
 * two in step, so this file stays the narrow one without becoming a second source of truth.
 *
 * ## How a sink is found
 *
 * A host does not take a sink as an option. It reads one slot on `globalThis`,
 * {@link TRACE_SINK_KEY}, at each hook, and does nothing when the slot is empty. That is the
 * same arrangement the store-call tally uses, and it is what lets `substrat dev` turn traces
 * on in a vertical's process with a `--import` preload and no edit to the vertical's
 * `server.ts`. Nothing on a hosted path ever fills the slot, so "off in production" is a
 * property of who installs a sink, not of a flag a deploy could forget to set.
 *
 * ## What a sink is NOT
 *
 * Not authority and not evidence. A trace is a debugging aid for the person running the
 * vertical locally; nothing reads it to decide a request. A sink that throws must never fail
 * a request, so a host calls it inside a guard and swallows the error.
 */
import type { Actor } from './events.js';

/** The `globalThis` slot a host reads its sink from. A registered symbol, so two copies of a package agree. */
export const TRACE_SINK_KEY: unique symbol = Symbol.for('substrat.trace-sink') as never;

/** The most steps one trace keeps; later ones are counted in `stepsDropped`, not stored. */
export const TRACE_STEP_CAP = 500;

/** The step kinds, in the order a reader lists them. */
export const TRACE_STEP_TYPES = [
  'check',
  'sql',
  'emit',
  'log',
  'validation',
  'outbound',
  'store',
  'error',
] as const;
export type TraceStepType = (typeof TRACE_STEP_TYPES)[number];

/** Fields every step carries. */
interface TraceStepBase {
  /** Milliseconds from the invocation's start to this step; fractional where the clock is. */
  atMs: number;
  /** How long it took, when it has a duration. */
  durationMs?: number;
}

/**
 * One permission check. `decidedBy` names the path an ALLOW took — `role:<key>`,
 * `grant:<entity>`, `system:<module>` — read off the proof tuples. A DENY has no rule to
 * name (the checker returns only the key it checked), so the recorder fills `requires` with
 * the roles that hold the permission and `callerHas` with the roles the caller holds: that
 * pair is "requires finance; caller has member". For a check on one entity the missing piece may
 * be a grant rather than a role, so `requires` also names `grant:<permission>@<entity>` and
 * `callerHas` lists the grants the caller holds for that permission. `callerHas` is empty for a
 * subject that is not a principal (a system module, a connection), which holds no role to list:
 * empty there means "not explained", not "holds nothing".
 */
export interface TraceCheckStep extends TraceStepBase {
  type: 'check';
  permission: string;
  /** `<entityType>:<entityId>`, or `null` for a scope-wide check. */
  entity: string | null;
  allowed: boolean;
  decidedBy: string | null;
  requires: string[];
  callerHas: string[];
}

/**
 * One `ctx.sql` statement, as it RAN. A statement in an operation that later rolled back (a
 * refused check, a failed `ctx.atomic`) is still listed: a trace says what the call did, and the
 * `error` step says how it ended, not which writes survived.
 *
 * `params` is present only when the sink asked for it ({@link TraceSink.capture}): a host never
 * sends values a sink did not request, because a bound value is as likely to be a person's data
 * or a password hash as an id.
 */
export interface TraceSqlStep extends TraceStepBase {
  type: 'sql';
  operation: 'query' | 'exec';
  statement: string;
  params?: unknown[];
  /** Rows a `query` returned. */
  rowsRead?: number;
  /** Rows an `exec` changed. */
  rowsWritten?: number;
  /** The statement's error class and message, when it threw. */
  error?: string;
}

/** One event the operation emitted. Ids and types only — never the payload. */
export interface TraceEmitStep extends TraceStepBase {
  type: 'emit';
  eventType: string;
  /** `<entityType>:<entityId>`. */
  entity: string;
}

/** One `ctx.log` line the operation wrote. */
export interface TraceLogStep extends TraceStepBase {
  type: 'log';
  level: string;
  message: string;
}

/** The input did not parse. One entry per issue: a dotted path and a message. */
export interface TraceValidationStep extends TraceStepBase {
  type: 'validation';
  issues: { path: string; message: string }[];
}

/** One outbound `fetch`: host, redacted path, method, status and outcome — no header, body or query. */
export interface TraceOutboundStep extends TraceStepBase {
  type: 'outbound';
  host: string;
  path: string;
  method: string;
  status: number | null;
  outcome: string;
  /** A failed call's error class, never its message. */
  reason?: string;
}

/** One store call (a blob, a scope store). The input is not a field. */
export interface TraceStoreStep extends TraceStepBase {
  type: 'store';
  binding: string;
  operation: string;
  outcome: string;
}

/** An error that ended the invocation. `stack` is source-mapped where the host can. */
export interface TraceErrorStep extends TraceStepBase {
  type: 'error';
  code: string | null;
  message: string;
  stack?: string;
}

export type TraceStep =
  | TraceCheckStep
  | TraceSqlStep
  | TraceEmitStep
  | TraceLogStep
  | TraceValidationStep
  | TraceOutboundStep
  | TraceStoreStep
  | TraceErrorStep;

/**
 * The head of a trace. Every key below is the name the hosted invocation line (#1746) already
 * uses for the same fact — a rename here would split the two. `null` reads as "not recorded".
 */
export interface TraceHead {
  invocationId: string;
  /** ISO 8601 instant the invocation started. */
  startedAt: string;
  tenantId: string;
  scopeId: string | null;
  vertical: string | null;
  surface: string | null;
  method: string | null;
  /** Path only; the query string is dropped. */
  path: string | null;
  status: number | null;
  threw: boolean;
  durationMs: number;
  level: 'error' | 'warn' | 'info';
  operation: string | null;
  problemCode: string | null;
  principalKind: string | null;
  /** Who the call ran as. Local only: the hosted line carries `principalKind` and no id. */
  principal: Actor | null;
  eventCount: number | null;
  eventTypes: string[];
  entities: string[];
  versionId: string | null;
  /** The vertical's spec version, when the host knows it. */
  specVersion: string | null;
}

/**
 * Two parts of one request report themselves: the HTTP middleware (method, path, status,
 * duration) and the scope host (operation, principal, events). Each sends the keys it knows.
 */
export type TraceHeadPatch = Partial<TraceHead> & {
  /**
   * Steps the host knew of and did not send (outbound calls past the cap), so a reader sees a
   * truncated list as truncated. The recorder adds it to `capture.stepsDropped`.
   */
  stepsDropped?: number;
};
// A key whose value is `undefined` means "this part does not know", never "erase": a sink
// skips it when merging, so the middleware cannot blank what the scope host reported.

/**
 * Where a host sends what it saw. All three are synchronous and best-effort: a recorder
 * batches and writes elsewhere, and a host calls them inside a guard.
 */
export interface TraceSink {
  /**
   * What this sink wants a host to send beyond the default. Absent reads as everything off.
   * `sqlParams` is the one such request today: the values bound to a statement.
   */
  readonly capture?: { readonly sqlParams?: boolean };
  /** Merge what one part of the host knows about the invocation; `undefined` values are skipped. */
  head(invocationId: string, patch: TraceHeadPatch): void;
  /** Append one step. */
  step(invocationId: string, step: TraceStep): void;
  /** The invocation is over: the head is as complete as it will get, so write the trace. */
  end(invocationId: string): void;
}

/**
 * One time axis per invocation, shared by whoever records a step.
 *
 * The HTTP layer starts the request and the scope host runs inside it, so each used to count
 * from its own zero and a step from one could sort before the step that caused it. The layer
 * that starts the request calls {@link markTraceStart}; every step is stamped with
 * {@link traceOffsetMs}, which counts from that mark, or from its own first call when nothing
 * marked one (a call that did not come through HTTP). {@link forgetTraceStart} releases it.
 * Held on a `globalThis` slot, like the sink, so two copies of a package agree.
 */
const STARTS_KEY: unique symbol = Symbol.for('substrat.trace-starts') as never;

function starts(): Map<string, number> {
  const slots = globalThis as Record<symbol, unknown>;
  return (slots[STARTS_KEY] ??= new Map<string, number>()) as Map<string, number>;
}

/** Note that an invocation started now (or at `at`, on the `performance.now()` clock). */
export function markTraceStart(invocationId: string, at: number = performance.now()): void {
  const map = starts();
  if (!map.has(invocationId)) map.set(invocationId, at);
}

/** Milliseconds since the invocation started, starting it now when nothing has. */
export function traceOffsetMs(invocationId: string): number {
  markTraceStart(invocationId);
  return Math.max(0, Math.round(performance.now() - starts().get(invocationId)!));
}

/** The invocation is over: release its start. */
export function forgetTraceStart(invocationId: string): void {
  starts().delete(invocationId);
}

/** The sink installed on this runtime, or `undefined` when tracing is off. */
export function installedTraceSink(): TraceSink | undefined {
  return (globalThis as Record<symbol, unknown>)[TRACE_SINK_KEY] as TraceSink | undefined;
}
