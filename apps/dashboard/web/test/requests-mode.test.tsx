import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RequestsMode } from '../src/views/RequestsMode';
import { api, ApiError, type RequestFacets, type RequestRecord, type RequestVolume } from '../src/lib/api';
import {
  durationLabel,
  bucketWidthLabel,
  axisLabel,
  requestChips,
  requestReadQuery,
  resultLabel,
  toggleFacet,
  whereOf,
} from '../src/lib/requests';
import { logChips, parseBarText } from '../src/lib/logs-chips';
import { sectionOf } from '../src/lib/obs-sections';

/** #1746: the Requests mode — its URL rules, and the three reads it makes and draws. */

describe('request facets in the URL', () => {
  it('reads comma-separated alternatives per facet, keyed as the plane names them', () => {
    expect(whereOf({ op: 'acme/create,acme/assign', lvl: 'error', pk: '' })).toEqual({
      operation: ['acme/create', 'acme/assign'],
      level: ['error'],
    });
  });

  it('ticks and unticks a value, and drops the key with its last value', () => {
    expect(toggleFacet({ op: 'a' }, 'operation', 'b')).toEqual({ op: 'a,b' });
    expect(toggleFacet({ op: 'a,b' }, 'operation', 'a')).toEqual({ op: 'b' });
    expect(toggleFacet({ op: 'a' }, 'operation', 'a')).toEqual({ op: undefined });
  });

  it('sends facets as repeated keys, with the cursor in place of hours — never both', () => {
    const q = { op: 'acme/create,acme/assign', status: '409' };
    const withCursor = requestReadQuery(q, { since: '2026-09-01T10:00:00.000Z', until: '2026-09-01T11:00:00.000Z', hours: 24 }, { buckets: 90 });
    expect(withCursor.getAll('operation')).toEqual(['acme/create', 'acme/assign']);
    expect(withCursor.get('status')).toBe('409');
    expect(withCursor.get('hours')).toBeNull();
    expect(withCursor.get('buckets')).toBe('90');
    expect(requestReadQuery(q, { hours: 3 }).get('hours')).toBe('3');
  });

  it('shows one chip per facet, in the reader’s words', () => {
    expect(requestChips({ op: 'a,b', pk: 'system' })).toEqual([
      { key: 'operation', value: 'a or b', clears: ['op'] },
      { key: 'who', value: 'scheduled job', clears: ['pk'] },
    ]);
    // The other modes' filters are not the Requests mode's chips.
    expect(logChips({ level: 'error', op: 'a' }, 'requests').map((c) => c.key)).toEqual(['operation']);
    expect(logChips({ level: 'error', op: 'a' }, 'logs').map((c) => c.key)).toEqual(['level']);
  });

  it('refuses typed text in Requests rather than guessing which facet it meant', () => {
    expect(parseBarText('acme', 'requests')).toMatchObject({ error: expect.stringContaining('ticking') });
  });

  it('is a Logs sub-view', () => {
    expect(sectionOf('requests')).toBe('logs');
  });

  it('says a result and a duration the way a row reads them', () => {
    expect(resultLabel({ status: 409, threw: false, problemCode: 'conflict' })).toEqual({ text: '409 conflict', tone: 'warn' });
    expect(resultLabel({ status: 200, threw: false, problemCode: null })).toEqual({ text: '200 ok', tone: 'ok' });
    expect(resultLabel({ status: 200, threw: false, problemCode: 'permission_denied' })).toMatchObject({ tone: 'warn' });
    expect(resultLabel({ status: null, threw: true, problemCode: null })).toEqual({ text: 'threw', tone: 'error' });
    expect(durationLabel(842)).toBe('842 ms');
    expect(durationLabel(2100)).toBe('2.1 s');
    expect(bucketWidthLabel(120_000)).toBe('2 min');
    expect(bucketWidthLabel(30_000)).toBe('30 s');
  });

  it('dates an axis end once the window is long enough for two clocks to collide', () => {
    const t = Date.parse('2026-09-26T13:06:52.000Z');
    expect(axisLabel(t, 3 * 3_600_000)).toBe('13:06:52');
    expect(axisLabel(t, 24 * 3_600_000)).toBe('09-26 13:06');
  });
});

