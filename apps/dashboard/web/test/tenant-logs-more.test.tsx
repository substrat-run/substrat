import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TenantLogs } from '../src/views/ObservabilityPanels';
import { api, type ObservabilityLogEvent } from '../src/lib/api';

/** #2762: the Lines mode's "Load more" — the next page ends at the oldest line on screen. */

const T = Date.parse('2026-09-01T12:00:00.000Z');
const line = (message: string, timestamp: number): ObservabilityLogEvent =>
  ({ timestamp, level: 'info', message, service: 'acme-widgets-v1', outcome: 'ok', trigger: null, invocation: null, entrypoint: null, requestId: null, cpuTimeMs: null, wallTimeMs: null, raw: {} }) as ObservabilityLogEvent;

describe('TenantLogs › Load more', () => {
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

  const window = { from: '2026-09-01T10:00:00.000Z', to: '2026-09-01T13:00:00.000Z' };
  const button = () => [...container.querySelectorAll('button')].find((b) => b.textContent === 'Load more');

  it('reads the page before the oldest line, appends only what is new, and stops when nothing is', async () => {
    const read = vi
      .spyOn(api, 'appTenantLogsRead')
      .mockResolvedValueOnce({ events: [line('newest', T), line('older', T - 60_000)], incomplete: false })
      // The bound is inclusive, so the oldest line on screen comes back with the page.
      .mockResolvedValueOnce({ events: [line('older', T - 60_000), line('oldest', T - 120_000)], incomplete: false })
      .mockResolvedValueOnce({ events: [line('oldest', T - 120_000)], incomplete: false });
    await act(async () => root.render(<TenantLogs teamId="team-a" scopeId="app-a" hours={24} nonce={0} window={window} filters={{ level: 'info' }} />));
    await act(async () => button()!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(read.mock.calls[1]![2]).toMatchObject({ level: 'info', since: window.from, until: new Date(T - 60_000).toISOString(), limit: 100 });
    expect(container.textContent!.match(/older/g)).toHaveLength(1);
    expect(container.textContent).toContain('oldest');
    expect(container.textContent).toContain('Showing latest 3 lines');
    await act(async () => button()!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(button()).toBeUndefined();
    expect(container.textContent).toContain('No older lines in this window');
  });
});
