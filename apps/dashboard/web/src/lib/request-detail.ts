import { authChecksOf, type AuthRecording } from '@substrat-run/contracts/auth-diagnostics';
import type { CauseChain, EffectsTree, EmittedLifecycle, HistoryEntry } from '@substrat-run/contracts';
import { outboundCallsOf, type OutboundCall } from '@substrat-run/control-plane-api/browser';
import { ulidTime } from './palette.js';

export type { OutboundCall };

/** A log line, as far as this file reads one — the client's `LogLine` is assignable. */
export interface LogLine {
  timestamp: number | null;
  level: string | null;
  message: string | null;
  raw?: unknown;
}

/** The stamped request line, as the Requests view lists it (#1746). Defined here, re-exported by the client. */
export interface RequestRecord extends AuthRecording {
  timestamp: number | null;
  invocationId: string | null;
  scopeId: string | null;
  vertical: string | null;
  surface: string | null;
  method: string | null;
  path: string | null;
  status: number | null;
  threw: boolean;
  durationMs: number | null;
  level: string | null;
  operation: string | null;
  problemCode: string | null;
  principalKind: string | null;
  eventCount: number | null;
  eventTypes: string[];
  entities: string[];
  versionId: string | null;
  /**
   * #1901: `request`, or the kind of async work the scope host logged (`consumer`,
   * `schedule`). Optional, with the outcome fields below: a plane older than #1901 sends none,
   * and a row without them is a request's.
   */
  kind?: string;
  outcome?: string | null;
  eventType?: string | null;
  eventId?: string | null;
  attempt?: number | null;
  latenessMs?: number | null;
  /**
   * #2192: the outbound `fetch` calls the request made, as its line names them, and how many
   * past the line's cap were counted instead. Optional: a plane older than #2192 sends neither,
   * and a row without them made no call the line recorded.
   */
  outboundCalls?: OutboundCall[];
  outboundCallsDropped?: number;
  /**
   * #2192: the request that started this one through a peer call, as the caller named it.
   * Absent on a line that names none; only ever read as one ULID.
   */
  parentInvocationId?: string | null;
  /** #2192: the scope that parent's line is in — the calling app. Only ever read as one ULID. */
  parentScopeId?: string | null;
}

/** #2192: a line's parent (or its scope), only as a ULID — anything else is none. */
const parentOf = (v: unknown): string | null => (typeof v === 'string' && ulidTime(v) !== null ? v : null);

/** #1901: a line's kind, absent read as `request`. */
export function kindOf(v: unknown): 'request' | 'consumer' | 'schedule' {
  return v === 'consumer' || v === 'schedule' ? v : 'request';
}

/** The stamped line of a log event, or null. */
function invocationSource(e: LogLine): Record<string, unknown> | null {
  const raw = e.raw as Record<string, unknown> | undefined;
  const source = raw && typeof raw['source'] === 'object' && raw['source'] !== null ? (raw['source'] as Record<string, unknown>) : null;
  return source && source['substrat'] === 'invocation' ? source : null;
}

/**
 * One request, as the slide-over tells it (#1752, design §7a) — derived from reads that
 * already exist, because the design's waterfall of spans is the one part not recorded yet
 * (#1237):
 *
 * - **the request** is its stamped invocation line (#1746), found among the call's own log
 *   lines — so the slide-over opens from anywhere that holds a call id, not only a row;
 * - **the time axis** places each log line and each emitted event at its offset from the
 *   start, where the spans will later go;
 * - **the transition it caused** comes from the entities the request touched, read back
 *   through each one's history against the model's declared lifecycle;
 * - **the follow-ups** are the deliveries of what it emitted, timed from the response.
 *
 * Pure, so each of those is tested without a worker.
 */

const str = (v: unknown) => (typeof v === 'string' ? v : null);
const num = (v: unknown) => (typeof v === 'number' ? v : null);
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/**
 * The request record, from the call's stamped invocation line — the same mapping the
 * control plane's request list makes (`requestRecordOf`), so a slide-over opened from a log
 * line and one opened from a Requests row describe the request identically.
 */
