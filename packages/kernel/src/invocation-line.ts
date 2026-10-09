/**
 * The invocation line's grammar: the shape of the one structured log line written per
 * invocation, and the one function that builds it (#1901).
 *
 * Two writers build through it, in two packages. The request line is written by
 * `invocationLog` / `withInvocationLog` in `@substrat-run/vertical-host`, the host-side
 * middleware that moved there from the kernel (#1978). The async line — a consumer
 * delivery or a schedule run — is written by the scope host itself
 * (`async-invocation-log.ts`), which is why the grammar stays here: both adapters run that
 * writer, and a field added to one line is a field added to both, in one order.
 *
 * Imports nothing at run time. The platform's entry (#1893) bundles this file in front of
 * every deployed vertical through the `./invocation-line` subpath, and a runtime import of
 * the contracts root would put every schema in the vocabulary — and zod — into that bundle.
 */
import type { InvocationLevel } from '@substrat-run/contracts/invocation-record';
import type { EmittedReport } from './scope-host.js';

/**
 * The field walk's answer for one response (#1331). Names only, and only names the
 * operation DECLARES: a key the response carries that the declaration does not name is
 * never written down, since a key can be data (a map keyed by email is still a map). No
 * value is ever read into it.
 */
export interface OutputFieldsReport {
  /** Declared fields the response carried with a value other than `null`, in declaration order. */
  present: string[];
  /** Declared fields the response carried as `null` — on the wire, carrying nothing. */
  empty: string[];
  /** Declared fields the response did not carry (missing, or `undefined`). */
  absent: string[];
}

/**
 * The shape of the emitted line. Deliberately a published contract rather than an
 * incidental object: the read proxy filters on these key names, and Workers Logs indexes
 * a `JSON.stringify`ed `console.log` as queryable TOP-LEVEL fields (`tenantId`, not
 * `$metadata.tenantId` nor `source.tenantId` — verified against the live telemetry API).
 * Renaming a key here silently empties a view, because a filter on a key that does not
 * exist returns `success: true` with zero events. Add fields; never rename one.
 */
