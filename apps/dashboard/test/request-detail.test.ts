import { describe, expect, it } from 'vitest';
import type { EffectsTree, EmittedLifecycle, HistoryEntry } from '@substrat-run/contracts';
import { causedTransition, followUps, msLabel, parseEntity, recordFromLogs, requestTimeline } from '../web/src/lib/request-detail.js';

/** The request slide-over's derivations (#1752 §7a), each from a read that exists today. */

type ObservabilityLogEvent = Parameters<typeof recordFromLogs>[0][number];

const line = (over: Partial<ObservabilityLogEvent>): ObservabilityLogEvent => ({ timestamp: null, level: 'log', message: null, ...over });

const stamped = (source: Record<string, unknown>, timestamp = 10_000) =>
  line({ timestamp, raw: { timestamp, source: { substrat: 'invocation', invocationId: 'CALL1', ...source } } });

describe('recordFromLogs', () => {
  it('reads the request off its stamped invocation line, mapped as the request list maps it', () => {
    const r = recordFromLogs([
      line({ timestamp: 9_950, message: 'assigning', raw: { source: { substrat: 'log' } } }),
      stamped({ operation: 'desk/assign', status: 200, durationMs: 120, principalKind: 'principal', entities: ['conversation:C1', 7], eventTypes: ['desk.assigned'] }),
    ]);
    expect(r).toMatchObject({ invocationId: 'CALL1', operation: 'desk/assign', status: 200, durationMs: 120, timestamp: 10_000, entities: ['conversation:C1'], eventTypes: ['desk.assigned'], problemCode: null, threw: false });
  });

  it('#1901: reads the request off its own line when the call\'s consumers logged under its id too', () => {
    const consumer = stamped({ kind: 'consumer', operation: 'executor:notify', outcome: 'retrying', attempt: 1, eventType: 'desk.assigned' }, 10_050);
    const r = recordFromLogs([consumer, stamped({ operation: 'desk/assign', status: 200, durationMs: 120 })]);
    expect(r).toMatchObject({ operation: 'desk/assign', status: 200, kind: 'request' });
    // …and the consumer's line is a mark on the request, not the request.
    const t = requestTimeline(r!, [consumer], [])!;
    expect(t.marks).toEqual([expect.objectContaining({ kind: 'log', offsetMs: 170 })]);
    // A sweep's delivery has no request around it: its own line is the record.
    expect(recordFromLogs([consumer])).toMatchObject({ kind: 'consumer', outcome: 'retrying', attempt: 1, eventType: 'desk.assigned' });
  });

  it('is null when the call has no stamped line to read', () => {
    expect(recordFromLogs([line({ raw: { source: { substrat: 'log' } } })])).toBeNull();
  });
});

describe('requestTimeline', () => {
  it('places lines and events at their offset from the start, which is the end minus the duration', () => {
    const record = recordFromLogs([stamped({ durationMs: 200 })])!;
    const t = requestTimeline(
      record,
      [stamped({ durationMs: 200 }), line({ timestamp: 9_850, level: 'warn', message: 'slow lookup' })],
      [{ type: 'desk.assigned', occurredAt: new Date(9_900).toISOString() } as unknown as Pick<HistoryEntry, 'type' | 'occurredAt'>],
    )!;
    expect(t.startMs).toBe(9_800);
    // The stamped line is the request itself, not a line on it.
    expect(t.marks).toEqual([
      { kind: 'log', offsetMs: 50, level: 'warn', label: 'slow lookup' },
      { kind: 'event', offsetMs: 100, level: 'info', label: 'desk.assigned' },
    ]);
    expect(t.axisMs).toBe(200);
  });

  it('widens the axis for work that landed after the response', () => {
    const record = recordFromLogs([stamped({ durationMs: 100 })])!;
    const t = requestTimeline(record, [line({ timestamp: 10_400, message: 'tail work' })], [])!;
    expect(t.marks[0]!.offsetMs).toBe(500);
    expect(t.axisMs).toBe(500);
  });

  it('draws nothing without a duration to measure against', () => {
    expect(requestTimeline(recordFromLogs([stamped({})])!, [], [])).toBeNull();
  });
});

