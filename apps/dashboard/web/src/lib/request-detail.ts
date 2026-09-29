import type { EffectsTree, EmittedLifecycle, HistoryEntry } from '@substrat-run/contracts';

/** A log line, as far as this file reads one — the client's `LogLine` is assignable. */
export interface LogLine {
  timestamp: number | null;
  level: string | null;
  message: string | null;
  raw?: unknown;
}

/** The stamped request line, as the Requests view lists it (#1746). Defined here, re-exported by the client. */
export interface RequestRecord {
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
  for (const e of logs) {
    const raw = e.raw as Record<string, unknown> | undefined;
    const source = raw && typeof raw['source'] === 'object' && raw['source'] !== null ? (raw['source'] as Record<string, unknown>) : null;
    if (!source || source['substrat'] !== 'invocation') continue;
    return {
      timestamp: num(raw!['timestamp']) ?? e.timestamp,
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
    };
  }
  return null;
}

/** Whether a log line is the stamped invocation line itself — the slide-over lists it as the request, not as a line. */
export function isInvocationLine(e: LogLine): boolean {
  const raw = e.raw as Record<string, unknown> | undefined;
  const source = raw?.['source'] as Record<string, unknown> | undefined;
  return source?.['substrat'] === 'invocation';
}

export interface TimelineMark {
  kind: 'log' | 'event';
  /** Milliseconds from the start of the request; may fall past its end (work after the response). */
  offsetMs: number;
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
  marks.sort((a, b) => a.offsetMs - b.offsetMs || (a.kind === b.kind ? 0 : a.kind === 'event' ? 1 : -1));
  const axisMs = Math.max(durationMs, ...marks.map((m) => m.offsetMs), 1);
  return { startMs, durationMs, marks, axisMs };
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
