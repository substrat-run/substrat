import { act, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InspectableTraffic } from '../src/components/InspectableTraffic';
import { LogList } from '../src/components/LogList';
import { Observability } from '../src/views/Observability';
import { api, type ObservabilityLogEvent, type AppRow } from '../src/lib/api';
import { obsPath } from '../src/lib/router';
import { readObsQuery } from '../src/lib/observability-query';
import { LOG_COLUMNS_KEY } from '../src/lib/log-columns';

const windowRange = { since: '2026-09-01T10:00:00.000Z', until: '2026-09-01T11:00:00.000Z' };
const buckets = [0, 15, 30, 45].map((minute) => ({
  start: `2026-09-01T10:${String(minute).padStart(2, '0')}:00.000Z`,
  requests: 12,
  errors: 1,
  green: 10,
  yellow: 1,
}));
let container: HTMLDivElement, root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  localStorage.clear();
  HTMLElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.releasePointerCapture = vi.fn();
  HTMLElement.prototype.hasPointerCapture = () => false;
  vi.spyOn(SVGElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    top: 0,
    width: 400,
    height: 100,
    right: 400,
    bottom: 100,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});
const click = (element: Element) =>
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
const button = (text: string) => [...container.querySelectorAll('button')].find((b) => b.textContent === text)!;
function pointer(target: Element, kind: string, x: number, pointerType = 'mouse') {
  act(() => {
    const e = new MouseEvent(kind, { bubbles: true, clientX: x, button: 0 });
    Object.defineProperties(e, { pointerId: { value: 1 }, pointerType: { value: pointerType } });
    target.dispatchEvent(e);
  });
}
function key(target: Element, key: string) {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key }));
  });
}

describe('real DOM chart gestures and inspection', () => {
  it('reverse drag queries exact bounds once, suppresses click, and Escape/cancel do not query', async () => {
    const onRange = vi.fn(),
      onBucket = vi.fn();
    await act(async () =>
      root.render(
        <InspectableTraffic
          buckets={buckets}
          markers={[]}
          bucketMinutes={15}
          window={windowRange}
          onRange={onRange}
          onBucket={onBucket}
        />,
      ),
    );
    const plot = container.querySelector('[data-traffic-plot]')!,
      rect = plot.querySelector('rect')!;
    pointer(rect, 'pointerdown', 300);
    pointer(rect, 'pointermove', 100);
    pointer(rect, 'pointerup', 100);
    click(rect);
    expect(onRange).toHaveBeenCalledExactlyOnceWith({
      from: '2026-09-01T10:15:00.000Z',
      to: '2026-09-01T10:45:00.000Z',
    });
    expect(onBucket).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('Pinned');
    pointer(rect, 'pointerdown', 50);
    pointer(rect, 'pointermove', 150);
    key(rect, 'Escape');
    pointer(rect, 'pointerup', 150);
    pointer(rect, 'pointerdown', 50);
    pointer(rect, 'pointercancel', 50);
    pointer(rect, 'pointerup', 250);
    expect(onRange).toHaveBeenCalledTimes(1);
  });
  it('touch release outside the plot clamps, while keyboard activation pins details', async () => {
    const onRange = vi.fn();
    await act(async () =>
      root.render(
        <InspectableTraffic buckets={buckets} markers={[]} bucketMinutes={15} window={windowRange} onRange={onRange} />,
      ),
    );
    const bucket = container.querySelector('[data-traffic-plot] [role="button"]')!;
    pointer(bucket, 'pointerdown', 200, 'touch');
    pointer(bucket, 'pointermove', 600, 'touch');
    pointer(bucket, 'pointerup', 600, 'touch');
    expect(onRange).toHaveBeenCalledWith({ from: '2026-09-01T10:30:00.000Z', to: windowRange.until });
    // A fresh gesture resets click suppression; keyboard should always work independently.
    pointer(bucket, 'pointerdown', 10);
    pointer(bucket, 'pointerup', 10);
    key(bucket, 'Enter');
    expect(container.textContent).toContain('Pinned');
    key(bucket, 'Escape');
    expect(container.textContent).not.toContain('Pinned');
  });
});

it('persists only column IDs, reorders/reset columns and provides keyboard log details/actions', async () => {
  const onFilter = vi.fn();
  const event: ObservabilityLogEvent = {
    timestamp: Date.parse(windowRange.since),
    level: 'error',
    message: 'failure',
    service: 'service',
    outcome: 'exception',
    trigger: null,
    invocation: 'fetch',
    entrypoint: null,
    requestId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    cpuTimeMs: 2,
    wallTimeMs: 12,
    raw: { privateExample: 'not-persisted' },
  };
  await act(async () => root.render(<LogList events={[event]} onFilter={onFilter} />));
  const wall = [...container.querySelectorAll('label')]
    .find((l) => l.textContent === 'Wall time')!
    .querySelector('input')!;
  click(wall);
  expect(localStorage.getItem(LOG_COLUMNS_KEY)).toContain('wallTimeMs');
  click(container.querySelector('[aria-label="Move Wall time left"]')!);
  expect(JSON.parse(localStorage.getItem(LOG_COLUMNS_KEY)!)).toEqual([
    'timestamp',
    'level',
    'message',
    'outcome',
    'wallTimeMs',
    'cpuTimeMs',
  ]);
  click(button('Inspect'));
  expect(container.querySelector('[aria-label="Log details"]')).not.toBeNull();
  click(button('Include this level'));
  expect(onFilter).toHaveBeenCalledWith({ level: 'error' });
  expect(localStorage.getItem(LOG_COLUMNS_KEY)).not.toContain('not-persisted');
  key(button('Close log details'), 'Escape');
  expect(container.querySelector('[aria-label="Log details"]')).toBeNull();
  click(button('Reset columns'));
  expect(JSON.parse(localStorage.getItem(LOG_COLUMNS_KEY)!)).not.toContain('wallTimeMs');
});