export function recordFromLogs(logs: LogLine[]): RequestRecord | null {
  // #1901: a call's consumers share its id, so its lines can hold several stamped lines.
  // The request's own (no `kind`) is the record; an async line is only when there is none —
  // work a sweep ran, under an id of its own.
  const stamped = logs.flatMap((e) => {
    const source = invocationSource(e);
    return source ? [{ e, source }] : [];
  });
  const found = stamped.find((l) => kindOf(l.source['kind']) === 'request') ?? stamped[0];
  if (found) {
    const { e, source } = found;
    const raw = e.raw as Record<string, unknown>;
    return {
      timestamp: num(raw['timestamp']) ?? e.timestamp,
      invocationId: str(source['invocationId']),
      scopeId: str(source['scopeId']),
      vertical: str(source['vertical']),
      surface: str(source['surface']),
      method: str(source['method']),
      path: str(source['path']),
      status: num(source['status']),
      threw: source['threw'] === true,
      durationMs: num(source['durationMs']),
      level: str(source['level']),
      operation: str(source['operation']),
      problemCode: str(source['problemCode']),
      principalKind: str(source['principalKind']),
      eventCount: num(source['eventCount']),
      eventTypes: strings(source['eventTypes']),
      entities: strings(source['entities']),
      versionId: str(source['versionId']),
      kind: kindOf(source['kind']),
      outcome: str(source['outcome']),
      eventType: str(source['eventType']),
      eventId: str(source['eventId']),
      attempt: num(source['attempt']),
      latenessMs: num(source['latenessMs']),
      authChecks: authChecksOf(source['authChecks']),
      authChecksDropped: num(source['authChecksDropped']) ?? 0,
      outboundCalls: outboundCallsOf(source['outboundCalls']),
      outboundCallsDropped: num(source['outboundCallsDropped']) ?? 0,
      parentInvocationId: parentOf(source['parentInvocationId']),
      parentScopeId: parentOf(source['parentScopeId']),
    };
  }
  return null;
}

/**
 * Whether a log line is a REQUEST's stamped line — the slide-over lists it as the request,
 * not as a line. A consumer's or a schedule's line (#1901) is work the call caused, so it is
 * listed with the call's other lines, at the moment it ended.
 */
export function isInvocationLine(e: LogLine): boolean {
  const source = invocationSource(e);
  return source !== null && kindOf(source['kind']) === 'request';
}

export interface TimelineMark {
  kind: 'log' | 'event' | 'call';
  /** Milliseconds from the start of the request; may fall past its end (work after the response). */
  offsetMs: number;
  /** #2192: an outbound call's time to its response, drawn as a bar from `offsetMs`. */
  durationMs?: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  label: string;
}

export interface RequestTimeline {
  /** Epoch ms the request started: the line is written as it ends, so `end − duration`. */
  startMs: number;
  durationMs: number;
  marks: TimelineMark[];
  /** The axis the marks are drawn on: the request, or further when a mark lands after it. */
  axisMs: number;
}

const levelOf = (l: string | null): TimelineMark['level'] =>
  l === 'error' ? 'error' : l === 'warn' || l === 'warning' ? 'warn' : l === 'debug' ? 'debug' : 'info';

export function requestTimeline(
  record: RequestRecord,
  logs: LogLine[],
  events: Pick<HistoryEntry, 'type' | 'occurredAt'>[],
): RequestTimeline | null {
  if (record.timestamp === null || record.durationMs === null) return null;
  const durationMs = Math.max(0, record.durationMs);
  const startMs = record.timestamp - durationMs;
  const marks: TimelineMark[] = [];
  for (const l of logs) {
    if (l.timestamp === null || isInvocationLine(l)) continue;
    marks.push({ kind: 'log', offsetMs: l.timestamp - startMs, level: levelOf(l.level), label: l.message ?? '' });
  }
  for (const e of events) {
    const at = Date.parse(e.occurredAt);
    if (Number.isFinite(at)) marks.push({ kind: 'event', offsetMs: at - startMs, level: 'info', label: e.type });
  }
  // #2192: the line measures each call from the request's own start, so no clock is compared.
  for (const c of record.outboundCalls ?? []) {
    marks.push({ kind: 'call', offsetMs: c.atMs, durationMs: c.durationMs, level: outboundCallLevel(c), label: outboundCallLabel(c) });
  }
  marks.sort((a, b) => a.offsetMs - b.offsetMs || (a.kind === b.kind ? 0 : a.kind === 'event' ? 1 : -1));
  const axisMs = Math.max(durationMs, ...marks.map((m) => m.offsetMs + (m.durationMs ?? 0)), 1);
  return { startMs, durationMs, marks, axisMs };
}