export interface InvocationLogLine {
  /** Discriminator — what lets a reader tell this line from a vertical's own output. */
  substrat: 'invocation';
  /**
   * #1901: what kind of work the line is about. ABSENT on a request's line — the line every
   * reader already knew — and present only on the scope host's lines for async work: a
   * consumer delivery (`consumer`) or a schedule run (`schedule`). A reader treats a missing
   * `kind` as `request`, which keeps every line written before this field existed meaning
   * what it meant.
   */
  kind?: AsyncInvocationKind;
  tenantId: string;
  scopeId: string | null;
  vertical: string | null;
  /**
   * The K-26 surface that answered. Taken from the verified node, so an assertion that
   * named none reads as `readRoutedNode`'s documented default (`app`) rather than as a
   * null only this writer would produce — one representation across the platform.
   */
  surface: string | null;
  /** The request's method. `null` on an async line (#1901), which no request carried. */
  method: string | null;
  /** Path ONLY — see `pathOf`. `null` on an async line (#1901). */
  path: string | null;
  /**
   * #1237: the id every event this invocation emitted is stamped with.
   *
   * The join nothing could make before. `$metadata.requestId` correlates the LINES of
   * one invocation, and it is stamped by the log platform at ingestion — no code here
   * can read it, and the spine could not have been given it. So the platform mints its
   * own, writes it here, and carries it to the scope on `InvokeOptions`.
   *
   * Which makes this line the other half of a trace: the events say what happened and
   * in what order, and this says how long the whole call took and how it ended.
   */
  invocationId: string;
  /**
   * The response status as the caller received it — including the status `onError`
   * mapped a thrown error to.
   *
   * Hono composes `onError` INSIDE the handler chain, not around it, so a handler that
   * throws does not reject this middleware's `await next()`: the envelope has already
   * turned it into a response by the time control comes back, and `c.res` holds the
   * mapped status. That is worth stating because the opposite is the natural guess, and
   * guessing it would have put `null` on every error line — the exact rows a tenant
   * opens this view to find.
   *
   * `null` therefore survives only for a genuine escape: an error that got past the
   * envelope itself, which `threw` marks.
   *
   * Always `null` on an async line (#1901): no caller received a status. Its `outcome` and
   * `level` say how it ended instead.
   */
  status: number | null;
  /** The error escaped even `onError` — rare, and the most interesting line on the page. */
  threw: boolean;
  durationMs: number;
  /*
   * #1746: the per-request record. Everything below is ADDITIVE to the line above and is
   * `null` (or empty) when nothing filled it in — a custom route, an older vertical-host,
   * an older scope host. A reader treats `null` as "not recorded", never as a value.
   */
  /** Contracts' `invocationLevelOf`. Always present: it is derived from the two fields above. */
  level: InvocationLevel;
  /** The operation that ran. `null` for a route that is not a mounted operation. */
  operation: string | null;
  /** The kernel `errorCode` of a failed call, when it has one. */
  problemCode: string | null;
  /** Who the call ran as: `principal`, `connection`, `system`, `capability` or `vertical`. */
  principalKind: string | null;
  /**
   * How many events the operation itself emitted. `null` when not recorded, which is
   * different from `0`: a read emits nothing, and that is a fact about it.
   */
  eventCount: number | null;
  /** The distinct types among those events, in emission order (capped, see `entities`). */
  eventTypes: string[];
  /**
   * The distinct entities those events were about, as `<entityType>:<entityId>`. Taken from
   * at most `EMITTED_REPORT_CAP` events, so a bulk operation's line names the first few and
   * `eventCount` says how many there were.
   */
  entities: string[];
  /**
   * The registry id of the version that served the call — the platform's
   * `SUBSTRAT_VERSION_ID` binding, the same identity the spine stamps on events. `null`
   * locally and on a script pushed before the binding existed.
   */
  versionId: string | null;
  /**
   * #1331: which declared output fields the response carried. The one field on this line
   * that is OMITTED rather than `null` when unrecorded: the walk behind it is off by
   * default, and an unarmed line must stay byte-for-byte what it was before the field
   * existed. A reader treats absence exactly as it treats `null` elsewhere.
   */
  outputFields?: OutputFieldsReport;
  /**
   * #1923: the router's dispatch id for the request whose response {@link outputFields}
   * describes — its provenance. Present exactly when `outputFields` is: a reader joins it to
   * the router's own line for the request, and counts the report only for the tenant and app
   * that line names.
   */
  fieldCoverageId?: string;
  /*
   * #1901: the async line's own fields. Present only when `kind` is, and written by
   * `asyncInvocationLine` (`async-invocation-log.ts`) — ids, names, counts and codes only,
   * never an event's payload or a handler's error text.
   */
  /** How the unit ended — see {@link AsyncOutcome}. */
  outcome?: AsyncOutcome;
  /** A consumer's event type. */
  eventType?: string | null;
  /** A consumer's event id — the join to the spine's outbox and delivery journal. */
  eventId?: string | null;
  /** Which attempt at this delivery the line is about, counting from 1. */
  attempt?: number | null;
  /** A schedule run's due time (ISO 8601), or `null` for a schedule's first run. */
  dueAt?: string | null;
  /** How late the run started against `dueAt`, in milliseconds; `null` on a first run. */
  latenessMs?: number | null;
  /** A `suppressed` line's count of the lines the pass's cap withheld. */
  suppressed?: number;
  /** The same count per `<kind>:<outcome>`, so a storm of one outcome is named, not averaged. */
  suppressedBy?: Record<string, number>;
}

/** #1901: the kinds of async work a scope host writes a line for. A request has no `kind`. */
export type AsyncInvocationKind = 'consumer' | 'schedule';