it('a zoom re-queries traffic and logs with the same historical bounds; URL replay and refresh preserve filters', async () => {
  const traffic = vi
    .spyOn(api, 'appTraffic')
    .mockResolvedValue({ buckets, markers: [], available: true, bucketMinutes: 15, window: windowRange });
  vi.spyOn(api, 'appOverlays').mockResolvedValue({ markers: [], spans: [], truncated: false });
  const logs = vi.spyOn(api, 'appTenantLogs').mockResolvedValue([]);
  const initial = obsPath({
    app: 'app-a',
    view: 'logs',
    from: windowRange.since,
    to: windowRange.until,
    level: 'error',
    search: 'failure',
  });
  window.history.replaceState(null, '', initial);
  function Page() {
    const [search, setSearch] = useState(window.location.search);
    useEffect(() => {
      const read = () => setSearch(window.location.search);
      window.addEventListener('popstate', read);
      return () => window.removeEventListener('popstate', read);
    }, []);
    const q = readObsQuery(search);
    return (
      <Observability
        apps={[{ app_scope_id: 'app-a', name: 'App A' } as AppRow]}
        query={search}
        scopeId={q.app ?? null}
        view={q.view ?? null}
        focusEventType={q.type ?? null}
        cursor={q.from && q.to ? { from: q.from, to: q.to } : null}
        onNav={(next) => {
          window.history.pushState(null, '', obsPath(next));
          window.dispatchEvent(new PopStateEvent('popstate'));
        }}
      />
    );
  }
  await act(async () => root.render(<Page />));
  const target = container.querySelector('[data-traffic-plot] rect')!;
  await act(async () => {
    pointer(target, 'pointerdown', 100);
    pointer(target, 'pointermove', 300);
    pointer(target, 'pointerup', 300);
  });
  const next = { since: '2026-09-01T10:15:00.000Z', until: '2026-09-01T10:45:00.000Z' };
  expect(traffic).toHaveBeenLastCalledWith('app-a', 24, next);
  expect(logs).toHaveBeenLastCalledWith(
    'app-a',
    expect.objectContaining({ ...next, level: 'error', search: 'failure' }),
  );
  await act(async () => click(button('Refresh')));
  expect(logs).toHaveBeenLastCalledWith(
    'app-a',
    expect.objectContaining({ ...next, level: 'error', search: 'failure' }),
  );
  await act(async () => {
    window.history.replaceState(null, '', initial);
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  expect(traffic).toHaveBeenLastCalledWith('app-a', 24, windowRange);
  expect(container.querySelector<HTMLInputElement>('[aria-label="Search messages"]')!.value).toBe('failure');
});

it('preserves URL event grouping and type through refresh without remounting controls', async () => {
  vi.spyOn(api, 'appTraffic').mockResolvedValue({ buckets, markers: [], available: true, bucketMinutes: 15 });
  vi.spyOn(api, 'appOverlays').mockResolvedValue({ markers: [], spans: [], truncated: false });
  const facets = vi
    .spyOn(api, 'appFacets')
    .mockResolvedValue({ buckets: [], total: 0, erased: 0, truncated: false } as Awaited<
      ReturnType<typeof api.appFacets>
    >);
  const query = new URLSearchParams({
    app: 'app-a',
    view: 'events',
    from: windowRange.since,
    to: windowRange.until,
    groupBy: 'operation',
    type: 'receipt.sent',
  }).toString();
  await act(async () =>
    root.render(
      <Observability
        apps={[{ app_scope_id: 'app-a', name: 'App A' } as AppRow]}
        query={query}
        scopeId="app-a"
        view="events"
        focusEventType="receipt.sent"
        cursor={{ from: windowRange.since, to: windowRange.until }}
        onNav={vi.fn()}
      />,
    ),
  );
  await act(async () => click(button('Refresh')));
  expect(facets).toHaveBeenLastCalledWith(
    'app-a',
    expect.objectContaining({ groupBy: 'operation', type: 'receipt.sent', ...windowRange }),
  );
  expect(container.querySelector<HTMLSelectElement>('[aria-label="Group by dimension"]')!.value).toBe('operation');
  expect(container.querySelector<HTMLInputElement>('[aria-label="Narrow to one event type"]')!.value).toBe(
    'receipt.sent',
  );
});

it('all-app drag uses the shared interval without choosing a tenant scope', async () => {
  const traffic = vi
    .spyOn(api, 'teamTraffic')
    .mockResolvedValue({ series: [{ scopeId: 'app-a', buckets }], available: true, bucketMinutes: 15 });
  const onNav = vi.fn();
  await act(async () =>
    root.render(
      <Observability
        apps={[{ app_scope_id: 'app-a', name: 'App A' } as AppRow]}
        query={new URLSearchParams({ from: windowRange.since, to: windowRange.until }).toString()}
        scopeId={null}
        view="traffic"
        focusEventType={null}
        cursor={{ from: windowRange.since, to: windowRange.until }}
        onNav={onNav}
      />,
    ),
  );
  const target = container.querySelector('[data-traffic-plot] [role="button"]')!;
  pointer(target, 'pointerdown', 100);
  pointer(target, 'pointermove', 300);
  pointer(target, 'pointerup', 300);
  expect(traffic).toHaveBeenCalledWith({ hours: 24, ...windowRange });
  expect(onNav).toHaveBeenCalledWith({ from: '2026-09-01T10:15:00.000Z', to: '2026-09-01T10:45:00.000Z' });
});