describe('RequestsMode', () => {
  const window = { from: '2026-09-01T10:00:00.000Z', to: '2026-09-01T13:00:00.000Z' };
  const volume: RequestVolume = {
    bucketMs: 120_000,
    buckets: [
      { start: '2026-09-01T10:00:00.000Z', info: 40, warn: 3, error: 1, unrecorded: 0 },
      { start: '2026-09-01T12:00:00.000Z', info: 10, warn: 0, error: 0, unrecorded: 6 },
    ],
    estimated: false,
  };
  const facets: RequestFacets = {
    total: 60,
    facets: {
      operation: [{ value: 'acme/assign', count: 38 }, { value: 'acme/reply', count: 22 }],
      problemCode: [{ value: 'conflict', count: 3 }],
      principalKind: [{ value: 'principal', count: 55 }, { value: 'system', count: 5 }],
      status: [{ value: 200, count: 56 }, { value: 409, count: 3 }],
      surface: [],
      level: [{ value: 'info', count: 50 }],
    },
    estimated: false,
  };
  const row = (over: Partial<RequestRecord> = {}): RequestRecord => ({
    timestamp: Date.parse('2026-09-01T12:30:05.000Z'),
    invocationId: '01J8Z3KX0Q5R7T9V1W2Y4A6B8C',
    scopeId: 'app-a',
    vertical: 'acme',
    surface: 'app',
    method: 'POST',
    path: '/api/assign',
    status: 409,
    threw: false,
    durationMs: 120,
    level: 'warn',
    operation: 'acme/assign',
    problemCode: 'conflict',
    principalKind: 'principal',
    eventCount: 0,
    eventTypes: [],
    entities: [],
    versionId: null,
    ...over,
  });

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

  const render = async (props: Partial<Parameters<typeof RequestsMode>[0]> = {}) => {
    const onFilters = vi.fn();
    const onOpenCall = vi.fn();
    await act(async () =>
      root.render(
        <RequestsMode
          scopeId="app-a"
          q={{}}
          window={window}
          nonce={0}
          onFilters={onFilters}
          onRange={vi.fn()}
          onOpenCall={onOpenCall}
          {...props}
        />,
      ),
    );
    return { onFilters, onOpenCall };
  };

  it('asks the three reads with one query, and draws what they answered', async () => {
    const v = vi.spyOn(api, 'appRequestVolume').mockResolvedValue(volume);
    const f = vi.spyOn(api, 'appRequestFacets').mockResolvedValue(facets);
    const l = vi.spyOn(api, 'appRequests').mockResolvedValue([row()]);
    await render({ q: { op: 'acme/assign' } });
    for (const spy of [v, f, l]) {
      const query = spy.mock.calls[0]![1] as URLSearchParams;
      expect(spy.mock.calls[0]![0]).toBe('app-a');
      expect(query.getAll('operation')).toEqual(['acme/assign']);
      // The chart's own window, verbatim — never `hours`, which the plane would anchor to
      // its own clock while the bars are drawn against this one.
      expect(query.get('since')).toBe(window.from);
      expect(query.get('until')).toBe(window.to);
      expect(query.get('hours')).toBeNull();
    }
    expect((v.mock.calls[0]![1] as URLSearchParams).get('buckets')).toBe('90');
    const text = container.textContent!;
    // The footer names the window's total from the facet read.
    expect(text).toContain('of 60 requests in this window');
    expect(text).toContain('409 conflict');
    expect(text).toContain('not recorded');
    // The histogram names its whole count for a screen reader.
    expect(container.querySelector('[role="img"]')!.getAttribute('aria-label')).toBe(
      '60 requests: 1 errors, 3 warnings, 50 info, 6 with no level recorded.',
    );
    expect(container.querySelectorAll('[data-bucket]')).toHaveLength(2);
  });

  it('ticks a facet value and opens a request', async () => {
    vi.spyOn(api, 'appRequestVolume').mockResolvedValue(volume);
    vi.spyOn(api, 'appRequestFacets').mockResolvedValue(facets);
    vi.spyOn(api, 'appRequests').mockResolvedValue([row()]);
    const { onFilters, onOpenCall } = await render();
    const box = [...container.querySelectorAll('[role="checkbox"]')].find((b) => b.textContent?.startsWith('scheduled job'))!;
    await act(async () => box.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onFilters).toHaveBeenLastCalledWith({ pk: 'system' });
    const rowButton = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('acme/assign') && b.title === 'Open this request')!;
    await act(async () => rowButton.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    // The call and when it happened: the slide-over windows its log read around that instant.
    expect(onOpenCall).toHaveBeenCalledWith('01J8Z3KX0Q5R7T9V1W2Y4A6B8C', row().timestamp);
  });

  it('keeps a ticked value listed after it fell out of the counts, so it can be unticked', async () => {
    vi.spyOn(api, 'appRequestVolume').mockResolvedValue(volume);
    vi.spyOn(api, 'appRequestFacets').mockResolvedValue(facets);
    vi.spyOn(api, 'appRequests').mockResolvedValue([]);
    await render({ q: { code: 'unavailable' } });
    const box = [...container.querySelectorAll('[role="checkbox"]')].find((b) => b.textContent?.startsWith('unavailable'))!;
    expect(box.getAttribute('aria-checked')).toBe('true');
    expect(box.textContent).toContain('—');
  });

  it('says a 501 is "not on this platform", never an empty app', async () => {
    const unconfigured = new ApiError(501, 'observability is not configured on this platform');
    vi.spyOn(api, 'appRequestVolume').mockRejectedValue(unconfigured);
    vi.spyOn(api, 'appRequestFacets').mockRejectedValue(unconfigured);
    vi.spyOn(api, 'appRequests').mockRejectedValue(unconfigured);
    await render();
    expect(container.textContent).toContain('not available on this platform');
    expect(container.textContent).not.toContain('No requests match');
  });
});
