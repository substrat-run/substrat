import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compact, duration, errorRate, fleetRows } from '../src/lib/fleet-rows';
import { FleetHealth } from '../src/views/FleetHealth';
import { Apps } from '../src/views/Apps';
import { api, type AppHealthRow, type AppRow } from '../src/lib/api';

const app = (id: string, status: AppRow['status'] = 'active') => ({ app_scope_id: id, name: `App ${id}`, vertical_slug: 'todo', status }) as AppRow;
const health = (scopeId: string, state: AppHealthRow['state']) =>
  ({ scopeId, name: `App ${scopeId}`, vertical: 'todo', state, reason: `${state} reason`, failures: 0, sweepFailures: 0, stale: 0, lastSweepAt: null }) as AppHealthRow;

describe('fleetRows (#1767)', () => {
  it('sorts worst first, busier first within a verdict', () => {
    const rows = fleetRows({
      apps: [app('ok'), app('silent'), app('failing'), app('failing2')],
      health: [health('ok', 'ok'), health('silent', 'silent'), health('failing', 'failing'), health('failing2', 'failing')],
      metrics: { available: true, cap: null, rows: [{ scopeId: 'failing', requests: 5, errors: 1, p95: 10 }, { scopeId: 'failing2', requests: 50, errors: 1, p95: 20 }] },
    });
    expect(rows.map((r) => r.scopeId)).toEqual(['failing2', 'failing', 'silent', 'ok']);
  });

  it('judges an app that is not running by its install state, not by sweeps', () => {
    const rows = fleetRows({ apps: [app('p', 'provisioning'), app('f', 'failed')], health: [health('p', 'silent'), health('f', 'silent')], metrics: null });
    expect(rows.map((r) => [r.scopeId, r.verdict])).toEqual([['f', 'install-failed'], ['p', 'installing']]);
  });

  it('reads unknown traffic as null, never zero, and a quiet app as zero', () => {
    expect(fleetRows({ apps: [app('a')], health: null, metrics: null })[0]).toMatchObject({ verdict: 'unknown', requests: null, errors: null, p95: null });
    expect(fleetRows({ apps: [app('a')], health: null, metrics: { available: false, cap: null, rows: [] } })[0]!.requests).toBeNull();
    expect(fleetRows({ apps: [app('a')], health: null, metrics: { available: true, cap: null, rows: [] } })[0]).toMatchObject({ requests: 0, errors: 0, p95: null, unread: null });
  });

  it('reads an app past a full traffic read as unread, and says why', () => {
    const rows = fleetRows({ apps: [app('busy'), app('past')], health: null, metrics: { available: true, cap: 200, rows: [{ scopeId: 'busy', requests: 9, errors: 0, p95: 5 }, { scopeId: 'past', requests: null, errors: null, p95: null }] } });
    expect(rows.find((r) => r.scopeId === 'past')).toMatchObject({ requests: null, errors: null, p95: null, unread: expect.stringContaining('top 200') });
    expect(rows.find((r) => r.scopeId === 'busy')).toMatchObject({ requests: 9, unread: null });
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
    vi.spyOn(api, 'appMetrics').mockResolvedValue({ available: true, cap: null, rows: [{ scopeId: 'a', requests: 3344, errors: 33, p95: 310 }] });
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

  const names = () => [...container.querySelectorAll('[role="row"]')].slice(1).map((r) => r.querySelector('[role="cell"]:nth-child(2) span')!.textContent);
  const chip = (label: string) => [...container.querySelectorAll('button[aria-pressed]')].find((b) => b.textContent?.startsWith(label));
  const click = (el: Element) => act(async () => el.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  const key = (el: Element, k: string) => act(async () => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })));

  it('keeps a selected chip when the search empties its verdict, so the filter can be cleared', async () => {
    vi.spyOn(api, 'fleetHealth').mockResolvedValue({ rows: [health('a', 'failing'), health('b', 'ok')] });
    vi.spyOn(api, 'appMetrics').mockResolvedValue({ available: true, cap: null, rows: [] });
    const onOpen = vi.fn();
    await act(async () => root.render(<FleetHealth apps={[app('a'), app('b')]} onOpen={onOpen} />));
    await click(chip('Failing')!);
    expect(names()).toEqual(['App a']);
    // The search (the parent) narrows the apps to one that is not failing.
    await act(async () => root.render(<FleetHealth apps={[app('b')]} onOpen={onOpen} />));
    const failing = chip('Failing');
    expect(failing?.getAttribute('aria-pressed')).toBe('true');
    expect(failing?.textContent).toContain('0');
    expect(names()).toEqual([]);
    await click(failing!);
    expect(names()).toEqual(['App b']);
  });

  it('retries on Enter at the Retry button without opening the row, and opens the row on Enter or Space', async () => {
    vi.spyOn(api, 'fleetHealth').mockResolvedValue({ rows: [] });
    vi.spyOn(api, 'appMetrics').mockResolvedValue({ available: true, cap: null, rows: [] });
    const onOpen = vi.fn();
    const onRetry = vi.fn();
    await act(async () => root.render(<FleetHealth apps={[app('f', 'failed')]} onOpen={onOpen} onRetry={onRetry} />));
    const row = container.querySelectorAll('[role="row"]')[1]!;
    const retry = [...row.querySelectorAll('button')].find((b) => b.textContent === 'Retry')!;
    await key(retry, 'Enter');
    await key(retry, ' ');
    expect(onOpen).not.toHaveBeenCalled();
    await key(row, 'Enter');
    await key(row, ' ');
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it('walks every app page while the table shows, so a fleet past the first 20 is one table', async () => {
    vi.spyOn(api, 'fleetHealth').mockResolvedValue({ rows: [] });
    vi.spyOn(api, 'appMetrics').mockResolvedValue({ available: true, cap: null, rows: [] });
    const all = Array.from({ length: 45 }, (_, i) => ({ ...app(`app${String(i).padStart(2, '0')}`), id: `id${i}` }) as AppRow);
    let loaded = 20;
    const onLoadMore = vi.fn(() => {
      loaded = Math.min(all.length, loaded + 20);
    });
    const render = () =>
      root.render(<Apps apps={all.slice(0, loaded)} hasMore={loaded < all.length} loadingMore={false} onLoadMore={onLoadMore} onCreate={() => {}} onOpen={() => {}} onRetry={() => {}} />);
    // Each page that lands is rendered by the parent (App.tsx); the table asks for the next.
    for (let i = 0; i < 4; i++) await act(async () => render());
    expect(loaded).toBe(45);
    expect(names()).toHaveLength(45);
    expect(onLoadMore).toHaveBeenCalledTimes(2);
  });
});
