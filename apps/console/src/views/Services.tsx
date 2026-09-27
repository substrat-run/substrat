import { useEffect, useState } from 'react';
import type { PlatformRequestBacklog, ScopeId, SweepRunEntry, SystemSwitchRecord } from '@substrat-run/contracts';
import { Badge, Button, Card } from '../components';
import { ApiError, walkAll, type Api } from '../lib/api';
import { countTrailingPromotes, pendingCaption, PROMOTE_TRAILING_MINUTES, readPending, summarizeSystemSwitches } from '../lib/services';

export interface ServicesProps {
  api: Api;
  onOpenConnections: () => void;
  onOpenSweeps: () => void;
  onOpenObservability: () => void;
  onOpenVerticals: () => void;
  /** The Failures jump (#1233's pattern), pre-narrowing its client-side free-text filter. */
  onOpenFailures: (query: string) => void;
  /** The kill-switch tile's per-row jump (#1690 §2), into the scope's own Schedules card. */
  onOpenScope: (scopeId: ScopeId) => void;
}

type Tile<T> =
  | { status: 'loading' }
  /** The read failed, or answered a shape this page cannot make sense of — never a fake 0. */
  | { status: 'unavailable' }
  /** This control plane has no backend configured for the read (a 501) — a fact, not a fault. */
  | { status: 'unconfigured' }
  | { status: 'ready'; data: T };

const muted: React.CSSProperties = { color: 'var(--text-placeholder)', fontSize: 12.5 };
const number: React.CSSProperties = { fontSize: 28, fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--text-primary)' };
const caption: React.CSSProperties = { fontSize: 12.5, color: 'var(--text-tertiary)', marginTop: 4 };

function TileBody<T>({ tile, render }: { tile: Tile<T>; render: (data: T) => React.ReactNode }) {
  if (tile.status === 'loading') return <span style={muted}>loading…</span>;
  if (tile.status === 'unconfigured') return <span style={muted}>not configured on this control plane</span>;
  if (tile.status === 'unavailable') return <span style={{ ...muted, color: 'var(--status-danger-fg)' }}>unavailable</span>;
  return <>{render(tile.data)}</>;
}

/**
 * Health → Services (#1690 §2): one overview composed entirely from reads the other Health,
 * Operations and Fleet views already serve — this page adds no detail of its own, only
 * counts and a link into wherever the detail already lives. Each tile says what "healthy"
 * means for it and the window it covers; a tile that cannot get its data reads
 * "unavailable", never a green zero it did not earn.
 */
