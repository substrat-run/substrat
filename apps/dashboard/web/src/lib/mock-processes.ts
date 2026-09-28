import type { LifecycleFlowResult, ProcessMapView, ProcessPeriod } from './api';

/**
 * A process map for `VITE_DEV_MOCK` (#1744): a support conversation shaped like ticket0's,
 * with every kind of edge the screen draws — busy, skipped, returning, never taken, seen
 * late and undeclared — so the screen can be judged without a replay behind it.
 */
const H = 3_600_000;

function flow(scale: number, since: string, until: string): LifecycleFlowResult {
  const n = (x: number) => Math.round(x * scale);
  const edge = (from: string, to: string, operation: string | null, count: number, extra: Partial<LifecycleFlowResult['edges'][number]> = {}) => ({
    from,
    to,
    operation,
    count: n(count),
    actors: count === 0 ? {} : { principal: n(count * 0.8), system: n(count) - n(count * 0.8) },
    declared: true,
    seenLate: false,
    ...extra,
  });
  return {
    entityType: 'conversation',
    since,
    until,
    edges: [
      edge('new', 'open', 'ticket0/assign', 1102),
      edge('new', 'open', 'ticket0/post-public-reply', 182),
      edge('new', 'resolved', 'ticket0/resolve', 7),
      edge('new', 'closed', 'ticket0/close', 0),
      edge('open', 'snoozed', 'ticket0/snooze', 412),
      edge('open', 'resolved', 'ticket0/resolve', 1102),
      edge('open', 'closed', 'ticket0/close', 31),
      edge('snoozed', 'open', 'ticket0/wake-snoozed', 368),
      edge('snoozed', 'resolved', 'ticket0/resolve', 44),
      edge('snoozed', 'closed', 'ticket0/close', 0),
      edge('resolved', 'open', 'ticket0/ingest-message', 58),
      edge('resolved', 'open', null, 38, { seenLate: true }),
      edge('resolved', 'closed', 'ticket0/close', 1016),
      edge('closed', 'open', 'ticket0/ingest-message', 12, { declared: false }),
    ],
    states: [
      { state: 'closed', terminal: true, current: n(1016), entered: n(1047), dwell: null, stuck: [] },
      {
        state: 'new',
        terminal: false,
        current: n(23),
        entered: 0,
        dwell: { samples: n(1291), medianMs: 18 * 60_000, p90Ms: 52 * 60_000 },
        stuck: [
          { entityId: '01J8ZQ4C7X0000000000000001', since: new Date(Date.parse(until) - 5 * H).toISOString(), lastOperation: 'ticket0/ingest-message', lastAt: new Date(Date.parse(until) - 5 * H).toISOString() },
        ],
      },
      {
        state: 'open',
        terminal: false,
        current: n(142),
        entered: n(1760),
        dwell: { samples: n(1545), medianMs: 3 * H + 40 * 60_000, p90Ms: 19 * H },
        stuck: [
          { entityId: '01J8ZQ4C7X0000000000000002', since: new Date(Date.parse(until) - 70 * H).toISOString(), lastOperation: 'ticket0/post-note', lastAt: new Date(Date.parse(until) - 20 * H).toISOString() },
          { entityId: '01J8ZQ4C7X0000000000000003', since: new Date(Date.parse(until) - 51 * H).toISOString(), lastOperation: 'ticket0/assign', lastAt: new Date(Date.parse(until) - 51 * H).toISOString() },
        ],
      },
      {
        state: 'resolved',
        terminal: false,
        current: n(88),
        entered: n(1153),
        dwell: { samples: n(1112), medianMs: 49 * H, p90Ms: 72 * H },
        stuck: [],
      },
      {
        state: 'snoozed',
        terminal: false,
        current: n(61),
        entered: n(412),
        dwell: { samples: n(412), medianMs: 26 * H, p90Ms: 76 * H },
        stuck: [
          { entityId: '01J8ZQ4C7X0000000000000004', since: new Date(Date.parse(until) - 140 * H).toISOString(), lastOperation: 'ticket0/snooze', lastAt: new Date(Date.parse(until) - 140 * H).toISOString() },
        ],
      },
    ],
    funnel: { started: n(1284), reached: { new: n(1284), open: n(1269), snoozed: n(380), resolved: n(1102), closed: n(1016) } },
    totals: { started: n(1284), finished: n(1016), inFlight: n(314), medianLifecycleMs: 54 * H },
    observation: { entities: n(1598), events: n(9120), inferred: n(310), unexplained: 0, seenLate: n(38), complete: true },
  };
}

export function mockProcessView(period: ProcessPeriod): ProcessMapView {
  const span = { '24h': 24 * H, '7d': 7 * 24 * H, '30d': 30 * 24 * H }[period];
  const scale = span / (7 * 24 * H);
  const now = Date.now();
  const iso = (t: number) => new Date(t).toISOString();
  return {
    versionId: '01J8ZQ4C7X00000000000VERSN',
    processes: [
      { entity: 'conversation', initial: 'new', states: 5, edges: 17 },
      { entity: 'signup', initial: 'pending', states: 3, edges: 4 },
    ],
    entity: 'conversation',
    lifecycle: MOCK_CONVERSATION_LIFECYCLE,
    period,
    current: flow(scale, iso(now - span), iso(now)),
    previous: flow(scale * 0.93, iso(now - 2 * span), iso(now - span)),
    unavailable: null,
  };
}

/** The lifecycle the mock replays — the part of ticket0's model.json the map needs. */
export const MOCK_CONVERSATION_LIFECYCLE = {
  field: 'state',
  initial: 'new',
  states: {
    closed: { terminal: true as const },
    new: { on: { 'ticket0/assign': 'open', 'ticket0/close': 'closed', 'ticket0/post-public-reply': 'open', 'ticket0/resolve': 'resolved' } },
    open: { on: { 'ticket0/close': 'closed', 'ticket0/resolve': 'resolved', 'ticket0/snooze': 'snoozed' } },
    resolved: { on: { 'ticket0/close': 'closed', 'ticket0/ingest-message': 'open' } },
    snoozed: { on: { 'ticket0/close': 'closed', 'ticket0/resolve': 'resolved', 'ticket0/wake-snoozed': 'open' } },
  },
};
