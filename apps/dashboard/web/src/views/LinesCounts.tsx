import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, isApiError, type LineVolume, type ReleaseMarker, type RequestFacets } from '../lib/api';
import { DEV_MOCK } from '../lib/mock';
import { mockRequestFacets, mockRequestVolume } from '../lib/mock-requests';
import { mockAppTraffic } from '../lib/mock-app-traffic';
import { card } from '../components/ui';
import type { ObsQuery } from '../lib/observability-query';
import { LINE_FACETS, lineReadQuery, linesUncounted, selectedIn, toggleIn } from '../lib/requests';
import { BUCKETS, FacetSidebar, Histogram, type Loaded } from './RequestsMode';

/**
 * The Lines mode's histogram and facets (#2762), laid out as the Requests mode lays out its
 * own: the histogram card on top, the sidebar beside the stream card (`children`).
 *
 * The counts are of the lines that carry their team: each request's own line and every
 * `ctx.log` line. A vertical's `console.log` and the runtime's lines carry none, so the list
 * reaches them through their request and no count can — they are listed and never counted,
 * and the sidebar says so. A search, one request's lines or the `log` level narrow the list to
 * lines no count sees, so the counts step aside with the reason instead of drawing other lines.
 */
export function LinesCounts({
  teamId,
  scopeId,
  q,
  window,
  nonce,
  live = false,
  onFilters,
  onRange,
  zoomed = false,
  onResetZoom,
  children,
}: {
  teamId: string;
  scopeId: string;
  q: ObsQuery;
  /** The page's window, verbatim — see `RequestsMode`'s. */
  window: { from: string; to: string };
  nonce: number;
  live?: boolean;
  onFilters: (patch: Partial<ObsQuery>) => void;
  onRange: (w: { from: string; to: string }) => void;
  zoomed?: boolean;
  onResetZoom?: () => void;
  /** The stream card. */
  children: ReactNode;
}) {
  const [volume, setVolume] = useState<Loaded<LineVolume>>(null);
  const [facets, setFacets] = useState<Loaded<RequestFacets>>(null);
  const [goLives, setGoLives] = useState<ReleaseMarker[]>([]);
  const asked = useRef<string | null>(null);
  const uncounted = linesUncounted(q);
  const readWindow = { since: window.from, until: window.to };
  const query = lineReadQuery(q, readWindow);
  const queryKey = JSON.stringify([{ ...query, since: undefined, until: undefined }, uncounted]);
  const span = { from: Date.parse(window.from), to: Date.parse(window.to) };

  useEffect(() => {
    let current = true;
    const question = JSON.stringify([teamId, scopeId, queryKey, span.to - span.from]);
    const same = asked.current === question;
    asked.current = question;
    if (!live || !same) {
      setVolume(null);
      setFacets(null);
    }
    if (uncounted) {
      setVolume({ error: uncounted });
      setFacets({ error: uncounted });
      return;
    }
    const settle = <T,>(set: (v: Loaded<T>) => void, read: () => Promise<T>) =>
      read().then(
        (v) => current && set(v),
        (e: unknown) => current && set(failure(e)),
      );
    if (DEV_MOCK) {
      const where = { operation: query.operation, principalKind: query.principalKind, level: query.level };
      const v = mockRequestVolume(where, span, BUCKETS);
      setVolume({ ...v, buckets: v.buckets.map((b) => ({ ...b, debug: 0 })) });
      setFacets(mockRequestFacets(where, span));
      setGoLives(mockAppTraffic(readWindow).markers.filter((m) => m.kind === 'went-live'));
    } else {
      void settle(setVolume, () => api.appLogVolume(teamId, scopeId, { ...query, buckets: String(BUCKETS) }));
      void settle(setFacets, () => api.appLogFacets(teamId, scopeId, query));
      // The deploy marks are decoration: a failed read costs the marks and nothing else.
      api.appGoLives(teamId, scopeId, readWindow).then(
        (m) => current && setGoLives(m),
        () => current && setGoLives([]),
      );
    }
    return () => {
      current = false;
    };
    // `queryKey` stands for the facet filters and the pattern; the window is its two instants.
  }, [teamId, scopeId, queryKey, window.from, window.to, nonce]);

  const levelFacet = LINE_FACETS.find((f) => f.key === 'level')!;
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={{ ...card, boxShadow: 'var(--shadow-sm)' }}>
        <Histogram
          noun="lines"
          volume={volume}
          span={span}
          window={window}
          levels={selectedIn(q, levelFacet)}
          goLives={goLives}
          onLevel={(level) => onFilters(toggleIn(q, levelFacet, level))}
          onRange={onRange}
          {...(zoomed && onResetZoom ? { onResetZoom } : {})}
        />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '232px minmax(0,1fr)', gap: 16, alignItems: 'start' }}>
        <div style={{ display: 'grid', gap: 10, alignContent: 'start' }}>
          <FacetSidebar label="Line filters" defs={LINE_FACETS} facets={facets} q={q} onToggle={(f, value) => onFilters(toggleIn(q, f, value))} />
          <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)', padding: '0 2px' }}>
            Counts are request lines and ctx.log lines. Console lines are listed, not counted.
          </span>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Why a count read failed, in the page's words: 501 is "not on this platform", never an outage. */
function failure(e: unknown): { error: string } {
  if (isApiError(e) && e.status === 501) return { error: 'Line counts are not available on this platform yet.' };
  if (isApiError(e)) return { error: `Line counts could not be read (${e.status}): ${e.message}` };
  return { error: 'Line counts could not be read right now.' };
}
