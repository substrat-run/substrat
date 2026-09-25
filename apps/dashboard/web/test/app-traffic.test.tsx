import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppTraffic } from '../src/views/AppTraffic';
import { InspectableTraffic } from '../src/components/InspectableTraffic';
import { api, type TrafficSeries } from '../src/lib/api';
import { useTenantMetrics } from '../src/lib/use-tenant-metrics';
import { classTotals, rangeLabel, resolveClockRange, seriesWindow, surfaceRows } from '../src/lib/app-traffic';
import { applyOverlayPrefs, OVERLAY_PREFS_KEY, parseOverlayPrefs, resetOverlayPrefs } from '../src/lib/overlay-prefs';

const day = { since: '2026-09-01T00:00:00.000Z', until: '2026-09-02T00:00:00.000Z' };
const hourly = Array.from({ length: 24 }, (_, i) => ({
  start: new Date(Date.parse(day.since) + i * 3_600_000).toISOString(),
  requests: 100,
  errors: 2,
  green: 95,
  yellow: 3,
}));
const series: TrafficSeries = {
  window: day,
  buckets: hourly,
  markers: [
    { at: '2026-09-01T06:30:00.000Z', kind: 'pushed', version: '1.2.0', versionId: 'v2' },
    { at: '2026-09-01T07:30:00.000Z', kind: 'went-live', version: '1.2.0', versionId: 'v2' },
  ],
  bucketMinutes: 60,
  available: true,
};

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  localStorage.clear();
  resetOverlayPrefs();
  window.history.replaceState(null, '', '/');
  HTMLElement.prototype.setPointerCapture = vi.fn();
  vi.spyOn(SVGElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0, top: 0, width: 480, height: 130, right: 480, bottom: 130, x: 0, y: 0, toJSON: () => ({}),
  });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

function pointer(target: Element, kind: string, x: number) {
  act(() => {
    const e = new MouseEvent(kind, { bubbles: true, cancelable: true, clientX: x, button: 0 });
    Object.defineProperties(e, { pointerId: { value: 1 } });
    target.dispatchEvent(e);
  });
}
const buttonNamed = (text: string) => [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(text));
const pushedGlyphs = () => [...container.querySelectorAll('svg[aria-label^="Overlay markers"] text')].filter((t) => t.textContent === '○');

describe('app traffic derivations (#1767)', () => {
  it('resolves clock inputs to their most recent occurrence, across midnight', () => {
    const now = Date.parse('2026-09-02T10:00:00.000Z');
    expect(resolveClockRange('22:00', '02:00', now)).toEqual({ from: '2026-09-01T22:00:00.000Z', to: '2026-09-02T02:00:00.000Z' });
    // An end later than now today is yesterday's.
    expect(resolveClockRange('09:00', '11:00', now)).toEqual({ from: '2026-09-01T09:00:00.000Z', to: '2026-09-01T11:00:00.000Z' });
    expect(resolveClockRange('nine', '11:00', now)).toHaveProperty('error');
  });

  it('names the days when a range ends exactly at midnight', () => {
    expect(rangeLabel({ since: '2026-09-01T23:00:00.000Z', until: '2026-09-02T00:00:00.000Z' }, 15)).toBe('Tue 23:00 → Wed 00:00 UTC · 15 min bars');
    // Same UTC date at both ends: no day names.
    expect(rangeLabel({ since: '2026-09-01T22:00:00.000Z', until: '2026-09-01T23:59:00.000Z' }, 15)).toBe('22:00 → 23:59 UTC · 15 min bars');
  });

  it('accepts only timezone-qualified instants, never one read in the browser zone', () => {
    const now = Date.parse('2026-09-02T10:00:00.000Z');
    expect(resolveClockRange('2026-09-02T08:00:00Z', '2026-09-02T09:00:00+00:00', now)).toEqual({ from: '2026-09-02T08:00:00.000Z', to: '2026-09-02T09:00:00.000Z' });
    expect(resolveClockRange('2026-09-02T08:00:00', '2026-09-02T09:00:00Z', now)).toHaveProperty('error');
    expect(resolveClockRange('2026-09-02T08:00:00Z', '2026-09-02T09:00:00', now)).toHaveProperty('error');
  });

  it('never counts a 4xx as ok when the split is missing', () => {
    expect(classTotals(hourly)).toEqual({ ok: 2280, refused: 72, failed: 48 });
    expect(classTotals([{ start: day.since, requests: 10, errors: 1 }])).toEqual({ ok: null, refused: null, failed: 1 });
  });

  it('clips an unechoed window to now, and labels the bucket width', () => {
    const { window: _, ...bare } = series;
    expect(seriesWindow(bare, Date.parse('2026-09-01T23:30:00.000Z'))).toEqual({ since: day.since, until: '2026-09-01T23:30:00.000Z' });
    expect(rangeLabel({ since: '2026-09-01T10:00:00.000Z', until: '2026-09-01T11:00:00.000Z' }, 15)).toBe('10:00 → 11:00 UTC · 15 min bars');
  });

  it('gives a surface with no traffic no rate, and names bound surfaces by their label', () => {
    const rows = surfaceRows(
      [
        { scopeId: 's', vertical: null, surface: 'api', requests: 0, errors: 0, durationP50: 0, durationP95: 0 },
        { scopeId: 's', vertical: null, surface: 'app', requests: 200, errors: 4, durationP50: 80, durationP95: 450 },
      ],
      [{ surface: 'app', label: 'Web app', hostname: 'acme.example' }],
    );
    expect(rows.map((r) => [r.name, r.sub, r.rate, r.rateHigh, r.p95Slow])).toEqual([
      ['Web app', 'app · acme.example', '2.00%', true, true],
      ['api', null, '—', false, false],
    ]);
  });

  it('reads unreadable prefs as all on, and filters each kind by its own switch', () => {
    expect(parseOverlayPrefs('{bad')).toEqual({ pushed: true, live: true, mig: true, fail: true, rec: true, stale: true });
    const prefs = { ...parseOverlayPrefs(null), pushed: false, stale: false };
    const out = applyOverlayPrefs(prefs, series.markers, { markers: [], spans: [{ from: day.since, to: day.until, kind: 'stale', label: 'x' }], truncated: false });
    expect(out.markers.map((m) => m.kind)).toEqual(['went-live']);
    expect(out.overlays?.spans).toEqual([]);
  });
});

