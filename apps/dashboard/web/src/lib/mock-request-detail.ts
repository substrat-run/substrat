import type { CausedTransition, FollowUp } from './request-detail';
import type { HistoryEntry, ObservabilityLogEvent, RequestRecord } from './api';
import { mockRequestById } from './mock-requests';

/**
 * The request slide-over's preview (#1752 §7a) — one request of the Requests fixture, told
 * the way the real reads would tell it: its stamped line and a few `ctx.log` lines, the
 * events it emitted, what their consumers did, and the move it made. Preview-only.
 */
export interface MockRequestDetail {
  record: RequestRecord | null;
  logs: ObservabilityLogEvent[];
  events: HistoryEntry[];
  followUps: FollowUp[];
  transitions: CausedTransition[];
}

export function mockRequestDetail(invocationId: string): MockRequestDetail {
  const record = mockRequestById(invocationId);
  if (!record || record.timestamp === null) return { record, logs: [], events: [], followUps: [], transitions: [] };
  const end = record.timestamp;
  const start = end - (record.durationMs ?? 0);
  const at = (f: number) => Math.round(start + f * (record.durationMs ?? 0));
  const base = { service: 'ticket0', outcome: 'ok', trigger: record.operation, invocation: 'fetch', entrypoint: null, requestId: null, invocationId, cpuTimeMs: null, wallTimeMs: null };
  const failed = (record.status ?? 200) >= 400;
  const logs: ObservabilityLogEvent[] = [
    { ...base, timestamp: at(0.08), level: 'debug', message: `resolved principal (${record.principalKind ?? 'unknown'})` },
    { ...base, timestamp: at(0.35), level: 'info', message: `loaded ${record.entities[0] ?? 'ticket'}` },
    ...(failed
      ? [{ ...base, timestamp: at(0.62), level: record.status! >= 500 ? 'error' : 'warn', message: `refused: ${record.problemCode}` }]
      : [{ ...base, timestamp: at(0.7), level: 'info', message: 'wrote 1 row, emitted ' + (record.eventTypes[0] ?? 'nothing') }]),
    { ...base, timestamp: end, level: 'log', message: null, raw: { timestamp: end, source: { substrat: 'invocation', ...record } } },
  ];
  const events = record.eventTypes.map(
    (type, i) =>
      ({
        id: `01J8ZEV${String(i).padStart(19, '0')}`,
        type,
        occurredAt: new Date(at(0.72)).toISOString(),
        actor: 'prin_mock',
        payload: {},
        operation: record.operation,
        invocationId,
      }) as unknown as HistoryEntry,
  );
  const followUps: FollowUp[] = events.flatMap((e, i) => [
    { event: e.type, consumer: 'ticket0', state: 'delivered', attempts: 1, error: null, afterResponseMs: 180 + i * 40 },
    ...(e.type === 'ticket.replied'
      ? [{ event: e.type, consumer: 'executor:mailer', state: i % 2 === 0 ? 'delivered' : 'retrying', attempts: i % 2 === 0 ? 1 : 2, error: i % 2 === 0 ? null : 'upstream answered 503', afterResponseMs: 2_100 }]
      : []),
  ]);
  const ref = record.entities[0];
  const transitions: CausedTransition[] =
    ref && !failed && record.operation === 'ticket0/assign'
      ? [{ entityType: 'ticket', entityId: ref.slice(7), from: 'new', to: 'open', field: 'state' }]
      : ref && !failed && record.operation === 'ticket0/reply'
        ? [{ entityType: 'ticket', entityId: ref.slice(7), from: 'open', to: 'waiting', field: 'state' }]
        : [];
  return { record, logs, events, followUps, transitions };
}
