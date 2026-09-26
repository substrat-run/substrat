import { act, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TrafficChart } from '../src/components/TrafficChart';
import { LogList } from '../src/components/LogList';
import { LogQueryBar } from '../src/components/LogQueryBar';
import { Observability } from '../src/views/Observability';
import { api, type ObservabilityLogEvent, type AppRow, type AppHealthRow } from '../src/lib/api';
import { obsPath } from '../src/lib/router';
import { readObsQuery } from '../src/lib/observability-query';

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

it('a Lines row opens its fields as JSON, and an underlined value adds that filter', async () => {
  const onFilter = vi.fn();
  const event: ObservabilityLogEvent = {
    timestamp: Date.parse(windowRange.since),
    level: 'error',
    message: 'failure',
    service: 'service',
    outcome: 'exception',
    trigger: 'POST /api/orders',
    invocation: 'fetch',
    entrypoint: null,
    requestId: 'provider-request-1',
    invocationId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    cpuTimeMs: 2,
    wallTimeMs: 12,
    raw: { privateExample: 'raw' },
  };
  await act(async () => root.render(<LogList events={[event]} onFilter={onFilter} />));
  const row = container.querySelector<HTMLElement>('[role="row"][aria-expanded]')!;
  // The dense row: UTC clock to the millisecond, the level tag, the trigger as the operation.
  expect(row.textContent).toContain('10:00:00.000');
  expect(row.textContent).toContain('ERR');
  expect(row.textContent).toContain('POST /api/orders');
  expect(container.querySelector('[aria-label="Log details"]')).toBeNull();
  click(row);
  const details = container.querySelector('[aria-label="Log details"]')!;
  expect(row.getAttribute('aria-expanded')).toBe('true');
  // Only the fields the line carried: `entrypoint` was null, so it is not listed as one.
  expect(details.textContent).toContain('"wallTimeMs":12');
  expect(details.textContent).not.toContain('entrypoint');
  // Filterable values are links; the rest are plain text.
  const values = [...details.querySelectorAll('button[title^="Filter by"]')].map((b) => b.getAttribute('title'));
  expect(values).toEqual(['Filter by level', 'Filter by message', 'Filter by invocationId']);
  click(details.querySelector('button[title="Filter by level"]')!);
  expect(onFilter).toHaveBeenLastCalledWith({ level: 'error' });
  click(details.querySelector('button[title="Filter by message"]')!);
  expect(onFilter).toHaveBeenLastCalledWith({ search: 'failure' });
  // The row's invocation link filters without toggling the row it sits in.
  click(row.querySelector('button')!);
  expect(onFilter).toHaveBeenLastCalledWith({ invocationId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' });
  expect(row.getAttribute('aria-expanded')).toBe('true');
  key(details, 'Escape');
  expect(container.querySelector('[aria-label="Log details"]')).toBeNull();
});

it('Lines is a table of rows of cells, and an open line is a row of its own whose block parses as JSON', async () => {
  const event: ObservabilityLogEvent = {
    timestamp: Date.parse(windowRange.since),
    level: 'warn',
    message: 'said "slow"',
    service: 'service',
    outcome: 'ok',
    trigger: 'GET /api/orders',
    invocation: 'fetch',
    entrypoint: null,
    requestId: 'provider-request-2',
    invocationId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    cpuTimeMs: 3,
    wallTimeMs: 40,
  };
  for (const compact of [false, true]) {
    await act(async () => root.render(<LogList events={[event, { ...event, level: 'info' }]} onFilter={vi.fn()} compact={compact} />));
    const table = container.querySelector('[role="table"]')!;
    click(table.querySelector('[role="row"][aria-expanded]')!);
    const rows = [...table.querySelectorAll('[role="row"]')];
    // Header, the open line, its details, the closed line.
    expect(rows).toHaveLength(4);
    const [header, ...body] = rows;
    const width = compact ? 4 : 6;
    expect([...header!.children].map((c) => c.getAttribute('role'))).toEqual(Array(width).fill('columnheader'));
    for (const row of body) expect([...row.children].every((c) => c.getAttribute('role') === 'cell')).toBe(true);
    expect(body[0]!.children).toHaveLength(width);
    const details = body[1]!;
    expect(details.getAttribute('aria-label')).toBe('Log details');
    expect(details.children).toHaveLength(1);
    expect(details.children[0]!.getAttribute('aria-colspan')).toBe(String(width));
    // The block reads as JSON, and is JSON: commas between fields, none after the last.
    const parsed = JSON.parse(details.querySelector('[data-log-json]')!.textContent!);
    expect(parsed).toEqual({
      timestamp: windowRange.since,
      level: 'warn',
      message: 'said "slow"',
      service: 'service',
      outcome: 'ok',
      trigger: 'GET /api/orders',
      invocation: 'fetch',
      requestId: 'provider-request-2',
      invocationId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      cpuTimeMs: 3,
      wallTimeMs: 40,
    });
    // The underlined values survive the commas, and no comma is inside a link.
    expect([...details.querySelectorAll('button[title^="Filter by"]')].map((b) => b.textContent)).toEqual(['"warn"', '"said \\"slow\\""', '"01ARZ3NDEKTSV4RRFFQ69G5FAV"']);
  }
});

it('the custom-window chip dates a window that crosses a UTC day', async () => {
  const cursor = { from: '2026-09-01T10:00:00.000Z', to: '2026-09-02T10:00:00.000Z' };
  await act(async () => root.render(<LogQueryBar query={{ view: 'logs', ...cursor }} mode="logs" cursor={cursor} onQuery={vi.fn()} />));
  expect(container.querySelector('[data-chip="time"]')!.textContent).toContain('2026-09-01 10:00 – 2026-09-02 10:00 UTC');
});

/** The page as the app mounts it: URL in, navigation out, re-rendered on popstate. */
function UrlPage({ apps = [{ app_scope_id: 'app-a', name: 'App A' } as AppRow] }: { apps?: AppRow[] }) {
  const [search, setSearch] = useState(window.location.search);
  useEffect(() => {
    const read = () => setSearch(window.location.search);
    window.addEventListener('popstate', read);
    return () => window.removeEventListener('popstate', read);
  }, []);
  const q = readObsQuery(search);
  return (
    <Observability
      apps={apps}
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

it('Logs reads the URL window and filters; refresh and URL replay preserve them, and it reads no traffic', async () => {
  const traffic = vi.spyOn(api, 'appTraffic');
  const logs = vi.spyOn(api, 'appTenantLogs').mockResolvedValue([]);
  const next = { since: '2026-09-01T10:15:00.000Z', until: '2026-09-01T10:45:00.000Z' };
  const initial = obsPath({ app: 'app-a', view: 'logs', from: windowRange.since, to: windowRange.until, level: 'error', search: 'failure' });
  window.history.replaceState(null, '', initial);
  await act(async () => root.render(<UrlPage />));
  expect(logs).toHaveBeenLastCalledWith('app-a', expect.objectContaining({ ...windowRange, level: 'error', search: 'failure' }));
  // A narrower window — what a bar click on the app page links here with.
  await act(async () => {
    window.history.pushState(null, '', obsPath({ app: 'app-a', view: 'logs', from: next.since, to: next.until, level: 'error', search: 'failure' }));
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  expect(logs).toHaveBeenLastCalledWith('app-a', expect.objectContaining({ ...next, level: 'error', search: 'failure' }));
  const calls = logs.mock.calls.length;
  await act(async () => click(button('Refresh')));
  expect(logs.mock.calls.length).toBe(calls + 1);
  expect(logs).toHaveBeenLastCalledWith('app-a', expect.objectContaining({ ...next, level: 'error', search: 'failure' }));
  await act(async () => {
    window.history.replaceState(null, '', initial);
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  expect(logs).toHaveBeenLastCalledWith('app-a', expect.objectContaining({ ...windowRange, level: 'error', search: 'failure' }));
  // The filters are chips, read back from the URL.
  expect(container.querySelector('[data-chip="message"]')!.textContent).toContain('failure');
  expect(container.querySelector('[data-chip="level"]')!.textContent).toContain('error');
  // The traffic chart went with the shared header: Logs asks for lines, not traffic.
  expect(traffic).not.toHaveBeenCalled();
});

it('Logs filter chips round-trip the URL: Enter adds one, × removes it, Clear removes them all', async () => {
  const logs = vi.spyOn(api, 'appTenantLogs').mockResolvedValue([]);
  vi.spyOn(api, 'appMetrics').mockResolvedValue({ available: true, cap: null, rows: [] });
  window.history.replaceState(null, '', obsPath({ app: 'app-a', view: 'logs', hours: '1' }));
  await act(async () => root.render(<UrlPage />));
  const input = () => container.querySelector<HTMLInputElement>('[aria-label="Search messages"]')!;
  const type = async (text: string) => {
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      set.call(input(), text);
      input().dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => key(input(), 'Enter'));
  };
  await type('timeout');
  expect(readObsQuery(window.location.search)).toEqual({ app: 'app-a', view: 'logs', hours: '1', search: 'timeout' });
  expect(logs).toHaveBeenLastCalledWith('app-a', expect.objectContaining({ search: 'timeout' }));
  await type('level:warn');
  expect(readObsQuery(window.location.search)).toMatchObject({ search: 'timeout', level: 'warn' });
  expect(container.querySelectorAll('[data-chip]')).toHaveLength(2);
  await act(async () => click(container.querySelector('[aria-label="Remove message filter"]')!));
  expect(readObsQuery(window.location.search)).toEqual({ app: 'app-a', view: 'logs', hours: '1', level: 'warn' });
  expect(logs).toHaveBeenLastCalledWith('app-a', expect.objectContaining({ level: 'warn', search: undefined }));
  // A malformed filter is refused with its reason, and the URL does not move.
  await type('invocation:nope');
  expect(container.querySelector('[role="alert"]')!.textContent).toContain('ULID');
  expect(readObsQuery(window.location.search)).toEqual({ app: 'app-a', view: 'logs', hours: '1', level: 'warn' });
  await act(async () => click(button('Clear')));
  expect(readObsQuery(window.location.search)).toEqual({ app: 'app-a', view: 'logs', hours: '1' });
  expect(container.querySelector('[data-chip]')).toBeNull();
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
  expect(facets).toHaveBeenCalledTimes(1);
  await act(async () => click(button('Refresh')));
  expect(facets).toHaveBeenCalledTimes(2);
  expect(facets).toHaveBeenLastCalledWith(
    'app-a',
    expect.objectContaining({ groupBy: 'operation', type: 'receipt.sent', ...windowRange }),
  );
  expect(container.querySelector('[aria-label="Group by"] [aria-pressed="true"]')!.textContent).toBe('Operation');
  expect(container.querySelector('[aria-label="Clear event type"]')!.parentElement!.textContent).toContain(
    'receipt.sent',
  );
});

it('a drag across a Pulse sparkline narrows the whole card to that interval, without choosing an app', async () => {
  const traffic = vi
    .spyOn(api, 'teamTraffic')
    .mockResolvedValue({ series: [{ scopeId: 'app-a', buckets }], available: true, bucketMinutes: 15 });
  vi.spyOn(api, 'fleetHealth').mockResolvedValue({ rows: [] });
  vi.spyOn(api, 'appMetrics').mockResolvedValue({ available: true, cap: null, rows: [] });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 400, height: 32, right: 400, bottom: 32, x: 0, y: 0, toJSON: () => ({}) });
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
  const target = container.querySelector('[data-pulse-axis]')!;
  pointer(target, 'pointerdown', 100);
  pointer(target, 'pointermove', 300);
  expect(container.querySelector('[data-pulse-brush]')).not.toBeNull();
  pointer(target, 'pointerup', 300);
  click(target);
  expect(traffic).toHaveBeenCalledWith({ hours: 24, ...windowRange });
  expect(onNav).toHaveBeenCalledExactlyOnceWith({ from: '2026-09-01T10:15:00.000Z', to: '2026-09-01T10:45:00.000Z' });
  expect(container.querySelector('[data-pulse-brush]')).toBeNull();
});

it('Pulse draws one row per app — its numbers, its verdict in words — and a row narrows the page to it', async () => {
  // Inside the page's trailing 24h, where the sparkline column is.
  const recent = [3, 2, 1].map((h) => ({ start: new Date(Date.now() - h * 3_600_000).toISOString(), requests: 12, errors: 1 }));
  vi.spyOn(api, 'teamTraffic').mockResolvedValue({ series: [{ scopeId: 'app-a', buckets: recent }, { scopeId: 'app-b', buckets: recent }], available: true, bucketMinutes: 60 });
  vi.spyOn(api, 'fleetHealth').mockResolvedValue({
    rows: [
      { scopeId: 'app-a', state: 'ok', reason: 'Swept, nothing failing.' } as AppHealthRow,
      { scopeId: 'app-b', state: 'failing', reason: '2 failures recorded.' } as AppHealthRow,
    ],
  });
  const metrics = vi.spyOn(api, 'appMetrics').mockResolvedValue({
    available: true,
    cap: null,
    rows: [
      { scopeId: 'app-a', requests: 3344, errors: 3, p95: 140 },
      { scopeId: 'app-b', requests: 412, errors: 8, p95: 1240 },
    ],
  });
  const onNav = vi.fn();
  const apps = [
    { app_scope_id: 'app-a', name: 'App A', vertical_slug: 'helpdesk', status: 'active' },
    { app_scope_id: 'app-b', name: 'App B', vertical_slug: 'crm', status: 'active' },
  ] as AppRow[];
  await act(async () =>
    root.render(<Observability apps={apps} query="view=traffic" scopeId={null} view="traffic" focusEventType={null} cursor={null} onNav={onNav} />),
  );
  expect(metrics).toHaveBeenCalledWith(24);
  const rows = [...container.querySelectorAll<HTMLAnchorElement>('[data-pulse-card] a[role="row"]')];
  // Worst first — the failing app above the healthy one, whatever its traffic.
  expect(rows.map((r) => [...r.querySelectorAll('[role="cell"]')].map((c) => c.textContent))).toEqual([
    ['App Bcrm', '412', '1.9%', '1.2 s', '', 'Failing'],
    ['App Ahelpdesk', '3.3k', '<0.1%', '140 ms', '', 'OK'],
  ]);
  // Each row carries its own sparkline, drawn from its own series.
  expect(rows[0]!.querySelector('svg path')).not.toBeNull();
  click(rows[0]!);
  expect(onNav).toHaveBeenLastCalledWith(expect.objectContaining({ app: 'app-b' }));
});

it('relative presets retain hours-only requests for legacy readers and shared cache keys', async () => {
  const traffic = vi.spyOn(api, 'appTraffic').mockResolvedValue({ buckets, markers: [], available: true, bucketMinutes: 15 });
  const overlays = vi.spyOn(api, 'appOverlays').mockResolvedValue({ markers: [], spans: [], truncated: false });
  const metrics = vi.spyOn(api, 'appMetrics').mockResolvedValue({ available: true, cap: null, rows: [] });
  vi.spyOn(api, 'fleetHealth').mockResolvedValue({ rows: [] });
  vi.spyOn(api, 'appSchedules').mockRejectedValue(new Error('unavailable'));
  const team = vi.spyOn(api, 'teamTraffic').mockResolvedValue({ series: [], available: true, bucketMinutes: 60 });
  const props = { apps: [{ app_scope_id: 'app-a', name: 'App A' } as AppRow], view: 'traffic', focusEventType: null, cursor: null, onNav: vi.fn() };
  await act(async () => root.render(<Observability {...props} query="app=app-a&hours=24" scopeId="app-a" />));
  expect(traffic).toHaveBeenLastCalledWith('app-a', 24, undefined);
  expect(overlays).toHaveBeenLastCalledWith('app-a', 24, undefined);
  expect(metrics).toHaveBeenLastCalledWith(24);
  await act(async () => click(button('Refresh')));
  expect(traffic).toHaveBeenLastCalledWith('app-a', 24, undefined);
  await act(async () => root.render(<Observability {...props} query="hours=24" scopeId={null} />));
  expect(team).toHaveBeenLastCalledWith({ hours: 24 });
});

it('partial-window marker stacks keep separate buckets independently visible', async () => {
  const markers = [16, 17, 31, 32].map((minute) => ({
    at: `2026-09-01T10:${minute}:00.000Z`, kind: 'failure' as const, label: `Failure ${minute}`, detail: null,
  }));
  await act(async () => root.render(<TrafficChart buckets={buckets.slice(0, 3)} markers={[]} bucketMinutes={15}
    plotWindow={{ since: '2026-09-01T10:07:00.000Z', until: '2026-09-01T10:37:00.000Z' }}
    overlays={{ markers, spans: [], truncated: false }} onMarker={vi.fn()} />));
  const overlay = container.querySelector('svg[aria-label^="Overlay markers:"]')!;
  expect(overlay.querySelectorAll('[role="button"]')).toHaveLength(4);
  expect(overlay.textContent).not.toContain('+1');
});

describe('menu children (#1767)', () => {
  const render = async (view: string, scopeId: string | null, onNav = vi.fn()) => {
    vi.spyOn(api, 'teamTraffic').mockResolvedValue({ series: [{ scopeId: 'app-a', buckets }], available: true, bucketMinutes: 15 });
    vi.spyOn(api, 'appTraffic').mockResolvedValue({ buckets, markers: [], available: true, bucketMinutes: 15 } as Awaited<ReturnType<typeof api.appTraffic>>);
    await act(async () =>
      root.render(
        <Observability
          apps={[{ app_scope_id: 'app-a', name: 'App A' } as AppRow]}
          query={new URLSearchParams({ view, ...(scopeId ? { app: scopeId } : {}) }).toString()}
          scopeId={scopeId}
          view={view}
          focusEventType={null}
          cursor={null}
          onNav={onNav}
        />,
      ),
    );
    return onNav;
  };
  const heading = () => container.querySelector('h1')!.textContent;
  const modes = () => [...container.querySelectorAll('[data-log-modes] button')].map((b) => b.textContent);

  it('titles the page by the child and draws its sub-views as the stream card’s modes', async () => {
    vi.spyOn(api, 'appFacets').mockResolvedValue({ buckets: [], total: 0, erased: 0, truncated: false });
    const onNav = await render('events', 'app-a');
    expect(heading()).toBe('Logs');
    expect(modes()).toEqual(['Lines', 'Events']);
    expect(container.querySelector('[aria-label="Sub-view"]')).toBeNull();
    click(button('Lines'));
    expect(onNav).toHaveBeenLastCalledWith(expect.objectContaining({ app: 'app-a', view: 'logs' }));
  });

  it('asks for an app on Logs with All apps, instead of falling back to Pulse', async () => {
    const onNav = await render('logs', null);
    expect(heading()).toBe('Logs');
    click(button('App A'));
    expect(onNav).toHaveBeenLastCalledWith(expect.objectContaining({ app: 'app-a', view: 'logs' }));
  });

  it('draws no sub-view switch on a child with one view', async () => {
    await render('flow', null);
    expect(heading()).toBe('Processes');
    expect(container.querySelector('[aria-label="Sub-view"]')).toBeNull();
  });

  it('still falls back to Traffic for a per-app Pulse view on All apps', async () => {
    await render('schedules', null);
    expect(heading()).toBe('Pulse');
    expect(container.textContent).not.toContain('Pick an app');
  });
});
