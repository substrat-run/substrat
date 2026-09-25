import type { DeadLetter, FlowEdge, FlowNode, FlowView } from './api';

/**
 * Dev-preview fixtures (VITE_DEV_MOCK) for Processes › Flow (#1767): one small helpdesk
 * app, wired so every state the view draws appears once — a healthy path, a declared
 * type never emitted, one that ran and stopped, a connection that needs reconnecting, an
 * idle one, dead letters with and without a call, and refusals.
 */

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

const node = (n: Partial<FlowNode> & Pick<FlowNode, 'id' | 'kind' | 'label'>): FlowNode => ({
  sublabel: null,
  observed: null,
  silent: false,
  stale: false,
  status: 'ok',
  title: `${n.label}.`,
  x: 0,
  y: 0,
  w: 0,
  h: 0,
  ...n,
});

const event = (type: string, observed: number, extra: Partial<FlowNode> = {}): FlowNode =>
  node({
    id: `event:${type}`,
    kind: 'event',
    label: type,
    observed,
    sublabel: observed === 0 ? 'none recorded' : `${observed.toLocaleString()} recorded`,
    title: observed === 0 ? `${type} is declared and none has been recorded.` : `${type}: ${observed.toLocaleString()} recorded in this app’s events.`,
    silent: observed === 0,
    ...extra,
  });

const emits = (m: string, t: string): FlowEdge => ({ from: `module:${m}`, to: `event:${t}`, kind: 'emits', title: `${m} emits ${t}` });
const handles = (t: string, m: string): FlowEdge => ({ from: `event:${t}`, to: `module:${m}`, kind: 'consumes', title: `${m} handles ${t}` });

