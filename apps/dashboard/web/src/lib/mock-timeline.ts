import type { Page } from '@substrat-run/contracts';
import type { CauseChain, EffectsTree, EventDelivery, HistoryEntry, InvocationEvents, ObservabilityLogEvent } from './api';
import type { TimelineTarget } from './history';

/**
 * Dev-preview fixtures for a record's Event history (#1767) — the Data tab's
 * `meridian_account` rows open this. One account's life: invited, accepted, promoted by
 * a support engineer acting as the owner, suspended by a schedule, reactivated by a
 * consumer, then renamed by a seeded call that carried no request id. Between them they
 * exercise every branch the card draws: a transition and a non-transition, a role and a
 * grant, an impersonation, a consumer cause, all three delivery states, a sibling in
 * the same call, and a row with no call to link to.
 */

/** What the model would say about the mock tables: which entity, which key, which lifecycle field. */
export const MOCK_TIMELINE_TARGETS: Record<string, TimelineTarget> = {
  meridian_account: { entityType: 'account', idColumn: 'id', stateField: 'status' },
};

const OWNER = '01JZ0PRINCIPAL00000000OWNR';
const ADA = '01JZ0PRINCIPAL000000000ADA';

const INV_INVITE = '01JZ4A1C9W0INVITE000000001';
const INV_ACCEPT = '01JZ4B7K2M0ACCEPT000000002';
const INV_ROLE = '01JZ5C3P8Q0SETROLE00000003';
const INV_SWEEP = '01JZ6D0000SWEEP00000000004';
const INV_SIGNIN = '01JZ6F5R1T0SIGNIN000000005';

// Branded ids and instants are plain strings here; the fixture is typed at the boundary.
const ev = (e: Record<string, unknown> & { id: string; occurredAt: string }): HistoryEntry =>
  ({
    payload: null,
    authorization: null,
    impersonation: null,
    piiClass: 'none',
    subjectId: null,
    operation: null,
    version: '0.4.2',
    causedBy: null,
    invocationId: null,
    ...e,
  }) as unknown as HistoryEntry;

const account = (status: string, role: string, extra: Record<string, unknown> = {}) => ({
  status,
  email: 'ada@meridian.test',
  role,
  ...extra,
});

const INVITED = ev({
  id: '01JZ4A1CA00000000000000E01' as HistoryEntry['id'],
  type: 'account.invited' as HistoryEntry['type'],
  occurredAt: '2026-07-18T09:12:04.120Z',
  actor: OWNER as HistoryEntry['actor'],
  operation: 'meridian/invite-account',
  authorization: [{ permission: 'account.invite' }] as HistoryEntry['authorization'],
  piiClass: 'direct',
  payload: account('invited', 'member'),
  invocationId: INV_INVITE,
});
const QUEUED = ev({
  id: '01JZ4A1CA00000000000000E02' as HistoryEntry['id'],
  type: 'invite.email-queued' as HistoryEntry['type'],
  occurredAt: '2026-07-18T09:12:04.120Z',
  actor: OWNER as HistoryEntry['actor'],
  operation: 'meridian/invite-account',
  invocationId: INV_INVITE,
});
const SENT = ev({
  id: '01JZ4A1CA00000000000000E03' as HistoryEntry['id'],
  type: 'invite.email-sent' as HistoryEntry['type'],
  occurredAt: '2026-07-18T09:12:05.310Z',
  actor: { system: 'mailer' } as HistoryEntry['actor'],
  causedBy: INVITED.id,
  invocationId: INV_INVITE,
});
const ACTIVATED = ev({
  id: '01JZ4B7K2M00000000000000E4' as HistoryEntry['id'],
  type: 'account.activated' as HistoryEntry['type'],
  occurredAt: '2026-07-18T14:03:51.004Z',
  actor: ADA as HistoryEntry['actor'],
  operation: 'meridian/accept-invite',
  authorization: [{ permission: 'account.accept', grant: 'account:01JZ4A1CA00000000000000E01' }] as HistoryEntry['authorization'],
  payload: account('active', 'member'),
  invocationId: INV_ACCEPT,
});
const ROLE = ev({
  id: '01JZ5C3P8Q00000000000000E5' as HistoryEntry['id'],
  type: 'account.role-changed' as HistoryEntry['type'],
  occurredAt: '2026-07-20T10:31:40.500Z',
  actor: OWNER as HistoryEntry['actor'],
  operation: 'meridian/set-role',
  authorization: [{ permission: 'account.manage' }] as HistoryEntry['authorization'],
  impersonation: { session: '01JZ5C0SESSION000000000001', by: 'support:dana' } as HistoryEntry['impersonation'],
  payload: account('active', 'admin'),
  invocationId: INV_ROLE,
});
const SUSPENDED = ev({
  id: '01JZ6D0000A0000000000000E6' as HistoryEntry['id'],
  type: 'account.suspended' as HistoryEntry['type'],
  occurredAt: '2026-07-21T02:00:00.048Z',
  actor: { system: 'schedule:sweep-inactive' } as HistoryEntry['actor'],
  operation: 'meridian/sweep-inactive',
  authorization: [] as HistoryEntry['authorization'],
  payload: account('suspended', 'admin', { reason: 'inactive 30 days' }),
  invocationId: INV_SWEEP,
});
const SIGNED_IN = ev({
  id: '01JZ6F5R1T00000000000000E7' as HistoryEntry['id'],
  type: 'session.started' as HistoryEntry['type'],
  occurredAt: '2026-07-21T08:44:17.902Z',
  actor: ADA as HistoryEntry['actor'],
  operation: 'meridian/sign-in',
  authorization: [{ permission: 'session.start' }] as HistoryEntry['authorization'],
  invocationId: INV_SIGNIN,
});
const REACTIVATED = ev({
  id: '01JZ6F5R1T00000000000000E8' as HistoryEntry['id'],
  type: 'account.reactivated' as HistoryEntry['type'],
  occurredAt: '2026-07-21T08:44:18.310Z',
  actor: { system: 'meridian' } as HistoryEntry['actor'],
  causedBy: SIGNED_IN.id,
  payload: account('active', 'admin', { reason: null }),
  invocationId: INV_SIGNIN,
});
const RENAMED = ev({
  id: '01JZ7G2H3J00000000000000E9' as HistoryEntry['id'],
  type: 'account.profile-updated' as HistoryEntry['type'],
  occurredAt: '2026-07-22T16:20:09.000Z',
  actor: ADA as HistoryEntry['actor'],
  operation: 'meridian/update-profile',
  authorization: [{ permission: 'account.update-own' }] as HistoryEntry['authorization'],
  payload: { display_name: 'Ada King' },
  version: null,
});

