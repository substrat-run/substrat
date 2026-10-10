/**
 * One invocation line per unit of ASYNC work the scope host runs (#1901): a consumer
 * delivery (a module consumer, an executor, an imported event's handler) and a schedule run.
 *
 * ## Why the scope host writes it
 *
 * A request's line is written by the platform's entry around the worker's `fetch` (#1893),
 * and that entry trusts a tenant only from the router's verified assertion. A delivery or a
 * sweep pass carries none, so before this a consumer that failed every attempt was visible
 * only as a dead-letter count. The scope host needs no assertion: it runs the dispatch, for
 * a scope it was asked about by tenant, so it knows the tenant, the scope, the consumer or
 * schedule, the event, the attempt and the outcome first-hand.
 *
 * ## Same line, one more field
 *
 * The line is the request line's shape, built by the same `invocationLine`, plus `kind` and
 * the fields only async work has. Readers that knew the request line read this one without
 * change: the level histogram, the operation facet and the patterns all count it, and a
 * reader that treats a missing `kind` as `request` keeps every older line's meaning.
 *
 * ## Ids, names and codes — nothing else
 *
 * No payload, no error message, no stack: a handler's error text can quote the event it
 * failed on, and the log store is read by a wider audience than the scope's own data. The
 * error stays where it already is, on the delivery journal row the line's `eventId` names.
 * The kernel's `errorCode` of a thrown error is the one thing taken from it. And no entity
 * id either: a schedule's emitted report names the entities it touched, and an entity id is
 * whatever the vertical chose — an email address is a valid one. The line keeps the count
 * and the declared event types.
 *
 * Field by field: `tenantId`, `scopeId`, `invocationId`, `eventId` are platform-minted ids;
 * `operation` is a declared consumer, executor or schedule name; `eventType` and
 * `eventTypes` are declared types; `problemCode` is the kernel's closed `errorCode`
 * vocabulary; `principalKind`, `outcome` and `kind` are closed sets; the rest are numbers
 * and times.
 *
 * ## Bounded
 *
 * A pass writes at most {@link ASYNC_LINES_PER_PASS} unit lines. Past that it writes one
 * `suppressed` line counting what it withheld PER `<kind>:<outcome>`, so a storm of
 * dead-letters is named in the line that stands in for it, never averaged into a total.
 *
 * ## Ships with the vertical
 *
 * This is the scope host's code, which a vertical bundles. A vertical writes these lines
 * from the release of its adapter that has them — not from the platform's deploy, unlike the
 * request line's wrapper (#1893).
 */
import { errorCodeOf } from '@substrat-run/contracts';
import type { InvocationLevel } from '@substrat-run/contracts/invocation-record';
import { ulid } from './ulid.js';
import {
  invocationLine,
  type AsyncInvocationKind,
  type AsyncOutcome,
  type InvocationLogLine,
} from './invocation-line.js';
import type { EmittedReport } from './scope-host.js';

/** One unit of async work, as the host saw it end. */
export interface AsyncUnit {
  kind: AsyncInvocationKind;
  tenantId: string;
  scopeId: string;
  /**
   * The id the unit's `ctx.log` lines and the line itself share. The call's own id when the
   * unit ran in a call's tail, so the call's drill-down shows it; otherwise one minted for
   * the unit ({@link asyncInvocationId}).
   */
  invocationId: string;
  /** A consumer's name (its module, or `executor:<id>`), or a schedule's operation. */
  operation: string;
  /** `Date.now()` when the unit started — host code, so the real clock. */
  startedAt: number;
  outcome: Exclude<AsyncOutcome, 'suppressed'>;
  /** The handler threw. Only its `errorCode` is kept; see the header. */
  error?: unknown;
  eventType?: string;
  eventId?: string;
  attempt?: number;
  dueAt?: string | null;
  latenessMs?: number | null;
  /** Who the work ran as. A consumer and a schedule run as `system`; an import as its peer. */
  principalKind?: string;
  emitted?: EmittedReport;
  versionId?: string | null;
}

/** Where a host sends an async line. The default writes it to the runtime's console. */
export type InvocationLineSink = (line: InvocationLogLine) => void;

// Runtime global, declared rather than imported, as in `invocation-log.ts`.
declare const console: { log(message: string): void };

