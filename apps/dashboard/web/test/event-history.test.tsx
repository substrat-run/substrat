import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { causeChips, deliveryStatus, eventSummary, eventTime, newestFirst, payloadRows, stateChangingIds } from '../src/lib/event-history';
import { EntityTimeline } from '../src/views/EventHistory';
import { api, type HistoryEntry } from '../src/lib/api';
import { payloadText, payloadUndecodable } from '../src/lib/history';
import { MOCK_HISTORY_ENTITY, mockEntityHistory } from '../src/lib/mock-timeline';

const entry = (id: string, over: Partial<Record<keyof HistoryEntry, unknown>> = {}) =>
  ({
    id, type: 'account.updated', occurredAt: '2026-07-20T10:00:00.000Z', actor: 'p1', payload: null, authorization: null,
    impersonation: null, piiClass: 'none', subjectId: null, operation: null, version: null, causedBy: null, invocationId: null,
    ...over,
  }) as unknown as HistoryEntry;

describe('event history derivations (#1767)', () => {
  it('orders newest first by id, not by time', () => {
    const rows = newestFirst([entry('01A', { occurredAt: '2026-07-20T10:00:00Z' }), entry('01C'), entry('01B', { occurredAt: '2026-07-20T10:00:00Z' })]);
    expect(rows.map((r) => r.id)).toEqual(['01C', '01B', '01A']);
  });

  it('formats a timestamp like the design, in local time', () => {
    expect(eventTime(new Date(2026, 8, 23, 15, 41, 2).toISOString())).toBe('Wed 23 Sep 15:41:02');
    expect(eventTime('not a time')).toBe('not a time');
  });

  it('marks only the events that moved the lifecycle field', () => {
    const asc = [
      entry('1', { payload: { status: 'invited' } }),
      entry('2', { payload: { status: 'invited', role: 'x' } }),
      entry('3', { payload: { name: 'n' } }),
      entry('4', { payload: { status: 'active' } }),
      entry('5', { payload: null }),
    ];
    expect([...stateChangingIds(asc, 'status')]).toEqual(['1', '4']);
    expect(stateChangingIds(asc, undefined).size).toBe(0);
  });

  it('summarises from recorded fields only', () => {
    expect(eventSummary({ operation: 'a/b', causedBy: null, payload: {} })).toBe('a/b');
    expect(eventSummary({ operation: null, causedBy: 'x' as HistoryEntry['causedBy'], payload: {} })).toBe('emitted by a consumer, reacting to an earlier event');
    expect(eventSummary({ operation: null, causedBy: null, payload: null })).toBe('no operation recorded · payload erased');
  });

  it('diffs only a key the previous event also carried', () => {
    const rows = payloadRows(entry('2', { payload: { status: 'active', role: 'admin', note: 'n' } }), entry('1', { payload: { status: 'invited', role: 'admin' } }));
    expect(rows).toEqual([{ key: 'status', value: 'active', was: 'invited' }, { key: 'role', value: 'admin' }, { key: 'note', value: 'n' }]);
    // A key the previous event never carried has no "before" at all, not an empty one.
    expect(Object.keys(rows![2]!)).toEqual(['key', 'value']);
    expect(payloadRows(entry('1', { payload: { a: 1 } }))).toEqual([{ key: 'a', value: '1' }]);
    expect(payloadRows(entry('1'))).toBeNull();
  });

  it('keeps the three delivery states apart, and times only a delivered one', () => {
    const at = '2026-07-20T10:00:00.000Z';
    expect(deliveryStatus({ state: 'delivered', at: '2026-07-20T10:00:02.100Z', attempts: 1 }, at)).toEqual({ glyph: '✓', text: '+2.1 s', tone: 'success' });
    expect(deliveryStatus({ state: 'retrying', at: '2026-07-20T10:05:00Z', attempts: 2 }, at)).toMatchObject({ text: 'retrying · 2 attempts so far', tone: 'warning' });
    expect(deliveryStatus({ state: 'dead', at, attempts: 1 }, at)).toMatchObject({ text: 'gave up after 1 attempt', tone: 'danger' });
  });

  it('tells a payload that would not decode from an erased one', () => {
    expect(payloadText(null)).toBe('payload erased');
    expect(payloadText(null, 'payload: not valid JSON')).toBe('payload could not be read (payload: not valid JSON)');
    expect(payloadUndecodable({ payload: null, decodeError: 'actor: not valid JSON; payload.x: expected string' })).toBe(true);
    // Another column failing beside an erased payload leaves the payload erased.
    expect(payloadText(null, 'actor: not valid JSON')).toBe('payload erased');
    expect(payloadUndecodable({ payload: null, decodeError: 'payload_hash: bad' })).toBe(false);
  });

  it('the preview answers with the history of the record asked for, and no other', () => {
    expect(mockEntityHistory(MOCK_HISTORY_ENTITY).entries.length).toBeGreaterThan(0);
    expect(mockEntityHistory('01JZ…B2').entries).toEqual([]);
  });

  it('names a beginning only when the chain reached one', () => {
    const root = entry('1', { actor: 'p1', operation: 'a/start', type: 'x.started' });
    const leaf = entry('2', { type: 'x.done', causedBy: '1' });
    expect(causeChips({ chain: [leaf, root], terminal: 'operation' }).map((c) => `${c.kind}:${c.label}`)).toEqual([
      'actor:p1', 'op:a/start', 'event:x.started', 'event:x.done',
    ]);
    expect(causeChips({ chain: [leaf], terminal: 'unrecorded' }).map((c) => c.kind)).toEqual(['cut', 'event']);
  });
});

