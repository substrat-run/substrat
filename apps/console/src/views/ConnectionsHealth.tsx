import { Fragment, useEffect, useRef, useState } from 'react';
import type {
  ConnectionHealthEntry,
  ConnectionHealthPage,
  ConnectionHealthState,
  Tenant,
  TenantId,
} from '@substrat-run/contracts';
import { Badge, Button, Card, Input, Select, Stat, Tag } from '../components';
import type { Api } from '../lib/api';

const PAGE = 50;

export interface ConnectionsHealthProps {
  api: Api;
  tenants: Map<TenantId, Tenant>;
}

const HEALTH_BADGE: Record<ConnectionHealthState, 'success' | 'danger' | 'warning' | 'neutral'> = {
  healthy: 'success',
  erroring: 'danger',
  stale: 'warning',
  // Neutral, never green: a stored credential with no outcome has told us nothing (§3.8).
  'never-used': 'neutral',
};
const HEALTH_LABEL: Record<ConnectionHealthState, string> = {
  healthy: 'healthy',
  erroring: 'erroring',
  stale: 'stale',
  'never-used': 'never used',
};

const stamp = (at: string) => at.slice(0, 16).replace('T', ' ');

/** "3d ago" beside an absolute stamp — the reader's first question is how long. */
function ago(at: string, now: string): string {
  const s = Math.max(0, (Date.parse(now) - Date.parse(at)) / 1000);
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 129_600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

/**
 * Health → Connections (#1690): every tenant's connections on one page, each with the
 * health the platform derives from its last outcomes (`deriveConnectionHealth`), so
 * "which integrations are broken right now" is a glance rather than a tenant tour.
 * Read-only — repair is the tenant's reconnect, or §3.5.2's reconcile.
 */
export function ConnectionsHealth({ api, tenants }: ConnectionsHealthProps) {
  const [page, setPage] = useState<ConnectionHealthPage>();
  const [entries, setEntries] = useState<ConnectionHealthEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string>();
  const [error, setError] = useState<string>();

  const [statusFilter, setStatusFilter] = useState<'all' | ConnectionHealthState>('all');
  const [providerFilter, setProviderFilter] = useState('all');
  const [tenantFilter, setTenantFilter] = useState('all');
  const [q, setQ] = useState('');
  // The provider choices outlive a provider filter: once narrowed, the page only
  // names one provider, and the dropdown must still offer the others.
  const [providers, setProviders] = useState<string[]>([]);

  const serverFilter = {
    status: statusFilter === 'all' ? undefined : statusFilter,
    provider: providerFilter === 'all' ? undefined : providerFilter,
    tenantId: tenantFilter === 'all' ? undefined : (tenantFilter as TenantId),
  };

  const filterGeneration = useRef(0);

  useEffect(() => {
    filterGeneration.current += 1;
    let live = true;
    void (async () => {
      try {
        const p = await api.listConnectionHealth({ limit: PAGE, ...serverFilter });
        if (!live) return;
        setPage(p);
        setEntries(p.entries);
        setCursor(p.nextCursor);
        setError(undefined);
        if (providerFilter === 'all') setProviders(p.deadLetters.map((d) => d.provider));
      } catch (e) {
        if (!live) return;
        setPage(undefined);
        setEntries([]);
        setCursor(null);
        setError((e as Error).message);
      }
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, statusFilter, providerFilter, tenantFilter]);

  async function loadMore() {
    if (!cursor) return;
    const generation = filterGeneration.current;
    const p = await api.listConnectionHealth({ limit: PAGE, cursor, ...serverFilter });
    if (generation !== filterGeneration.current) return;
    setEntries((prev) => [...prev, ...p.entries]);
    setCursor(p.nextCursor);
  }

  const tenantLabel = (id: TenantId) => tenants.get(id)?.slug ?? id.slice(0, 8);
  const visible = entries.filter((e) => {
    if (!q) return true;
    const hay = `${e.provider}${tenantLabel(e.tenantId)}${e.vertical}${e.label}${e.externalAccountRef ?? ''}${e.lastError ?? ''}`.toLowerCase();
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
  const muted = <span style={{ color: 'var(--text-placeholder)' }}>—</span>;
  const COLUMNS = ['Provider', 'Tenant', 'Vertical', 'Account', 'Status', 'Last success', 'Last error', 'Grant expiry'];

  const summary = page?.summary;
  const staleDays = page?.staleAfterDays;
  const deadLetterDays = page
    ? Math.round((Date.parse(page.asOf) - Date.parse(page.deadLettersSince)) / 86_400_000)
    : undefined;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 22, lineHeight: '29px', fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--text-primary)' }}>
          Connections
        </h1>
        <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--text-tertiary)', maxWidth: 680 }}>
          Every tenant's provider connections and how their last calls went. <em>Stale</em> means the last
          success is older than {staleDays ?? '…'} days, which a connection that only a monthly job uses will
          read as even when it is fine. <em>Never used</em> is a stored credential with no outcome yet, and
          is not the same as healthy. Credentials are never shown here.
        </p>
      </div>

      {summary && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
          <Stat label="Erroring" value={summary.erroring} meta={`of ${summary.total} connections`} />
          <Stat label="Stale" value={summary.stale} meta={`no success in ${staleDays} days`} />
          <Stat label="Never used" value={summary['never-used']} meta="stored, no outcome yet" />
          <Stat label="Healthy" value={summary.healthy} meta={`of ${summary.total} connections`} />
          <Stat
            label="Expiring"
            value={summary.expiring}
            meta={`grant ends within ${page.expiryWarningDays} days, where a connector reports it`}
          />
        </div>
      )}

      {page && page.deadLetters.length > 0 && (
        <Card
          padding={0}
          footer={`Connector deliveries that failed terminally or gave up, from the ops-failure record, over the last ${deadLetterDays} days. A count marked + reached the read's bound and is a floor.`}
        >
          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', padding: '12px 16px', fontSize: 12.5 }}>
            <span style={{ color: 'var(--text-tertiary)' }}>Dead letters</span>
            {page.deadLetters.map((d) => (
              <span key={d.provider} style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                <Tag mono>{d.provider}</Tag>
                <span style={{ fontFamily: 'var(--font-mono)', color: d.count > 0 ? 'var(--status-danger-fg)' : 'var(--text-tertiary)' }}>
                  {d.count}
                  {d.capped ? '+' : ''}
                </span>
              </span>
            ))}
          </div>
        </Card>
      )}

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <Input placeholder="Filter by provider, tenant, account, or error…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 300 }} />
        <Select
          options={[
            { value: 'all', label: 'All statuses' },
            { value: 'erroring', label: 'Erroring now' },
            { value: 'stale', label: 'Stale' },
            { value: 'never-used', label: 'Never used' },
            { value: 'healthy', label: 'Healthy' },
          ]}
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
          style={{ width: 150 }}
        />
        <Select
          options={[{ value: 'all', label: 'All providers' }, ...providers.map((p) => ({ value: p, label: p }))]}
          value={providerFilter}
          onChange={(e) => setProviderFilter(e.target.value)}
          style={{ width: 150 }}
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
      </div>

      {error && (
        <Card>
          <span style={{ fontSize: 13, color: 'var(--status-danger-fg)' }}>{error}</span>
        </Card>
      )}

      <Card
        padding={0}
        footer={`Health comes from each connection's last recorded outcome. Grant expiry reads "not reported" when the connector records none, which no shipped connector does yet. Row click shows the full error. Cursor-paginated.`}
      >
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--font-sans)', fontSize: 14 }}>
            <thead>
              <tr>
                {COLUMNS.map((h) => (
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
                    <td style={td}>
                      {/* The keyboard path into the detail row — the tr's onClick is pointer-only. */}
                      <button
                        type="button"
                        aria-expanded={expanded === e.id}
                        aria-controls={expanded === e.id ? `conn-detail-${e.id}` : undefined}
                        onClick={(ev) => {
                          ev.stopPropagation();
                          setExpanded(expanded === e.id ? undefined : e.id);
                        }}
                        style={{ background: 'none', border: 0, padding: 0, font: 'inherit', color: 'inherit', cursor: 'pointer' }}
                      >
                        <Tag mono>{e.provider}</Tag>
                      </button>
                    </td>
                    <td style={{ ...td, fontFamily: 'var(--font-mono)', color: 'var(--text-tertiary)' }}>{tenantLabel(e.tenantId)}</td>
                    <td style={td}>
                      <Tag mono>{e.vertical}</Tag>
                    </td>
                    <td style={{ ...td, color: 'var(--text-primary)', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {e.label}
                      {e.externalAccountRef && (
                        <span style={{ marginLeft: 6, fontFamily: 'var(--font-mono)', color: 'var(--text-tertiary)' }}>{e.externalAccountRef}</span>
                      )}
                    </td>
                    <td style={td}>
                      <Badge status={HEALTH_BADGE[e.health]}>{HEALTH_LABEL[e.health]}</Badge>
                    </td>
                    <td style={{ ...td, fontFamily: 'var(--font-mono)', color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>
                      {e.lastOkAt && page ? <span title={e.lastOkAt}>{ago(e.lastOkAt, page.asOf)}</span> : muted}
                    </td>
                    <td style={{ ...td, maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {e.lastErrorAt && page ? (
                        <>
                          <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-tertiary)', marginRight: 8 }} title={e.lastErrorAt}>
                            {ago(e.lastErrorAt, page.asOf)}
                          </span>
                          <span style={{ color: 'var(--status-danger-fg)' }}>{e.lastError}</span>
                        </>
                      ) : (
                        muted
                      )}
                    </td>
                    <td style={{ ...td, whiteSpace: 'nowrap' }}>
                      {e.expiresAt ? (
                        <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                          <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-tertiary)' }}>{stamp(e.expiresAt)}</span>
                          {e.expiryWarning && (
                            <Badge status={e.expiryWarning === 'expired' ? 'danger' : 'warning'}>{e.expiryWarning}</Badge>
                          )}
                        </span>
                      ) : (
                        // Not a blank: an empty cell reads as "no problem", and here it means nobody told us.
                        <span style={{ color: 'var(--text-placeholder)' }}>not reported</span>
                      )}
                    </td>
                  </tr>
                  {expanded === e.id && (
                    <tr id={`conn-detail-${e.id}`}>
                      <td colSpan={COLUMNS.length} style={{ padding: 12, background: 'var(--surface-hover)', borderBottom: '1px solid var(--border-subtle)' }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12.5 }}>
                          {e.lastError && (
                            <div style={{ fontFamily: 'var(--font-mono)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--status-danger-fg)' }}>
                              {e.lastError}
                            </div>
                          )}
                          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>
                            <span>connection {e.id}</span>
                            <span>stored status {e.status}</span>
                            <span>created {stamp(e.createdAt)}</span>
                            {e.lastOkAt && <span>last success {stamp(e.lastOkAt)}</span>}
                            {e.lastErrorAt && <span>last error {stamp(e.lastErrorAt)}</span>}
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
              {visible.length === 0 && (
                <tr>
                  <td colSpan={COLUMNS.length} style={{ ...td, color: 'var(--text-placeholder)', textAlign: 'center', height: 80 }}>
                    {entries.length === 0 && !error ? 'No connections match.' : 'No entries match.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {cursor && (
          <div style={{ padding: 12, display: 'flex', justifyContent: 'center' }}>
            <Button variant="ghost" size="sm" onClick={() => void loadMore()}>
              Load more
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}