/** The default sink: one JSON line, as the request line is written. */
export const consoleInvocationLineSink: InvocationLineSink = (line) => console.log(JSON.stringify(line));

/** The most unit lines one pass writes before it starts counting instead. */
export const ASYNC_LINES_PER_PASS = 100;

/**
 * The level of an async unit. A thrown handler is an error whatever happens next — it broke,
 * retry or not. A unit that ended without its handler doing the work — dead-lettered without
 * a throw, held inert on a copy, refused by a schedule — is a warning: nothing broke, and it
 * is still not success. Everything else is info.
 */
export function asyncLevelOf(outcome: AsyncOutcome, threw: boolean): InvocationLevel {
  if (threw) return 'error';
  if (outcome === 'dead-lettered' || outcome === 'inert' || outcome === 'failed') return 'warn';
  return 'info';
}

/** The invocation id for a unit: the call it ran in, or a fresh one. */
export function asyncInvocationId(callId: string | null | undefined): string {
  return callId ?? ulid();
}

/** The line for one unit — through the request line's own builder. */
export function asyncInvocationLine(unit: AsyncUnit): InvocationLogLine {
  const threw = unit.error !== undefined;
  return invocationLine({
    kind: unit.kind,
    tenantId: unit.tenantId,
    scopeId: unit.scopeId,
    invocationId: unit.invocationId,
    threw,
    durationMs: Math.max(0, Date.now() - unit.startedAt),
    level: asyncLevelOf(unit.outcome, threw),
    operation: unit.operation,
    problemCode: threw ? (errorCodeOf(unit.error) ?? null) : null,
    principalKind: unit.principalKind ?? 'system',
    // The count and the declared event types only: never the entities, whose ids are the
    // vertical's data (see the header).
    ...(unit.emitted ? { emitted: unit.emitted } : {}),
    withEntities: false,
    versionId: unit.versionId ?? null,
    async: {
      outcome: unit.outcome,
      ...(unit.kind === 'consumer'
        ? { eventType: unit.eventType ?? null, eventId: unit.eventId ?? null, attempt: unit.attempt ?? null }
        : { dueAt: unit.dueAt ?? null, latenessMs: unit.latenessMs ?? null }),
    },
  });
}

/** One pass's writer: the cap, and the line that stands in for what the cap withheld. */
export interface AsyncLinePass {
  /** Write a unit's line, or count it once the pass is over its cap. Never throws. */
  write(unit: AsyncUnit): void;
  /** Write the `suppressed` line, if anything was withheld. Call once, when the pass ends. */
  end(): void;
}

/**
 * Open a pass. Every write is swallowed on failure: a line that cannot be written is one
 * missing line, never a failed delivery — the delivery has already been journaled.
 */
export function asyncLinePass(
  sink: InvocationLineSink = consoleInvocationLineSink,
  cap: number = ASYNC_LINES_PER_PASS,
): AsyncLinePass {
  let written = 0;
  let withheld: { first: AsyncUnit; levels: Set<InvocationLevel>; by: Record<string, number>; n: number } | null =
    null;
  const safe = (line: () => InvocationLogLine) => {
    try {
      sink(line());
    } catch {
      /* see above */
    }
  };
  return {
    write(unit) {
      if (written < cap) {
        written += 1;
        safe(() => asyncInvocationLine(unit));
        return;
      }
      withheld ??= { first: unit, levels: new Set(), by: {}, n: 0 };
      const key = `${unit.kind}:${unit.outcome}`;
      withheld.by[key] = (withheld.by[key] ?? 0) + 1;
      withheld.levels.add(asyncLevelOf(unit.outcome, unit.error !== undefined));
      withheld.n += 1;
    },
    end() {
      if (!withheld) return;
      const w = withheld;
      withheld = null;
      safe(() =>
        invocationLine({
          kind: w.first.kind,
          tenantId: w.first.tenantId,
          scopeId: w.first.scopeId,
          invocationId: w.first.invocationId,
          threw: false,
          durationMs: 0,
          // The worst level withheld, so the histogram still shows an error pass as one.
          level: w.levels.has('error') ? 'error' : w.levels.has('warn') ? 'warn' : 'info',
          principalKind: w.first.principalKind ?? 'system',
          versionId: w.first.versionId ?? null,
          async: { outcome: 'suppressed', suppressed: w.n, suppressedBy: w.by },
        }),
      );
    },
  };
}