describe('EntityTimeline', () => {
  let container: HTMLDivElement, root: Root;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  const created = entry('01A', { type: 'account.created', operation: 'm/create', payload: { status: 'new' }, authorization: [{ permission: 'account.create' }], invocationId: 'INV00000000001' });
  const moved = entry('01B', {
    type: 'account.activated', operation: 'm/activate', payload: { status: 'active' }, invocationId: 'INV00000000002',
    authorization: [{ permission: 'account.manage', grant: 'account:01A' }],
    impersonation: { session: 'S1', by: 'support:dana' },
  });
  const click = (el: Element) => act(async () => el.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  const types = () => [...container.querySelectorAll('[data-event-id]')].map((r) => r.getAttribute('data-event-id'));

  it('lists newest first and opens an event into its investigation strips', async () => {
    vi.spyOn(api, 'appEntityHistory').mockResolvedValue({ entries: [created, moved], nextCursor: null } as never);
    vi.spyOn(api, 'appEventCause').mockResolvedValue({ chain: [moved], terminal: 'operation' });
    vi.spyOn(api, 'appEventEffects').mockResolvedValue({
      root: { event: moved, deliveries: [{ consumer: 'billing', state: 'dead', at: moved.occurredAt, error: 'boom', attempts: 3, invocationId: null }], effects: [] },
      terminal: 'complete', count: 1,
    } as never);
    vi.spyOn(api, 'appInvocationEvents').mockResolvedValue({ events: [moved, entry('01Z', { type: 'mail.queued', invocationId: 'INV00000000002' })], truncated: false });

    await act(async () => root.render(<EntityTimeline scopeId="s" entityType="account" entityId="a1" stateField="status" onClose={() => undefined} />));
    expect(types()).toEqual(['01B', '01A']);
    expect(container.textContent).toContain('append-only · newest first');

    await click(container.querySelector('[data-event-id="01B"] button[aria-expanded]')!);
    const text = container.textContent!;
    for (const l of ['Why?', 'What did it do?', 'Same call', 'Allowed by']) expect(text).toContain(l);
    expect(text).toContain('m/activate');
    expect(text).toContain('gave up after 3 attempts');
    expect(text).toContain('mail.queued');
    expect(text).toContain('via grant account:01A');
    expect(text).toContain('Impersonated · support:dana acting as p1');
    // The previous event's value is struck, the new one follows it.
    const struck = [...container.querySelectorAll('span')].find((s) => s.style.textDecoration === 'line-through');
    expect(struck?.textContent).toBe('new');
  });

  it('says an undecodable payload could not be read, never that it was erased', async () => {
    const broken = entry('01C', { type: 'account.updated', operation: 'm/update', decodeError: 'payload: not valid JSON' });
    vi.spyOn(api, 'appEntityHistory').mockResolvedValue({ entries: [broken], nextCursor: null } as never);
    vi.spyOn(api, 'appEventCause').mockResolvedValue({ chain: [broken], terminal: 'operation' });
    vi.spyOn(api, 'appEventEffects').mockResolvedValue({ root: { event: broken, deliveries: [], effects: [] }, terminal: 'complete', count: 1 } as never);
    await act(async () => root.render(<EntityTimeline scopeId="s" entityType="account" entityId="a1" onClose={() => undefined} />));
    await click(container.querySelector('[data-event-id="01C"] button[aria-expanded]')!);
    expect(container.textContent).toContain('payload could not be read (payload: not valid JSON)');
    expect(container.textContent).not.toContain('payload erased');
  });

  it('a record opened while the previous one was reading can still read its own later events', async () => {
    const pending = new Promise<never>(() => undefined);
    const history = vi.spyOn(api, 'appEntityHistory').mockImplementation(async (_s, _t, id, cursor) => {
      if (cursor === 'c1') return pending; // the first record's page never comes back
      return { entries: [entry(id === 'a1' ? '01A' : '01B')], nextCursor: id === 'a1' ? 'c1' : 'c2' } as never;
    });
    const later = () => [...container.querySelectorAll('button')].find((b) => /Read later events|Reading…/.test(b.textContent ?? ''))!;
    await act(async () => root.render(<EntityTimeline scopeId="s" entityType="account" entityId="a1" onClose={() => undefined} />));
    await click(later());
    expect(later().disabled).toBe(true);

    await act(async () => root.render(<EntityTimeline scopeId="s" entityType="account" entityId="a2" onClose={() => undefined} />));
    expect(later().textContent).toBe('Read later events');
    expect(later().disabled).toBe(false);
    await click(later());
    expect(history).toHaveBeenLastCalledWith('s', 'account', 'a2', 'c2');
  });

  it('says the newest events are missing when the walk has more pages', async () => {
    vi.spyOn(api, 'appEntityHistory').mockResolvedValue({ entries: [created], nextCursor: 'c1' } as never);
    await act(async () => root.render(<EntityTimeline scopeId="s" entityType="account" entityId="a1" onClose={() => undefined} />));
    expect(container.textContent).toContain('the newest are not loaded yet');
  });
});