/** The account's history, oldest first — the order the read walks it. */
const HISTORY: HistoryEntry[] = [INVITED, ACTIVATED, ROLE, SUSPENDED, REACTIVATED, RENAMED];
const ALL = [...HISTORY, QUEUED, SENT, SIGNED_IN];

/**
 * The history is Ada's, so only Ada's row answers with it. The Data tab's other accounts
 * get what the read gives a record nothing has happened to — an empty page — rather than
 * Ada's story under their id.
 */
export const MOCK_HISTORY_ENTITY = '01JZ…A1';

export function mockEntityHistory(entityId: string): Page<HistoryEntry> {
  return { entries: entityId === MOCK_HISTORY_ENTITY ? HISTORY : [], nextCursor: null } as Page<HistoryEntry>;
}

export function mockEventCause(eventId: string): CauseChain {
  if (eventId === REACTIVATED.id) return { chain: [REACTIVATED, SIGNED_IN], terminal: 'operation' };
  const e = ALL.find((x) => x.id === eventId);
  return e ? { chain: [e], terminal: 'operation' } : { chain: [], terminal: 'missing' };
}

const delivered = (consumer: string, at: string) => ({ consumer, state: 'delivered', at, error: null, attempts: 1, invocationId: null });

export function mockEventEffects(eventId: string): EffectsTree {
  const e = ALL.find((x) => x.id === eventId);
  if (!e) return { root: null, terminal: 'missing', count: 0 };
  const deliveries: Record<string, unknown[]> = {
    [INVITED.id]: [delivered('executor:mailer', '2026-07-18T09:12:05.310Z'), delivered('meridian', '2026-07-18T09:12:04.480Z')],
    [ACTIVATED.id]: [delivered('meridian', '2026-07-18T14:03:51.390Z')],
    [ROLE.id]: [
      delivered('meridian', '2026-07-20T10:31:40.910Z'),
      { consumer: 'executor:audit-export', state: 'retrying', at: '2026-07-20T10:36:41.000Z', error: 'upstream answered 503', attempts: 2, invocationId: null },
    ],
    [SUSPENDED.id]: [{ consumer: 'executor:billing', state: 'dead', at: '2026-07-21T02:00:01.200Z', error: 'seat not found', attempts: 1, invocationId: null }],
  };
  const children = e.id === INVITED.id ? [{ event: SENT, deliveries: [], effects: [] }] : [];
  return {
    root: { event: e, deliveries: (deliveries[e.id] ?? []) as EventDelivery[], effects: children },
    terminal: 'complete',
    count: 1 + children.length,
  };
}

export function mockInvocationEvents(invocationId: string): InvocationEvents {
  return { events: ALL.filter((e) => e.invocationId === invocationId).sort((a, b) => (a.id < b.id ? -1 : 1)), truncated: false };
}

export function mockCallLogs(invocationId: string): ObservabilityLogEvent[] {
  const e = ALL.find((x) => x.invocationId === invocationId && x.operation !== null);
  if (!e) return [];
  const t = Date.parse(e.occurredAt);
  const base = { service: 'meridian', trigger: e.operation ?? 'consumer', invocation: 'rpc', entrypoint: 'ScopeDO', requestId: null, invocationId, cpuTimeMs: 0.6 };
  return [
    { ...base, timestamp: t + 40, level: 'log', message: JSON.stringify({ op: e.operation, status: 200, durationMs: 41 }), outcome: 'ok', wallTimeMs: 41 },
    { ...base, timestamp: t + 12, level: 'log', message: `${e.operation}: ${e.type}`, outcome: 'ok', wallTimeMs: null },
  ];
}