export const MOCK_FLOW_VIEW: FlowView = {
  graph: {
    available: true,
    partialObservation: false,
    declaredComplete: true,
    width: 0,
    height: 0,
    nodes: [
      node({ id: 'trigger:http', kind: 'trigger', label: 'HTTP requests', sublabel: 'on demand', title: 'Requests to this app’s own routes.' }),
      node({ id: 'trigger:schedule:sla:escalate-overdue', kind: 'trigger', label: 'escalate-overdue', sublabel: 'every 15 minutes', title: 'A declared schedule: sla runs escalate-overdue every 15 minutes.' }),
      node({ id: 'trigger:schedule:digest:send-digest', kind: 'trigger', label: 'send-digest', sublabel: 'daily', title: 'A declared schedule: digest runs send-digest daily.' }),
      node({ id: 'module:assignment', kind: 'module', label: 'assignment', sublabel: '1 emitted · 1 handled' }),
      node({ id: 'module:digest', kind: 'module', label: 'digest', sublabel: '1 emitted · 2 handled' }),
      node({ id: 'module:notify', kind: 'module', label: 'notify', sublabel: '0 emitted · 2 handled' }),
      node({ id: 'module:sla', kind: 'module', label: 'sla', sublabel: '1 emitted · 0 handled' }),
      node({ id: 'module:tickets', kind: 'module', label: 'tickets', sublabel: '3 emitted · 0 handled' }),
      event('ticket.created', 1284),
      event('ticket.replied', 3912),
      event('ticket.merged', 0),
      event('ticket.assigned', 1146),
      event('sla.checked', 212, {
        stale: true,
        sublabel: '212 · last 34d ago',
        title: 'sla.checked: 212 recorded, the last 34 days ago. It ran and stopped, which is a different thing from never having run.',
      }),
      event('digest.sent', 58),
      node({ id: 'connection:slack', kind: 'connection', label: 'slack', sublabel: 'connected', title: 'slack is connected; last used today.' }),
      node({ id: 'connection:fortnox', kind: 'connection', label: 'fortnox', sublabel: 'needs reconnecting', status: 'danger', title: 'fortnox is connected but not usable (expired).' }),
      node({ id: 'connection:scrive', kind: 'connection', label: 'scrive', sublabel: 'connected · unused 14d', silent: true, title: 'scrive is connected, and nothing has passed through it in the last 14 days.' }),
      node({ id: 'egress:hooks.slack.com', kind: 'egress', label: 'hooks.slack.com', sublabel: 'declared egress', title: 'hooks.slack.com is on this version’s outbound allowlist.' }),
      node({ id: 'egress:api.fortnox.se', kind: 'egress', label: 'api.fortnox.se', sublabel: 'declared egress', title: 'api.fortnox.se is on this version’s outbound allowlist.' }),
    ],
    edges: [
      { from: 'trigger:schedule:sla:escalate-overdue', to: 'module:sla', kind: 'triggers', title: 'escalate-overdue runs inside sla' },
      { from: 'trigger:schedule:digest:send-digest', to: 'module:digest', kind: 'triggers', title: 'send-digest runs inside digest' },
      emits('tickets', 'ticket.created'),
      emits('tickets', 'ticket.replied'),
      emits('tickets', 'ticket.merged'),
      emits('assignment', 'ticket.assigned'),
      emits('sla', 'sla.checked'),
      emits('digest', 'digest.sent'),
      handles('ticket.created', 'assignment'),
      handles('ticket.created', 'notify'),
      handles('ticket.replied', 'notify'),
      handles('ticket.assigned', 'digest'),
      handles('sla.checked', 'digest'),
    ],
  },
  findings: {
    available: true,
    observedComplete: true,
    declaredComplete: true,
    declaredTypes: 6,
    observedTypes: 5,
    findings: [
      { kind: 'unemitted', subject: 'ticket.merged', moduleId: 'tickets', detail: 'tickets declares it emits ticket.merged, and none has been recorded.' },
      { kind: 'unconsumed', subject: 'digest.sent', moduleId: 'digest', detail: 'digest.sent is emitted and no module declares a handler for it.' },
      { kind: 'stale', subject: 'sla.checked', moduleId: 'sla', detail: 'sla.checked last recorded 34 days ago, after 212 before it.' },
      { kind: 'unhealthy-provider', subject: 'fortnox', moduleId: null, detail: 'This app uses fortnox and its connection has expired. Work that needs it fails until it is reconnected.' },
    ],
  },
  operations: {
    observedComplete: true,
    refusals: { complete: true, held: 40, counted: 40, since: ago(9 * 86_400_000) },
    rows: [
      { operation: 'tickets/post-reply', events: 3912, lastSeen: ago(4_000), refusals: 0, refusedOnly: false },
      { operation: 'tickets/open', events: 1284, lastSeen: ago(60_000), refusals: 0, refusedOnly: false },
      { operation: 'assignment/assign', events: 1146, lastSeen: ago(12_000), refusals: 38, refusedOnly: false },
      { operation: 'sla/escalate-overdue', events: 212, lastSeen: ago(34 * 86_400_000), refusals: 0, refusedOnly: false },
      { operation: 'tickets/merge', events: 0, lastSeen: null, refusals: 2, refusedOnly: true },
    ],
  },
  connectionSweep: {
    windowDays: 14,
    idleCount: 1,
    rows: [
      { connectionId: 'conn-slack', provider: 'slack', label: 'Acme workspace', status: 'active', lastSweptAt: ago(40_000), lastOutcomeFailed: false, unknown: false, idle: false },
      { connectionId: 'conn-fortnox', provider: 'fortnox', label: 'Acme AB books', status: 'expired', lastSweptAt: ago(26 * 3_600_000), lastOutcomeFailed: true, unknown: false, idle: false },
      { connectionId: 'conn-scrive', provider: 'scrive', label: 'Acme signing', status: 'active', lastSweptAt: null, lastOutcomeFailed: null, unknown: false, idle: true },
    ],
  },
};

export const MOCK_DEAD_LETTERS: DeadLetter[] = [
  {
    eventId: '01J9MOCKEVT00000000000000A1',
    eventType: 'ticket.replied',
    occurredAt: ago(2 * 3_600_000),
    entity: { entityType: 'ticket', entityId: '01J9MOCKTKT00000000000000T1' },
    invocationId: '01J9MOCKINV00000000000000E1',
    attemptInvocationId: '01J9MOCKINV00000000000000A1',
    consumer: 'notify',
    at: ago(90 * 60_000),
    error: 'connector_timeout: hooks.slack.com did not answer in 10s',
    attempts: 5,
  },
  {
    eventId: '01J9MOCKEVT00000000000000A2',
    eventType: 'sla.checked',
    occurredAt: ago(34 * 86_400_000),
    entity: { entityType: 'ticket', entityId: '01J9MOCKTKT00000000000000T2' },
    invocationId: null,
    attemptInvocationId: null,
    consumer: 'digest',
    at: ago(34 * 86_400_000),
    error: 'validation_failed: missing breach_at',
    attempts: 1,
  },
] as DeadLetter[];