/**
 * #1901: how a unit of async work ended.
 *
 * - `delivered` — a consumer's handler ran and its delivery is journaled done.
 * - `retrying` — the handler threw and the delivery is due again later.
 * - `dead-lettered` — the delivery is journaled failed for good: the handler threw on its
 *   last attempt, or the event never reached it (undecodable, a schema version the consumer
 *   does not take, withheld by the producer).
 * - `inert` — a copy of a scope (#2005): the delivery is journaled terminal and NO handler
 *   ran. Never `delivered`, because nothing was.
 * - `routed` — the delivery was handed to the platform's drain to run with authority this
 *   host lacks (a connector on a control-plane-less host).
 * - `ok` / `failed` — a schedule run.
 * - `suppressed` — the pass's line cap was reached; the line counts what it withheld.
 */
export type AsyncOutcome =
  | 'delivered'
  | 'retrying'
  | 'dead-lettered'
  | 'inert'
  | 'routed'
  | 'ok'
  | 'failed'
  | 'suppressed';

/**
 * The fields of an invocation line, before defaults. The ONE place the line's grammar lives
 * (#1901): the request writer (`vertical-host`'s `invocationLog`) and the scope host's async writer both build through
 * {@link invocationLine}, so a field added to one is a field added to both, in one order.
 */
export interface InvocationLineFields {
  kind?: AsyncInvocationKind;
  tenantId: string;
  scopeId: string | null;
  vertical?: string | null;
  surface?: string | null;
  method?: string | null;
  path?: string | null;
  invocationId: string;
  status?: number | null;
  threw: boolean;
  durationMs: number;
  level: InvocationLevel;
  operation?: string | null;
  problemCode?: string | null;
  principalKind?: string | null;
  emitted?: EmittedReport;
  /**
   * #1901: write `entities` from `emitted` (the default). An async line passes `false`: an
   * entity id is data a vertical chose — an email, a customer number — and the async line
   * carries ids the platform minted, declared names and codes only. Its `entities` is then
   * always `[]`, which a reader takes as "not recorded" beside a non-null `eventCount`.
   */
  withEntities?: boolean;
  versionId?: string | null;
  outputFields?: OutputFieldsReport;
  /** #1923: written only beside `outputFields`. */
  fieldCoverageId?: string;
  async?: Pick<
    InvocationLogLine,
    'outcome' | 'eventType' | 'eventId' | 'attempt' | 'dueAt' | 'latenessMs' | 'suppressed' | 'suppressedBy'
  >;
}

/** Build a line. Unfilled fields are `null` (or empty), as the line's contract says. */
export function invocationLine(f: InvocationLineFields): InvocationLogLine {
  const emitted = f.emitted;
  return {
    substrat: 'invocation',
    ...(f.kind ? { kind: f.kind } : {}),
    tenantId: f.tenantId,
    scopeId: f.scopeId,
    vertical: f.vertical ?? null,
    surface: f.surface ?? null,
    method: f.method ?? null,
    path: f.path ?? null,
    status: f.status ?? null,
    threw: f.threw,
    durationMs: f.durationMs,
    invocationId: f.invocationId,
    level: f.level,
    operation: f.operation ?? null,
    problemCode: f.problemCode ?? null,
    principalKind: f.principalKind ?? null,
    eventCount: emitted ? emitted.total : null,
    eventTypes: emitted ? distinct(emitted.events.map((e) => e.type)) : [],
    entities: emitted && f.withEntities !== false ? distinct(emitted.events.map((e) => e.entity)) : [],
    versionId: f.versionId ?? null,
    ...(f.outputFields ? { outputFields: f.outputFields, ...(f.fieldCoverageId ? { fieldCoverageId: f.fieldCoverageId } : {}) } : {}),
    ...(f.async ?? {}),
  };
}

/** Distinct values, first occurrence wins — the order a reader expects to see them in. */
function distinct(values: readonly string[]): string[] {
  return [...new Set(values)];
}
