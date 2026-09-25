import type { ObservabilityLogEvent, ReleaseMarker } from './api';

/**
 * Dev-preview fixtures for the Pulse and Logs page layouts (#1767).
 *
 * Both are anchored to the clock rather than to `mock.ts`'s fixed date: the pages read the
 * last 1h/24h/3d, and a fixture dated last July falls outside every window they offer —
 * which is how the Lines mode came to preview as "No log events in this window".
 */

const back = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

/**
 * One app's release history inside the day: three releases that went live and two pushes,
 * one of them not live yet. Two land close together on purpose — the strip alternates
 * rows so their pills do not overlap, and the newest sits past 85% to show the left hang.
 */
export const MOCK_PULSE_MARKERS: ReleaseMarker[] = [
  { at: back(21 * 60 + 40), kind: 'went-live', version: '0.0.10', versionId: '01J2Q8Z3V9K4W7X2M5N6P7VR01' },
  { at: back(8 * 60 + 20), kind: 'pushed', version: '0.0.11', versionId: '01J2Q8Z3V9K4W7X2M5N6P7VR02' },
  { at: back(8 * 60), kind: 'went-live', version: '0.0.11', versionId: '01J2Q8Z3V9K4W7X2M5N6P7VR02' },
  { at: back(6 * 60 + 50), kind: 'went-live', version: '0.0.12', versionId: '01J2Q8Z3V9K4W7X2M5N6P7VR03' },
  { at: back(95), kind: 'pushed', version: '0.0.13', versionId: '01J2Q8Z3V9K4W7X2M5N6P7VR04' },
];

const svc = 'acme-helpdesk-01j2q8z3v9k4w7x2m5n6p7v300';

/** A stamped invocation ID — a real-shaped ULID, so "filter to this invocation" is offered. */
const inv = (n: number) => `01J2Q8Z3V9K4W7X2M5N6P7${String(n).padStart(4, '0')}`;

type Line = [min: number, level: string, message: string, trigger: string, outcome: string, invocation: number, cpu: number, wall: number];

/**
 * An hour of one app's lines, newest first: requests in threes (the stamped invocation
 * line, a debug line, an info line), one failing invocation, and a warning retry — every
 * level the Lines mode colours, and invocations that share an ID so filtering to one
 * visibly narrows the list.
 */
const LINES: Line[] = [
  [1.2, 'info', 'request.completed op=tickets/reply status=200 ms=41', 'POST /api/tickets/reply', 'ok', 1041, 0.9, 41],
  [1.21, 'debug', 'permission.allow principal=member grant=agent', 'POST /api/tickets/reply', 'ok', 1041, 0.1, 1],
  [3.4, 'info', 'request.completed op=tickets/list status=200 ms=12', 'GET /api/tickets', 'ok', 1040, 0.4, 12],
  [4.0, 'error', 'TypeError: cannot read properties of undefined (reading "status") at /operations/close-ticket', 'POST /api/tickets/close', 'exception', 1039, 3.2, 5],
  [4.01, 'error', 'request.completed op=tickets/close status=500 ms=5', 'POST /api/tickets/close', 'exception', 1039, 0.2, 5],
  [4.02, 'debug', 'permission.allow principal=member grant=agent', 'POST /api/tickets/close', 'exception', 1039, 0.1, 1],
  [7.5, 'warn', 'webhook.retry attempt=2 of 5 reason=upstream_timeout', 'POST /internal/webhook', 'ok', 1038, 1.1, 612],
  [7.51, 'info', 'webhook.delivered attempt=2 status=202', 'POST /internal/webhook', 'ok', 1038, 0.3, 612],
  [11.0, 'log', '{"op":"createTicket","durationMs":34}', 'default.createTicket', 'ok', 1037, 0.4, 34],
  [11.01, 'info', 'process.transition ticket new→open', 'default.createTicket', 'ok', 1037, 0.1, 34],
  [14.8, 'info', 'request.completed op=tickets/assign status=200 ms=28', 'POST /api/tickets/assign', 'ok', 1036, 0.6, 28],
  [14.81, 'debug', 'permission.allow principal=member grant=lead', 'POST /api/tickets/assign', 'ok', 1036, 0.1, 1],
  [19.0, 'log', '{"op":"listTickets","durationMs":11}', 'default.listTickets', 'ok', 1035, 0.3, 11],
  [23.3, 'warn', 'connector.slow provider=mail elapsed=474ms budget=400ms', 'POST /api/tickets/reply', 'ok', 1034, 1.4, 488],
  [23.31, 'info', 'request.completed op=tickets/reply status=200 ms=488', 'POST /api/tickets/reply', 'ok', 1034, 0.5, 488],
  [31.9, 'info', 'scheduled run sla-escalate ok checked=14', 'scheduled sla-escalate', 'ok', 1033, 2.1, 96],
  [38.2, 'info', 'request.completed op=tickets/resolve status=200 ms=19', 'POST /api/tickets/resolve', 'ok', 1032, 0.5, 19],
  [38.21, 'info', 'process.transition ticket open→resolved', 'POST /api/tickets/resolve', 'ok', 1032, 0.1, 19],
  [46.0, 'error', 'request.completed op=tickets/assign status=409 code=conflict', 'POST /api/tickets/assign', 'ok', 1031, 0.7, 22],
  [52.4, 'info', 'request.completed op=tickets/list status=200 ms=9', 'GET /api/tickets', 'ok', 1030, 0.3, 9],
];

export const MOCK_LOG_LINES: ObservabilityLogEvent[] = LINES.map(([min, level, message, trigger, outcome, n, cpu, wall], i) => ({
  timestamp: Date.now() - Math.round(min * 60_000),
  level,
  message,
  service: svc,
  outcome,
  trigger,
  invocation: trigger.startsWith('scheduled') ? 'scheduled' : trigger.startsWith('default.') ? 'rpc' : 'fetch',
  entrypoint: trigger.startsWith('default.') ? 'ScopeDO' : null,
  requestId: `8C1F${String(i).padStart(4, '0')}A9E2`,
  invocationId: inv(n),
  cpuTimeMs: cpu,
  wallTimeMs: wall,
  raw: { $metadata: { trigger, level }, $workers: { outcome, cpuTimeMs: cpu } },
}));
