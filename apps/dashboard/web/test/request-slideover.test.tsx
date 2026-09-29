import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RequestSlideOver } from '../src/views/RequestSlideOver';
import { api, ApiError, type EffectsTree, type HistoryEntry, type InvocationEvents, type ObservabilityLogEvent } from '../src/lib/api';

/**
 * The request slide-over (#1752 §7a): each part reads on its own, so one failing read
 * costs its own section and never another's.
 */
const END = Date.parse('2026-09-29T08:36:02.323Z');

const stampedLine: ObservabilityLogEvent = {
  timestamp: END, level: 'log', message: null, service: 'acme', outcome: 'ok', trigger: null, invocation: 'fetch',
  entrypoint: null, requestId: null, invocationId: 'CALL1', cpuTimeMs: null, wallTimeMs: null,
  raw: { timestamp: END, source: { substrat: 'invocation', invocationId: 'CALL1', operation: 'acme/assign', status: 200, durationMs: 240, entities: [], eventTypes: ['acme.assigned', 'acme.noted'] } },
};

const event = (id: string, type: string) =>
  ({ id, type, occurredAt: new Date(END - 60).toISOString(), actor: 'p', payload: {}, invocationId: 'CALL1', operation: 'acme/assign' }) as unknown as HistoryEntry;

describe('RequestSlideOver', () => {
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

  const render = async (onClose = vi.fn()) => {
    await act(async () => root.render(<RequestSlideOver scopeId="app-a" invocationId="CALL1" atMs={END} onClose={onClose} />));
    // Let the chained reads settle.
    await act(async () => new Promise((r) => setTimeout(r, 0)));
    return onClose;
  };

  it('keeps the events, and the consumers that could be read, when one effects read fails', async () => {
    vi.spyOn(api, 'appTenantLogs').mockResolvedValue([stampedLine]);
    vi.spyOn(api, 'appInvocationEvents').mockResolvedValue({ events: [event('E1', 'acme.assigned'), event('E2', 'acme.noted')], truncated: false } as InvocationEvents);
    vi.spyOn(api, 'appEventEffects').mockImplementation(async (_s, eventId) => {
      if (eventId === 'E2') throw new ApiError(503, 'scope busy');
      return {
        root: { event: event('E1', 'acme.assigned'), deliveries: [{ consumer: 'notify', state: 'delivered', at: new Date(END + 180).toISOString(), attempts: 1, error: null }], effects: [] },
        terminal: 'complete',
        count: 1,
      } as unknown as EffectsTree;
    });
    await render();
    const text = container.textContent!;
    expect(text).toContain('acme.assigned');
    expect(text).toContain('acme.noted');
    expect(text).toContain('notify');
    expect(text).toContain('+180 ms');
    expect(text).toContain('Some events’ consumers could not be read (503: scope busy); the rest are shown.');
    expect(text).not.toContain('What the call emitted could not be read');
  });

  it('shows the request from its stamped line, and what it emitted, even when the log backend refuses', async () => {
    vi.spyOn(api, 'appTenantLogs').mockRejectedValue(new ApiError(501, 'not configured'));
    vi.spyOn(api, 'appInvocationEvents').mockResolvedValue({ events: [event('E1', 'acme.assigned')], truncated: false } as InvocationEvents);
    vi.spyOn(api, 'appEventEffects').mockResolvedValue({ root: null, terminal: 'missing', count: 0 } as unknown as EffectsTree);
    await render();
    const text = container.textContent!;
    expect(text).toContain('Log lines are unavailable (not available on this platform).');
    expect(text).toContain('acme.assigned');
  });

  it('closes on Escape', async () => {
    vi.spyOn(api, 'appTenantLogs').mockResolvedValue([stampedLine]);
    vi.spyOn(api, 'appInvocationEvents').mockResolvedValue({ events: [], truncated: false } as InvocationEvents);
    const onClose = await render();
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('acme/assign');
    expect(container.textContent).toContain('200 ok');
  });
});
