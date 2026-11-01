import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LinesCounts } from '../src/views/LinesCounts';
import { api, type LineVolume, type RequestFacets } from '../src/lib/api';
import type { ObsQuery } from '../src/lib/observability-query';

/**
 * #2762: the Lines mode's histogram and facets — counted over request lines and `ctx.log`
 * lines, by level, operation and who, from the same URL the list below reads.
 */
describe('the Lines counts (#2762)', () => {
  const window = { from: '2026-09-01T12:00:00.000Z', to: '2026-09-01T13:00:00.000Z' };
  const volume: LineVolume = {
    bucketMs: 120_000,
    buckets: [{ start: '2026-09-01T12:30:00.000Z', debug: 10, info: 4, warn: 2, error: 0, unrecorded: 0 }],
    estimated: false,
  };
  const facets: RequestFacets = {
    total: 16,
    facets: {
      operation: [{ value: 'acme/sweep', count: 16 }],
      principalKind: [{ value: 'system', count: 16 }],
      level: [
        { value: 'debug', count: 10 },
        { value: 'info', count: 4 },
        { value: 'warn', count: 2 },
      ],
    },
    estimated: false,
  };

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

  const render = async (q: ObsQuery) => {
    const onFilters = vi.fn();
    await act(async () =>
      root.render(
        <LinesCounts teamId="team-a" scopeId="app-a" q={q} window={window} nonce={0} onFilters={onFilters} onRange={vi.fn()}>
          <div>stream</div>
        </LinesCounts>,
      ),
    );
    return { onFilters };
  };

  it('counts with the page’s filters, stacks debug, and ticks one level at a time', async () => {
    const v = vi.spyOn(api, 'appLogVolume').mockResolvedValue(volume);
    const f = vi.spyOn(api, 'appLogFacets').mockResolvedValue(facets);
    vi.spyOn(api, 'appGoLives').mockResolvedValue([]);
    const { onFilters } = await render({ op: 'acme/sweep', pk: 'system', level: 'warn', tpl: 'swept {n}' });
    const asked = { since: window.from, until: window.to, operation: ['acme/sweep'], principalKind: ['system'], level: ['warn'], template: 'swept {n}' };
    expect(v.mock.calls[0]).toEqual(['team-a', 'app-a', { ...asked, buckets: '90' }]);
    expect(f.mock.calls[0]).toEqual(['team-a', 'app-a', asked]);
    expect(container.querySelector('[role="img"]')!.getAttribute('aria-label')).toBe('16 lines: 0 errors, 2 warnings, 4 info, 10 debug.');
    expect(container.textContent).toContain('Console lines are listed, not counted.');
    // Level is the list's one level: ticking another replaces it rather than adding to it.
    const debug = [...container.querySelectorAll('[role="checkbox"]')].find((b) => b.textContent?.startsWith('debug'))!;
    await act(async () => debug.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onFilters).toHaveBeenLastCalledWith({ level: 'debug' });
  });

  it('steps aside, asking nothing, for a list narrowed to lines no count holds', async () => {
    const v = vi.spyOn(api, 'appLogVolume');
    const f = vi.spyOn(api, 'appLogFacets');
    for (const [q, reason] of [
      [{ search: 'bounced' }, 'while a search is set'],
      [{ level: 'log' }, 'never counted'],
    ] as const) {
      await render(q);
      expect(container.textContent).toContain(reason);
    }
    expect(v).not.toHaveBeenCalled();
    expect(f).not.toHaveBeenCalled();
  });
});