/**
 * #2192: how an outbound call reads on the timeline. A refusal, a timeout, a failure and a 5xx
 * are what broke the request, so they are errors; any other 4xx is a warning.
 */
export function outboundCallLevel(c: OutboundCall): TimelineMark['level'] {
  if (c.outcome === 'ok') return 'info';
  if (c.outcome === 'http-error' && c.status !== null && c.status < 500) return 'warn';
  return 'error';
}

/** #2192: what an outbound call answered, in a word: its status, or how it ended without one. */
export function outboundCallResult(c: OutboundCall): string {
  if (c.outcome === 'refused') return `${c.status ?? 403} refused by the platform`;
  if (c.status !== null) return String(c.status);
  return c.reason ? `${c.outcome} (${c.reason})` : c.outcome;
}

/** #2192: `POST api.example.com/oauth2/token → 403 refused by the platform`. */
export function outboundCallLabel(c: OutboundCall): string {
  return `${c.method} ${c.host}${c.path} → ${outboundCallResult(c)}`;
}

/** `conversation:01J…` → its type and id. The type is before the FIRST colon: ids may hold colons, types do not. */
export function parseEntity(ref: string): { entityType: string; entityId: string } | null {
  const i = ref.indexOf(':');
  if (i <= 0 || i === ref.length - 1) return null;
  return { entityType: ref.slice(0, i), entityId: ref.slice(i + 1) };
}

export interface CausedTransition {
  entityType: string;
  entityId: string;
  /** Null when no earlier event of this entity carries the state: the move's origin is not on record. */
  from: string | null;
  to: string;
  /** The field the lifecycle moves, for the timeline the transition links to. */
  field: string;
}

/** Only an unclassified payload is read for the state — the process map's rule (#1762). */
const stateIn = (e: HistoryEntry, field: string): string | null => {
  if (e.piiClass !== 'none') return null;
  const p = e.payload;
  if (p === null || typeof p !== 'object') return null;
  const v = (p as Record<string, unknown>)[field];
  return typeof v === 'string' ? v : null;
};

/**
 * The transition a request caused on one entity, from that entity's history (newest first):
 * the state its last event in THIS call carries, against the state carried by the newest
 * event before the call. No move — the call only touched the entity, or nothing in it
 * carries the state — is no transition, and says nothing.
 */
export function causedTransition(
  entityType: string,
  entityId: string,
  invocationId: string,
  lifecycle: EmittedLifecycle,
  history: HistoryEntry[],
): CausedTransition | null {
  const ordered = [...history].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const firstIn = ordered.findIndex((e) => e.invocationId === invocationId);
  if (firstIn < 0) return null;
  let to: string | null = null;
  for (const e of ordered) if (e.invocationId === invocationId) to = stateIn(e, lifecycle.field) ?? to;
  if (to === null || !(to in lifecycle.states)) return null;
  let from: string | null = null;
  for (const e of ordered.slice(0, firstIn)) from = stateIn(e, lifecycle.field) ?? from;
  if (from === to) return null;
  return { entityType, entityId, from, to, field: lifecycle.field };
}

export interface FollowUp {
  event: string;
  consumer: string;
  state: string;
  attempts: number;
  error: string | null;
  /** From the response, in ms: negative when a consumer ran inside the request's own tail. */
  afterResponseMs: number | null;
}

/** The deliveries of what the request emitted, flattened through the effects tree, timed from the response. */
export function followUps(trees: EffectsTree[], responseAtMs: number | null): FollowUp[] {
  const out: FollowUp[] = [];
  const walk = (node: EffectsTree['root']) => {
    if (!node) return;
    for (const d of node.deliveries) {
      const at = Date.parse(d.at);
      out.push({
        event: node.event.type,
        consumer: d.consumer,
        state: d.state,
        attempts: d.attempts,
        error: d.error,
        afterResponseMs: responseAtMs !== null && Number.isFinite(at) ? at - responseAtMs : null,
      });
    }
    for (const child of node.effects) walk(child);
  };
  for (const t of trees) walk(t.root);
  return out;
}

