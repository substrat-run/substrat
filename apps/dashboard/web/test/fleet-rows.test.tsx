import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compact, duration, errorRate, fleetRows } from '../src/lib/fleet-rows';
import { FleetHealth } from '../src/views/FleetHealth';
import { api, type AppHealthRow, type AppRow } from '../src/lib/api';

const app = (id: string, status: AppRow['status'] = 'active') => ({ app_scope_id: id, name: `App ${id}`, vertical_slug: 'todo', status }) as AppRow;
const health = (scopeId: string, state: AppHealthRow['state']) =>
  ({ scopeId, name: `App ${scopeId}`, vertical: 'todo', state, reason: `${state} reason`, failures: 0, sweepFailures: 0, stale: 0, lastSweepAt: null }) as AppHealthRow;

describe('fleetRows (#1767)', () => {
  it('sorts worst first, busier first within a verdict', () => {
    const rows = fleetRows({
      apps: [app('ok'), app('silent'), app('failing'), app('failing2')],
      health: [health('ok', 'ok'), health('silent', 'silent'), health('failing', 'failing'), health('failing2', 'failing')],
      metrics: { available: true, rows: [{ scopeId: 'failing', requests: 5, errors: 1, p95: 10 }, { scopeId: 'failing2', requests: 50, errors: 1, p95: 20 }] },
    });
    expect(rows.map((r) => r.scopeId)).toEqual(['failing2', 'failing', 'silent', 'ok']);
  });

  it('judges an app that is not running by its install state, not by sweeps', () => {
    const rows = fleetRows({ apps: [app('p', 'provisioning'), app('f', 'failed')], health: [health('p', 'silent'), health('f', 'silent')], metrics: null });
    expect(rows.map((r) => [r.scopeId, r.verdict])).toEqual([['f', 'install-failed'], ['p', 'installing']]);
  });

  it('reads unknown traffic as null, never zero, and a quiet app as zero', () => {
    expect(fleetRows({ apps: [app('a')], health: null, metrics: null })[0]).toMatchObject({ verdict: 'unknown', requests: null, errors: null, p95: null });
    expect(fleetRows({ apps: [app('a')], health: null, metrics: { available: false, rows: [] } })[0]!.requests).toBeNull();
    expect(fleetRows({ apps: [app('a')], health: null, metrics: { available: true, rows: [] } })[0]).toMatchObject({ requests: 0, errors: 0, p95: null });
  });

  it('formats like the design', () => {
    expect([compact(412), compact(3344), compact(412_000), compact(1_100_000)]).toEqual(['412', '3.3k', '412k', '1.1M']);
    expect([errorRate(33, 3344), errorRate(0, 10), errorRate(1, 5000), errorRate(0, 0)]).toEqual(['1.0%', '0%', '<0.1%', null]);
    expect([duration(310), duration(1240)]).toEqual(['310 ms', '1.2 s']);
  });
});

describe('FleetHealth table', () => {
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

  it('lists every app, and a verdict chip filters to it', async () => {
    vi.spyOn(api, 'fleetHealth').mockResolvedValue({ rows: [health('a', 'failing'), health('b', 'ok')] });
    vi.spyOn(api, 'appMetrics').mockResolvedValue({ available: true, rows: [{ scopeId: 'a', requests: 3344, errors: 33, p95: 310 }] });
    const onOpen = vi.fn();
    await act(async () => root.render(<FleetHealth apps={[app('a'), app('b')]} onOpen={onOpen} />));
    const names = () => [...container.querySelectorAll('[role="row"]')].slice(1).map((r) => r.querySelector('[role="cell"]:nth-child(2) span')!.textContent);
    expect(names()).toEqual(['App a', 'App b']);
    expect(container.textContent).toContain('3.3k');
    expect(container.textContent).toContain('310 ms');
    const okChip = [...container.querySelectorAll('button[aria-pressed]')].find((b) => b.textContent?.startsWith('OK'))!;
    await act(async () => okChip.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(names()).toEqual(['App b']);
    await act(async () => container.querySelectorAll('[role="row"]')[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onOpen).toHaveBeenCalledWith('b');
  });
});