describe('parseEntity', () => {
  it('splits at the first colon, since an id may hold more', () => {
    expect(parseEntity('conversation:01J:x')).toEqual({ entityType: 'conversation', entityId: '01J:x' });
    expect(parseEntity('nocolon')).toBeNull();
    expect(parseEntity(':id')).toBeNull();
  });
});

const LIFECYCLE: EmittedLifecycle = {
  field: 'state',
  initial: 'new',
  states: { new: { on: { 'desk/assign': 'open' } }, open: { on: { 'desk/resolve': 'resolved' } }, resolved: { terminal: true } },
};
const ev = (id: string, invocationId: string, payload: unknown): HistoryEntry =>
  ({ id, type: 't', occurredAt: '2026-09-29T10:00:00.000Z', actor: 'p', payload, piiClass: 'none', invocationId }) as unknown as HistoryEntry;

describe('causedTransition', () => {
  it('reads the move from the newest state before the call to the last state inside it', () => {
    const history = [ev('03', 'CALL1', { state: 'resolved' }), ev('02', 'CALL0', { state: 'open' }), ev('01', 'SEED', { state: 'new' })];
    expect(causedTransition('conversation', 'C1', 'CALL1', LIFECYCLE, history)).toEqual({
      entityType: 'conversation', entityId: 'C1', from: 'open', to: 'resolved', field: 'state',
    });
  });

  it('says nothing when the call only touched the entity', () => {
    const history = [ev('02', 'CALL1', { state: 'open', note: 'x' }), ev('01', 'CALL0', { state: 'open' })];
    expect(causedTransition('conversation', 'C1', 'CALL1', LIFECYCLE, history)).toBeNull();
    expect(causedTransition('conversation', 'C1', 'CALL1', LIFECYCLE, [ev('01', 'CALL1', { note: 'x' })])).toBeNull();
  });

  it('keeps the origin unknown rather than guessing when nothing before the call carries the state', () => {
    expect(causedTransition('conversation', 'C1', 'CALL1', LIFECYCLE, [ev('01', 'CALL1', { state: 'open' })])).toMatchObject({ from: null, to: 'open' });
  });

  it('does not read the state from a classified payload', () => {
    const classified = { ...ev('02', 'CALL1', { state: 'resolved' }), piiClass: 'pseudonymous' } as HistoryEntry;
    expect(causedTransition('conversation', 'C1', 'CALL1', LIFECYCLE, [classified, ev('01', 'CALL0', { state: 'open' })])).toBeNull();
  });

  it('ignores a state the lifecycle does not declare', () => {
    expect(causedTransition('conversation', 'C1', 'CALL1', LIFECYCLE, [ev('01', 'CALL1', { state: 'archived' })])).toBeNull();
  });
});

describe('followUps', () => {
  it('flattens the deliveries through the tree, timed from the response', () => {
    const node = (type: string, deliveries: unknown[], effects: unknown[] = []) => ({ event: { type }, deliveries, effects });
    const tree = {
      root: node(
        'desk.assigned',
        [{ consumer: 'notify', state: 'delivered', at: new Date(12_100).toISOString(), attempts: 1, error: null }],
        [node('notify.sent', [{ consumer: 'executor:mailer', state: 'retrying', at: new Date(15_000).toISOString(), attempts: 2, error: '503' }])],
      ),
      terminal: 'complete',
      count: 2,
    } as unknown as EffectsTree;
    expect(followUps([tree], 10_000)).toEqual([
      { event: 'desk.assigned', consumer: 'notify', state: 'delivered', attempts: 1, error: null, afterResponseMs: 2_100 },
      { event: 'notify.sent', consumer: 'executor:mailer', state: 'retrying', attempts: 2, error: '503', afterResponseMs: 5_000 },
    ]);
  });
});

describe('msLabel', () => {
  it('writes milliseconds below a second and seconds from there', () => {
    expect(msLabel(842)).toBe('842 ms');
    expect(msLabel(2_100)).toBe('2.1 s');
    expect(msLabel(-40)).toBe('−40 ms');
  });
});