export function Services({
  api,
  onOpenConnections,
  onOpenSweeps,
  onOpenObservability,
  onOpenVerticals,
  onOpenFailures,
  onOpenScope,
}: ServicesProps) {
  const [sweeps, setSweeps] = useState<Tile<SweepRunEntry[]>>({ status: 'loading' });
  const [connections, setConnections] = useState<
    Tile<{ summary: Record<string, number>; total: number }>
  >({ status: 'loading' });
  const [backlog, setBacklog] = useState<Tile<PlatformRequestBacklog>>({ status: 'loading' });
  const [stuck, setStuck] = useState<Tile<number>>({ status: 'loading' });
  const [metrics, setMetrics] = useState<Tile<{ requests: number; errors: number }>>({ status: 'loading' });
  const [switches, setSwitches] = useState<Tile<SystemSwitchRecord[]>>({ status: 'loading' });

  useEffect(() => {
    let live = true;
    void api
      .listSweepRuns({ limit: 20 })
      .then((page) => live && setSweeps({ status: 'ready', data: page.entries }))
      .catch(() => live && setSweeps({ status: 'unavailable' }));
    return () => {
      live = false;
    };
  }, [api]);

  useEffect(() => {
    let live = true;
    void api
      .listConnectionHealth({ limit: 1 })
      .then((page) => live && setConnections({ status: 'ready', data: { summary: page.summary, total: page.summary.total } }))
      .catch(() => live && setConnections({ status: 'unavailable' }));
    return () => {
      live = false;
    };
  }, [api]);

  useEffect(() => {
    let live = true;
    void api
      .platformRequestBacklog()
      .then((data) => live && setBacklog({ status: 'ready', data }))
      .catch(() => live && setBacklog({ status: 'unavailable' }));
    return () => {
      live = false;
    };
  }, [api]);

  useEffect(() => {
    let live = true;
    void walkAll((p) => api.listSystemSwitches(p))
      .then((rows) => live && setSwitches({ status: 'ready', data: rows }))
      .catch(() => live && setSwitches({ status: 'unavailable' }));
    return () => {
      live = false;
    };
  }, [api]);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const verticals = await walkAll((p) => api.listVerticals(p));
        const count = await countTrailingPromotes(verticals, (slug) => api.listChannels(slug), Date.now());
        if (live) setStuck({ status: 'ready', data: count });
      } catch {
        if (live) setStuck({ status: 'unavailable' });
      }
    })();
    return () => {
      live = false;
    };
  }, [api]);

  useEffect(() => {
    let live = true;
    void api
      .serviceMetrics(1)
      .then((rows) => {
        if (!live) return;
        const totals = rows.reduce((acc, r) => ({ requests: acc.requests + r.requests, errors: acc.errors + r.errors }), {
          requests: 0,
          errors: 0,
        });
        setMetrics({ status: 'ready', data: totals });
      })
      .catch((e) => {
        if (!live) return;
        setMetrics({ status: e instanceof ApiError && e.status === 501 ? 'unconfigured' : 'unavailable' });
      });
    return () => {
      live = false;
    };
  }, [api]);

  const grid: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 16 };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 22, lineHeight: '29px', fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--text-primary)' }}>
          Services
        </h1>
        <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--text-tertiary)', maxWidth: 680 }}>
          Is the platform healthy right now — composed from what the other Health, Operations and
          Fleet views already serve. Every tile links to the page that has the detail.
        </p>
      </div>

      <div style={grid}>
        <Card
          title="Sweep loops"
          description="The last 20 recorded sweep units, newest first"
          actions={<Button size="sm" variant="ghost" onClick={onOpenSweeps}>View sweeps →</Button>}
        >
          <TileBody
            tile={sweeps}
            render={(rows) => {
              if (rows.length === 0) return <span style={muted}>no sweep runs recorded yet</span>;
              const failed = rows.filter((r) => r.outcome === 'failed').length;
              const newest = rows[0]!;
              return (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Badge status={newest.outcome === 'ok' ? 'success' : newest.outcome === 'failed' ? 'danger' : 'warning'}>
                      {newest.outcome}
                    </Badge>
                    <span style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>
                      last: {newest.kind} {newest.unit}
                    </span>
                  </div>
                  <div style={caption}>{failed} failed of the last {rows.length} recorded units</div>
                </>
              );
            }}
          />
        </Card>

        <Card
          title="Connections"
          description="Fleet-wide connection health, right now"
          actions={<Button size="sm" variant="ghost" onClick={onOpenConnections}>View connections →</Button>}
        >
          <TileBody
            tile={connections}
            render={({ summary, total }) => {
              if (total === 0) return <span style={muted}>no connections recorded</span>;
              const erroring = summary['erroring'] ?? 0;
              const stale = summary['stale'] ?? 0;
              return (
                <>
                  <div style={number}>{erroring}</div>
                  <div style={caption}>
                    erroring now · {stale} stale · {total} total
                  </div>
                </>
              );
            }}
          />
        </Card>

        <Card
          title="Platform requests"
          description="Deliveries the platform's intent drain gave up on, and what it left waiting"
          actions={
            <Button size="sm" variant="ghost" onClick={() => onOpenFailures('intent.')}>
              View failures →
            </Button>
          }
        >
          <TileBody
            tile={backlog}
            render={(data) => {
              // #1840: as of the sweep's last drain pass, never live — so its age is always shown.
              const pending = readPending(data.pending, Date.now());
              return (
                <>
                  <div style={{ display: 'flex', gap: 24 }}>
                    <div>
                      <div style={number}>
                        {data.total}
                        {data.capped ? '+' : ''}
                      </div>
                      <div style={caption}>failed</div>
                    </div>
                    <div>
                      <div style={number}>
                        {pending.kind === 'none' ? '—' : `${pending.count}${pending.floor ? '+' : ''}`}
                      </div>
                      <div style={caption}>pending</div>
                    </div>
                  </div>
                  <div style={caption}>
                    Failed: gave up terminally in the last {data.windowDays} days
                    {data.capped ? ' — at least this many; the count hit its bound' : ''}.
                  </div>
                  <div style={pending.kind === 'count' && pending.stale ? { ...caption, color: 'var(--status-warning-fg)' } : caption}>
                    {pendingCaption(pending)}
                  </div>
                </>
              );
            }}
          />
        </Card>

        <Card
          title="Schedule kill switch"
          description="Modules a scope's schedules are switched off for, fleet-wide"
        >
          <TileBody
            tile={switches}
            render={(rows) => {
              if (rows.length === 0) return <span style={muted}>nothing switched off</span>;
              const { scopes, tenants } = summarizeSystemSwitches(rows);
              return (
                <>
                  <div style={number}>{rows.length}</div>
                  <div style={caption}>
                    module{rows.length === 1 ? '' : 's'} off across {scopes} scope
                    {scopes === 1 ? '' : 's'}, {tenants} tenant{tenants === 1 ? '' : 's'}
                  </div>
                  <ul style={{ listStyle: 'none', margin: '8px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {rows.slice(0, 5).map((r) => (
                      <li key={r.operationId}>
                        <button
                          type="button"
                          onClick={() => onOpenScope(r.scopeId)}
                          style={{
                            background: 'none',
                            border: 'none',
                            padding: 0,
                            font: 'inherit',
                            fontSize: 12.5,
                            color: 'var(--text-link, var(--text-primary))',
                            cursor: 'pointer',
                            textAlign: 'left',
                          }}
                        >
                          {r.moduleId} · {r.vertical ?? 'unknown vertical'} · scope {r.scopeId}
                        </button>
                      </li>
                    ))}
                  </ul>
                  {rows.length > 5 ? <div style={caption}>and {rows.length - 5} more</div> : null}
                </>
              );
            }}
          />
        </Card>

        <Card
          title="Deploys"
          description="Verticals whose promote hasn't finished landing"
          actions={<Button size="sm" variant="ghost" onClick={onOpenVerticals}>View verticals →</Button>}
        >
          <TileBody
            tile={stuck}
            render={(count) => (
              <>
                <div style={number}>{count}</div>
                <div style={caption}>
                  still serving an older version than their last prod promote, {PROMOTE_TRAILING_MINUTES}+
                  minutes on — the in-place serve failed and a re-promote retries it. Digest-acknowledgement
                  refusals (before the channel even moves) are not counted here yet.
                </div>
              </>
            )}
          />
        </Card>

        <Card
          title="Observability"
          description="Fleet-wide error rate, last hour"
          actions={<Button size="sm" variant="ghost" onClick={onOpenObservability}>View observability →</Button>}
        >
          <TileBody
            tile={metrics}
            render={({ requests, errors }) => {
              if (requests === 0) return <span style={muted}>no requests recorded in the last hour</span>;
              const rate = (errors / requests) * 100;
              return (
                <>
                  <div style={number}>{rate.toFixed(rate > 0 && rate < 1 ? 2 : 1)}%</div>
                  <div style={caption}>
                    {errors.toLocaleString()} errors of {requests.toLocaleString()} requests, last hour
                  </div>
                </>
              );
            }}
          />
        </Card>
      </div>
    </div>
  );
}
