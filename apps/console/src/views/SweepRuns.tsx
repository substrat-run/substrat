import { Fragment, useEffect, useRef, useState } from 'react';
import type { SweepRunEntry, Tenant, TenantId } from '@substrat-run/contracts';
import { Badge, Button, Card, Input, Select, Tag } from '../components';
import type { Api } from '../lib/api';

const PAGE = 20;

/** Debounce a text filter so an exact-match server param isn't refetched per keystroke. */
function useDebounced(value: string, ms = 400): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

export interface SweepRunsProps {
  api: Api;
  tenants: Map<TenantId, Tenant>;
}

const OUTCOME_BADGE: Record<SweepRunEntry['outcome'], 'success' | 'danger' | 'warning'> = {
  ok: 'success',
  failed: 'danger',
  skipped: 'warning',
};

/**
 * Operations → Sweeps (#1232): the fleet-wide sweep record — every connection
 * polled, every schedule fired or skipped, every freshness verdict, newest
 * first. The staff twin of the dashboard's per-app strips: where a tenant sees
 * "their connection", staff see the whole fleet's units on one page, which is
 * how "the Tuesday cron never ran anywhere" reads as one glance rather than a
 * per-tenant tour.
 */
export function SweepRuns({ api, tenants }: SweepRunsProps) {
  const [entries, setEntries] = useState<SweepRunEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string>();
  const [error, setError] = useState<string>();

  const [tenantFilter, setTenantFilter] = useState('all');
  const [kindFilter, setKindFilter] = useState<'all' | 'connector' | 'schedule' | 'freshness'>('all');
  const [outcomeFilter, setOutcomeFilter] = useState<'all' | 'ok' | 'failed' | 'skipped'>('all');
  const [unitInput, setUnitInput] = useState('');
  // Server-side narrowing is EXACT match (the unit key) — debounced so typing
  // doesn't refetch per keystroke. Free-text stays client-side.
  const unit = useDebounced(unitInput.trim());
  const [q, setQ] = useState('');

  const serverFilter = {
    tenantId: tenantFilter === 'all' ? undefined : (tenantFilter as TenantId),
    kind: kindFilter === 'all' ? undefined : kindFilter,
    outcome: outcomeFilter === 'all' ? undefined : outcomeFilter,
    unit: unit || undefined,
  };

  // A filter change makes any in-flight older-page fetch stale — its rows belong
  // to the previous filter and must not be appended to the new result set.
  const filterGeneration = useRef(0);

  useEffect(() => {
    filterGeneration.current += 1;
    let live = true;
    void (async () => {
      try {
        const page = await api.listSweepRuns({ limit: PAGE, ...serverFilter });
        if (!live) return;
        setEntries(page.entries);
        setCursor(page.nextCursor);
        setError(undefined);
      } catch (e) {
        if (!live) return;
        setEntries([]);
        setCursor(null);
        setError((e as Error).message);
      }
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, tenantFilter, kindFilter, outcomeFilter, unit]);

  async function loadOlder() {
    if (!cursor) return;
    const generation = filterGeneration.current;
    const page = await api.listSweepRuns({ limit: PAGE, cursor, ...serverFilter });
    if (generation !== filterGeneration.current) return;
    setEntries((prev) => [...prev, ...page.entries]);
    setCursor(page.nextCursor);
  }

  const visible = entries.filter((e) => {
    if (!q) return true;
    const hay = `${e.unit}${e.operation ?? ''}${e.eventType ?? ''}${e.vertical ?? ''}${e.error ?? ''}`.toLowerCase();
    return hay.includes(q.toLowerCase());
  });

  const th: React.CSSProperties = {
    textAlign: 'left',
    padding: '0 16px',
    height: 36,
    fontSize: 11,
    fontWeight: 500,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    color: 'var(--text-tertiary)',
    borderBottom: '1px solid var(--border-default)',
    background: 'var(--surface-inset)',
    whiteSpace: 'nowrap',
  };
  const td: React.CSSProperties = {
    padding: '0 16px',
    height: 40,
    borderBottom: '1px solid var(--border-subtle)',
    fontSize: 12.5,
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 22, lineHeight: '29px', fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--text-primary)' }}>
          Sweeps
        </h1>
        <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--text-tertiary)', maxWidth: 640 }}>
          The fleet's sweep record (#1232), newest first: connections polled, schedules fired or
          skipped, freshness verdicts. A <em>skipped</em> connector is one that is bound but has no
          sweeper polling it; a <em>skipped</em> freshness row means the event has never landed.
        </p>
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <Input placeholder="Filter by unit, operation, event type, or error…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 300 }} />
        <Select
          options={[
            { value: 'all', label: 'All kinds' },
            { value: 'connector', label: 'Connectors' },
            { value: 'schedule', label: 'Schedules' },
            { value: 'freshness', label: 'Freshness' },
          ]}
          value={kindFilter}
          onChange={(e) => setKindFilter(e.target.value as typeof kindFilter)}
          style={{ width: 140 }}
        />
        <Select
          options={[
            { value: 'all', label: 'All outcomes' },
            { value: 'ok', label: 'ok' },
            { value: 'failed', label: 'failed' },
            { value: 'skipped', label: 'skipped' },
          ]}
          value={outcomeFilter}
          onChange={(e) => setOutcomeFilter(e.target.value as typeof outcomeFilter)}
          style={{ width: 140 }}
        />
        <Select
          options={[
            { value: 'all', label: 'All tenants' },
            ...[...tenants.values()].map((t) => ({ value: t.id, label: t.slug })),
          ]}
          value={tenantFilter}
          onChange={(e) => setTenantFilter(e.target.value)}
          style={{ width: 160 }}
        />
        <Input placeholder="Unit (exact — scopeId:op or connection id)" mono value={unitInput} onChange={(e) => setUnitInput(e.target.value)} style={{ width: 280 }} />
      </div>

      {error && (
        <Card>
          <span style={{ fontSize: 13, color: 'var(--status-danger-fg)' }}>{error}</span>
        </Card>
      )}

      <Card
        padding={0}
        footer="Rows are pruned after the retention horizon (14 days — high-frequency telemetry). Row click shows the detail. Cursor-paginated."
      >
        <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--font-sans)', fontSize: 14 }}>
          <thead>
            <tr>
              {['Time', 'Kind', 'Unit', 'Outcome', 'Tenant', 'Vertical'].map((h) => (
                <th key={h} style={th}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((e) => (
              <Fragment key={e.id}>
                <tr
                  onClick={() => setExpanded(expanded === e.id ? undefined : e.id)}
                  style={{ cursor: 'pointer', background: expanded === e.id ? 'var(--surface-hover)' : 'transparent' }}
                >
                  <td style={{ ...td, fontFamily: 'var(--font-mono)', color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>
                    {e.at.slice(0, 19).replace('T', ' ')}
                  </td>
                  <td style={td}>
                    <Tag mono>{e.kind}</Tag>
                  </td>
                  <td style={{ ...td, fontFamily: 'var(--font-mono)', color: 'var(--text-primary)', maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {/* The keyboard path into the detail row — the tr's onClick is pointer-only. */}
                    <button
                      type="button"
                      aria-expanded={expanded === e.id}
                      aria-controls={expanded === e.id ? `sweep-detail-${e.id}` : undefined}
                      onClick={(ev) => {
                        ev.stopPropagation();
                        setExpanded(expanded === e.id ? undefined : e.id);
                      }}
                      // Not `all: unset` — that would also erase the focus ring this exists for.
                      style={{ background: 'none', border: 0, padding: 0, font: 'inherit', color: 'inherit', cursor: 'pointer', textAlign: 'left' }}
                    >
                      {e.kind === 'schedule' ? (e.operation ?? e.unit) : e.kind === 'freshness' ? (e.eventType ?? e.unit) : e.unit}
                    </button>
                  </td>
                  <td style={td}>
                    <Badge status={OUTCOME_BADGE[e.outcome]}>{e.outcome}</Badge>
                  </td>
                  <td style={{ ...td, fontFamily: 'var(--font-mono)', color: 'var(--text-tertiary)' }}>
                    {e.tenantId ? (
                      (tenants.get(e.tenantId)?.slug ?? e.tenantId.slice(0, 8))
                    ) : (
                      <span style={{ color: 'var(--text-placeholder)' }}>—</span>
                    )}
                  </td>
                  <td style={td}>
                    {e.vertical ? <Tag mono>{e.vertical}</Tag> : <span style={{ color: 'var(--text-placeholder)' }}>—</span>}
                  </td>
                </tr>
                {expanded === e.id && (
                  <tr id={`sweep-detail-${e.id}`}>
                    <td colSpan={6} style={{ padding: 12, background: 'var(--surface-hover)', borderBottom: '1px solid var(--border-subtle)' }}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12.5 }}>
                        {e.error && (
                          <div style={{ fontFamily: 'var(--font-mono)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--status-danger-fg)' }}>
                            {e.error}
                          </div>
                        )}
                        <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap', color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>
                          <span>unit {e.unit}</span>
                          {e.scopeId && <span>scope {e.scopeId}</span>}
                          {e.version && <span>version {e.version}</span>}
                          {e.observedAt && <span>evidence {e.observedAt.slice(0, 19).replace('T', ' ')}</span>}
                          {e.elapsedMs !== null && <span>{e.elapsedMs}ms</span>}
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
            {visible.length === 0 && (
              <tr>
                <td colSpan={6} style={{ ...td, color: 'var(--text-placeholder)', textAlign: 'center', height: 80 }}>
                  {entries.length === 0 && !error
                    ? 'No sweep rows yet — the record fills as the platform cron passes.'
                    : 'No entries match.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {cursor && (
          <div style={{ padding: 12, display: 'flex', justifyContent: 'center' }}>
            <Button variant="ghost" size="sm" onClick={() => void loadOlder()}>
              Load older entries
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}