describe('App › Overview traffic card (#1767)', () => {
  const mount = async () => {
    const traffic = vi.spyOn(api, 'appTraffic').mockImplementation(async (_s, _h, w) =>
      w ? { ...series, window: w, bucketMinutes: 15, buckets: hourly.slice(0, 4).map((b, i) => ({ ...b, start: new Date(Date.parse(w.since) + i * 900_000).toISOString() })) } : series,
    );
    vi.spyOn(api, 'appOverlays').mockResolvedValue({ markers: [], spans: [], truncated: false });
    const metrics = vi.spyOn(api, 'appTenantMetrics').mockResolvedValue([]);
    await act(async () => root.render(<AppTraffic scopeId="app-a" surfaces={[]} />));
    return { traffic, metrics };
  };

  it('a drag re-reads the narrower window, which the plane answers in finer bars; Undo steps back', async () => {
    const { traffic, metrics } = await mount();
    expect(container.textContent).toContain('Last 24 hours · 1 h bars');
    const plot = container.querySelector('[data-traffic-plot] rect')!;
    await act(async () => {
      pointer(plot, 'pointerdown', 240);
      pointer(plot, 'pointermove', 280);
      pointer(plot, 'pointerup', 280);
    });
    const zoomed = { since: '2026-09-01T12:00:00.000Z', until: '2026-09-01T14:00:00.000Z' };
    expect(traffic).toHaveBeenLastCalledWith('app-a', 24, zoomed);
    expect(metrics).toHaveBeenLastCalledWith('app-a', 24, zoomed);
    expect(container.textContent).toContain('12:00 → 14:00 UTC · 15 min bars');
    await act(async () => [...container.querySelectorAll('a')].find((a) => a.textContent === 'Undo zoom')!.click());
    expect(traffic).toHaveBeenLastCalledWith('app-a', 24, undefined);
  });

  it('with the parent\'s 24h read it asks for no metrics of its own, until a zoom needs a window', async () => {
    vi.spyOn(api, 'appTraffic').mockImplementation(async (_s, _h, w) =>
      w ? { ...series, window: w, bucketMinutes: 15, buckets: hourly.slice(0, 4).map((b, i) => ({ ...b, start: new Date(Date.parse(w.since) + i * 900_000).toISOString() })) } : series,
    );
    vi.spyOn(api, 'appOverlays').mockResolvedValue({ markers: [], spans: [], truncated: false });
    const metrics = vi.spyOn(api, 'appTenantMetrics').mockResolvedValue([]);
    const rows = [{ scopeId: 'app-a', vertical: null, surface: 'api', requests: 1234, errors: 5, durationP50: 10, durationP95: 20 }];
    await act(async () => root.render(<AppTraffic scopeId="app-a" surfaces={[]} metrics24={{ state: 'ok', rows }} />));
    expect(metrics).not.toHaveBeenCalled();
    expect(container.textContent).toContain('1,234');
    const plot = container.querySelector('[data-traffic-plot] rect')!;
    await act(async () => {
      pointer(plot, 'pointerdown', 240);
      pointer(plot, 'pointermove', 280);
      pointer(plot, 'pointerup', 280);
    });
    expect(metrics).toHaveBeenCalledTimes(1);
    expect(metrics).toHaveBeenLastCalledWith('app-a', 24, { since: '2026-09-01T12:00:00.000Z', until: '2026-09-01T14:00:00.000Z' });
  });

  it('the Overview reads 24h metrics once, and the traffic card rides that read', async () => {
    vi.spyOn(api, 'appTraffic').mockResolvedValue(series);
    vi.spyOn(api, 'appOverlays').mockResolvedValue({ markers: [], spans: [], truncated: false });
    const metrics = vi.spyOn(api, 'appTenantMetrics').mockResolvedValue([]);
    window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
    const Both = () => {
      const m = useTenantMetrics('app-a');
      return (
        <>
          <AppTraffic scopeId="app-a" surfaces={[]} metrics24={m} />
        </>
      );
    };
    await act(async () => root.render(<Both />));
    expect(metrics).toHaveBeenCalledTimes(1);
    expect(metrics).toHaveBeenCalledWith('app-a', 24);
  });

  it('a click pins its bar, and the pin opens the logs for exactly that window', async () => {
    await mount();
    const plot = container.querySelector('[data-traffic-plot] rect')!;
    pointer(plot, 'pointerdown', 101);
    pointer(plot, 'pointerup', 101);
    expect(container.textContent).toContain('05:00–06:00 UTC');
    act(() => buttonNamed('Open logs for this window')!.click());
    const at = new URL(window.location.href);
    expect(at.pathname).toBe('/observability');
    expect(Object.fromEntries(at.searchParams)).toEqual({ app: 'app-a', view: 'logs', from: '2026-09-01T05:00:00.000Z', to: '2026-09-01T06:00:00.000Z' });
  });

  it('shares one overlay switch across charts, and persists it for the viewer', async () => {
    await mount();
    await act(async () =>
      root.render(
        <>
          <AppTraffic scopeId="app-a" surfaces={[]} />
          <InspectableTraffic buckets={hourly} markers={series.markers} bucketMinutes={60} window={day} onRange={vi.fn()} />
        </>,
      ),
    );
    expect(pushedGlyphs()).toHaveLength(2);
    act(() => buttonNamed('Pushed')!.click());
    expect(pushedGlyphs()).toHaveLength(0);
    expect(JSON.parse(localStorage.getItem(OVERLAY_PREFS_KEY)!)).toMatchObject({ pushed: false, live: true });
  });

  it('says so when the overlays cannot be read, and names partial or unavailable sources', async () => {
    vi.spyOn(api, 'appTraffic').mockResolvedValue(series);
    vi.spyOn(api, 'appTenantMetrics').mockResolvedValue([]);
    const overlays = vi.spyOn(api, 'appOverlays').mockRejectedValue(new Error('down'));
    await act(async () => root.render(<AppTraffic scopeId="app-a" surfaces={[]} />));
    expect(container.textContent).toContain('Change overlays are unavailable. Traffic is still shown.');
    expect(container.querySelector('[data-traffic-plot]')).not.toBeNull();
    overlays.mockResolvedValue({ markers: [], spans: [], truncated: false, incompleteSources: ['migrations'], unavailableSources: ['schedules'] });
    await act(async () => root.render(<AppTraffic scopeId="app-b" surfaces={[]} />));
    expect(container.textContent).not.toContain('Change overlays are unavailable');
    expect(container.textContent).toContain('Partial change history: migrations. Older records may be omitted.');
    expect(container.textContent).toContain('Unavailable change sources: schedules.');
  });

  it('still draws, all overlays on, when storage throws', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    await mount();
    expect(pushedGlyphs()).toHaveLength(1);
    act(() => buttonNamed('Pushed')!.click());
    expect(pushedGlyphs()).toHaveLength(0);
  });
});
