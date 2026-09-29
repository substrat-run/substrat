import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EntityTimeline } from '../src/views/EventHistory';
import { api, type EmittedLifecycle, type HistoryEntry } from '../src/lib/api';

/**
 * #1916: a record's history with its lifecycle drawn above it. The one behaviour the
 * history card changes is how much it reads: a to-scale bar of the oldest page alone would
 * end the record's story wherever that page did, so with a lifecycle it reads ahead.
 */
const LC: EmittedLifecycle = {
  field: 'state',
  initial: 'new',
  states: { new: { on: { 'desk/assign': 'open' } }, open: { on: { 'desk/close': 'closed' } }, closed: { terminal: true } },
};
const ev = (id: string, at: string, op: string, state: string): HistoryEntry =>
  ({
    id, type: 'desk.changed', occurredAt: at, actor: 'prin_ada', payload: { state }, authorization: null, impersonation: null,
    piiClass: 'none', subjectId: null, operation: op, version: null, causedBy: null, invocationId: `CALL-${id}`,
  }) as unknown as HistoryEntry;

describe('EntityTimeline with a lifecycle', () => {
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

  const pages = () =>
    vi.spyOn(api, 'appEntityHistory').mockImplementation(async (_s, _t, _i, cursor) =>
      cursor === undefined
        ? { entries: [ev('01A', '2026-09-21T00:00:00.000Z', 'desk/create', 'new'), ev('01B', '2026-09-21T02:00:00.000Z', 'desk/assign', 'open')], nextCursor: 'p2' }
        : { entries: [ev('01C', '2026-09-22T02:00:00.000Z', 'desk/close', 'closed')], nextCursor: null },
    );

  const render = async (props: Partial<Parameters<typeof EntityTimeline>[0]>) => {
    await act(async () => root.render(<EntityTimeline scopeId="app-a" entityType="conversation" entityId="C1" onClose={vi.fn()} {...props} />));
    await act(async () => new Promise((r) => setTimeout(r, 0)));
  };

  it('reads ahead to the end of the story and draws it to scale, the terminal state last', async () => {
    const read = pages();
    await render({ stateField: 'state', lifecycle: LC, medianMs: 3_600_000 });
    expect(read).toHaveBeenCalledTimes(2);
    const text = container.textContent!;
    expect(text).toContain('Lifecycle');
    expect(text).toContain('1d 2h'); // first event to closed
    expect(text).toContain('median 1h');
    expect(text).toContain('new → open');
    expect(text).toContain('open → closed');
    expect(container.querySelectorAll('button[title="Open the request that made this move"]')).toHaveLength(2);
    expect(text).not.toContain('later events are not loaded');
  });

  it('opens the request behind a transition through the address, so it can be linked and closed with Back', async () => {
    pages();
    window.history.replaceState(null, '', '/acme/observability?view=map');
    await render({ stateField: 'state', lifecycle: LC });
    const card = container.querySelector<HTMLButtonElement>('button[title="Open the request that made this move"]')!;
    await act(async () => card.click());
    const q = new URLSearchParams(window.location.search);
    expect([q.get('view'), q.get('req'), q.get('reqScope')]).toEqual(['map', 'CALL-01B', 'app-a']);
    expect(q.get('reqAt')).toBe(String(Date.parse('2026-09-21T02:00:00.000Z')));
    window.history.replaceState(null, '', '/');
  });

  it('reads one page, and draws no lifecycle, when none is declared', async () => {
    const read = pages();
    await render({});
    expect(read).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain('To scale');
    expect(container.textContent).toContain('Later events exist than these');
  });
});
