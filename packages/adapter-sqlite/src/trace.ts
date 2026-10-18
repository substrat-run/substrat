/**
 * The scope host's half of a request trace (#2358): what only the host sees.
 *
 * Every function here is a no-op until something installs a sink (`installedTraceSink`), and
 * `substrat dev` is the only thing that does. The hosted adapter never loads this package, and
 * a deploy that installs none records nothing, so the cost of tracing on any other path is one
 * `globalThis` read per invocation.
 *
 * Two rules for everything below. A hook never changes what the host does: it reads the
 * value the host already computed, and a sink that throws is swallowed rather than allowed to
 * fail a request. And nothing is invented: a deny's `requires` and `callerHas` come from the
 * role table and the checker's own `holdings`, the same sources a console would read.
 */
import {
  forgetTraceStart,
  installedTraceSink,
  traceOffsetMs,
  type EntityRef,
  type RelationTuple,
  type TraceHeadPatch,
  type TraceStep,
} from '@substrat-run/contracts';
import type { ScopedSql } from '@substrat-run/kernel';

/** A step as a hook writes it: the host stamps `atMs`. */
export type TraceStepInput = TraceStep extends infer S ? (S extends TraceStep ? Omit<S, 'atMs'> : never) : never;

/** One invocation's handle on the installed sink. */
export interface InvocationTrace {
  /** Whether the sink asked for the values bound to a statement. */
  readonly sqlParams: boolean;
  step(step: TraceStepInput): void;
  head(patch: TraceHeadPatch): void;
  /** Milliseconds on the same clock a step's `atMs` reads, for timing a span. */
  now(): number;
}

const clock = (): number => performance.now();

/**
 * The handle for an invocation, or `undefined` when tracing is off or the call has no id.
 * Steps are stamped on the time axis the request layer started (`traceOffsetMs`), so a check
 * here and an outbound call there sort in the order they happened.
 */
export function invocationTrace(invocationId: string | null | undefined): InvocationTrace | undefined {
  const sink = installedTraceSink();
  if (!sink || !invocationId) return undefined;
  const guard = (fn: () => void): void => {
    try {
      fn();
    } catch {
      /* a trace must never fail the request it describes */
    }
  };
  return {
    sqlParams: sink.capture?.sqlParams === true,
    step: (step) =>
      guard(() => sink.step(invocationId, { ...step, atMs: traceOffsetMs(invocationId) } as TraceStep)),
    head: (patch) => guard(() => sink.head(invocationId, patch)),
    now: clock,
  };
}

/** The invocation is over on this host: release its start. (The sink's `end` is the HTTP layer's.) */
export function forgetInvocationTrace(invocationId: string | null | undefined): void {
  if (invocationId) forgetTraceStart(invocationId);
}

export const entityString = (entity: EntityRef | undefined | null): string | null =>
  entity ? `${entity.entityType}:${entity.entityId}` : null;

/**
 * Which path an ALLOW took, read off the proof tuples: a role (`role:<key>`), a system module
 * (`system:<module>`), or a direct / entity-narrowed grant (`grant:<object>`).
 */
export function decidedByOf(proof: readonly RelationTuple[]): string | null {
  for (const t of proof) if (String(t.subject).startsWith('role:')) return String(t.subject);
  for (const t of proof) if (String(t.subject).startsWith('system:')) return String(t.subject);
  for (const t of proof) if (String(t.relation).startsWith('granted:')) return `grant:${String(t.object)}`;
  return null;
}

/**
 * `ctx.sql` with each statement timed and recorded. Rows read are the length of a `query`'s
 * result and rows written the `changes` of an `exec`; the driver reports neither itself.
 * Parameters are stored with minted secrets withheld, and are optional in the shape so a
 * source that must not hold values can leave them out.
 */
type SqlParams = NonNullable<Parameters<ScopedSql['query']>[1]>;

export function tracedSql(
  sql: ScopedSql,
  trace: InvocationTrace | undefined,
  redactText: (text: string) => string,
  redactValue: <T>(value: T) => T,
): ScopedSql {
  if (!trace) return sql;
  const run = <R>(operation: 'query' | 'exec', statement: string, params: SqlParams, call: () => R, rows: (r: R) => object): R => {
    const started = trace.now();
    const at = (error?: string) => ({
      type: 'sql' as const,
      operation,
      statement: redactText(statement),
      // Only what the sink asked for: a bound value is as likely a person's data as an id.
      ...(trace.sqlParams ? { params: redactValue([...params]) } : {}),
      durationMs: Math.max(0, Math.round(trace.now() - started)),
      ...(error === undefined ? {} : { error }),
    });
    try {
      const result = call();
      trace.step({ ...at(), ...rows(result) });
      return result;
    } catch (err) {
      trace.step(at(redactText(err instanceof Error ? err.message : String(err))));
      throw err;
    }
  };
  return {
    query: ((statement: string, params: SqlParams = []) =>
      run('query', statement, params, () => sql.query(statement, params), (r) => ({ rowsRead: (r as unknown[]).length }))) as ScopedSql['query'],
    exec: ((statement: string, params: SqlParams = []) =>
      run('exec', statement, params, () => sql.exec(statement, params), (r) => ({ rowsWritten: (r as { changes: number }).changes }))) as ScopedSql['exec'],
  };
}
