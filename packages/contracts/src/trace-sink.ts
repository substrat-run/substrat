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
  /** Milliseconds from the invocation's start to this step. */
  atMs: number;
  /** How long it took, when it has a duration. */
  durationMs?: number;
}

/**
 * One permission check. `decidedBy` names the path an ALLOW took — `role:<key>`,
 * `grant:<entity>`, `system:<module>` — read off the proof tuples. A DENY has no rule to
 * name (the checker returns only the key it checked), so the recorder fills `requires` with
 * the roles that hold the permission and `callerHas` with the roles the caller holds: that
 * pair is "requires finance; caller has member".
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

/** One `ctx.sql` statement. `params` is optional: a source that must not hold values omits it. */
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
export type TraceHeadPatch = Partial<TraceHead>;

/**
 * Where a host sends what it saw. All three are synchronous and best-effort: a recorder
 * batches and writes elsewhere, and a host calls them inside a guard.
 */
export interface TraceSink {
  /** Merge what one part of the host knows about the invocation. */
  head(invocationId: string, patch: TraceHeadPatch): void;
  /** Append one step. */
  step(invocationId: string, step: TraceStep): void;
  /** The invocation is over: the head is as complete as it will get, so write the trace. */
  end(invocationId: string): void;
}

/** The sink installed on this runtime, or `undefined` when tracing is off. */
export function installedTraceSink(): TraceSink | undefined {
  return (globalThis as Record<symbol, unknown>)[TRACE_SINK_KEY] as TraceSink | undefined;
}