/** A duration as the waterfall writes it: milliseconds below a second, seconds from there. */
export function msLabel(ms: number): string {
  const abs = Math.abs(ms);
  const s = abs >= 1000 ? `${(abs / 1000).toFixed(abs >= 10_000 ? 0 : 1)} s` : `${Math.round(abs)} ms`;
  return ms < 0 ? `−${s}` : s;
}

/**
 * Another request that shares a cause with this one (#2192), found only from what the spine
 * records: an event's `causedBy` and `invocationId`, and a delivery's attempt `invocationId`.
 *
 * - `caused-by`: walking an emitted event's cause chain back, the first event that was
 *   emitted under a different call. That call is what set this one off.
 * - `set-off`: a delivery of what this request emitted that ran under a different call (a
 *   retry or a drain), or an event emitted downstream under a different call.
 *
 * Consumers delivered inside the call share its id, so they are not listed here: they are
 * the request's own. A peer call is the one path with no event that is recorded: the called
 * request's line names its caller (`parentInvocationId`, #2192), so it lists that caller as
 * `caused-by`. The caller's side does not list the peer calls it made, and an MCP call or a
 * platform request records no parent, so those cannot appear.
 */
export interface RelatedRequest {
  relation: 'caused-by' | 'set-off';
  invocationId: string;
  /** When to look for its lines: the event's or the delivery attempt's instant. */
  at: string;
  /** What links it: the event type, and the consumer for a delivery. */
  via: string;
  /**
   * #2192: the app its lines are in, when that is not this request's own: a peer call's caller
   * is another app. `null` when the line did not say which (it predates the field), and then it
   * cannot be opened.
   */
  scopeId?: string | null;
}

/** What the related-requests read could cover, and whether it covered it all. */
export interface RelatedResult {
  requests: RelatedRequest[];
  /** Why the list may be missing some, or null when every read was made and none failed. */
  incomplete: string | null;
}

export function relatedRequests(
  own: string,
  trees: EffectsTree[],
  causes: CauseChain[],
  /** #2192: the request's own line, whose `parentInvocationId` names the request that called it. */
  record?: Pick<RequestRecord, 'parentInvocationId' | 'parentScopeId'> | null,
): RelatedRequest[] {
  const out = new Map<string, RelatedRequest>();
  const add = (r: RelatedRequest) => {
    // The first sighting wins, so a cause is not relabelled by a later delivery.
    if (r.invocationId !== own && !out.has(r.invocationId)) out.set(r.invocationId, r);
  };
  // The caller's id is its claim, so it is only ever a link: opening it reads that id in the
  // calling app, under this team's own tenant, where another tenant's request matches nothing.
  const parentAt = record?.parentInvocationId ? ulidTime(record.parentInvocationId) : null;
  if (record?.parentInvocationId && parentAt !== null) {
    add({
      relation: 'caused-by',
      invocationId: record.parentInvocationId,
      at: new Date(parentAt).toISOString(),
      via: 'peer call',
      scopeId: record.parentScopeId ?? null,
    });
  }
  for (const c of causes) {
    const cause = c.chain.slice(1).find((e) => e.invocationId !== null && e.invocationId !== own);
    if (cause) add({ relation: 'caused-by', invocationId: cause.invocationId!, at: cause.occurredAt, via: cause.type });
  }
  const walk = (node: EffectsTree['root']) => {
    if (!node) return;
    for (const d of node.deliveries) {
      if (d.invocationId) add({ relation: 'set-off', invocationId: d.invocationId, at: d.at, via: `${node.event.type} → ${d.consumer}` });
    }
    for (const child of node.effects) {
      if (child.event.invocationId) add({ relation: 'set-off', invocationId: child.event.invocationId, at: child.event.occurredAt, via: child.event.type });
      walk(child);
    }
  };
  for (const t of trees) walk(t.root);
  return [...out.values()];
}
