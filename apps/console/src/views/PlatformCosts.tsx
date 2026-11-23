import { useCallback, useEffect, useState } from 'react';
import type { StaffPlatformCosts, Tenant, TenantId } from '@substrat-run/contracts';
import { Badge, Card, Segmented, Stat, Table } from '../components';
import type { TableColumn } from '../components';
import type { Api } from '../lib/api';
import { ApiError } from '../lib/api';

/**
 * Platform cost (#3316), staff only: what each tenant's usage costs the platform at Cloudflare's
 * list price, the markup the schedule adds and the price a tenant would see, side by side, per
 * tenant and per day. The residual is the part of the account's usage no tenant is charged for:
 * objects no scope owns (`unmapped`), the platform's own scripts (`platform`), scripts the
 * directory has no vertical for (`unknown`).
 *
 * Every figure is the plane's decimal string; this view formats, it never computes a price.
 */

type Tenantly = StaffPlatformCosts['tenants'][number];
type Period = '7' | '30' | '90';
const PERIODS: { value: Period; label: string }[] = [
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
];

/** Display only: the plane did the arithmetic in decimal strings. */
const usd = (s: string | null) =>
  s === null
    ? '—'
    : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(s));
const share = (part: string, whole: string) => (Number(whole) > 0 ? `${Math.round((Number(part) / Number(whole)) * 100)}%` : '—');
const mono = { fontFamily: 'var(--font-mono)' } as const;
const muted = { color: 'var(--text-tertiary)' } as const;

export function PlatformCosts({ api, tenants, onOpenTenant }: { api: Api; tenants: Map<TenantId, Tenant>; onOpenTenant: (id: TenantId) => void }) {
  const [period, setPeriod] = useState<Period>('30');
  const [reading, setReading] = useState<StaffPlatformCosts | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | undefined>();

  // A slower answer for the period before must not replace the one now selected.
  const load = useCallback(() => {
    let current = true;
    setReading(null);
    setError(null);
    api
      .readPlatformCosts({ days: Number(period) })
      .then((r) => { if (current) setReading(r); })
      .catch((e: Error) => { if (current) setError(e instanceof ApiError && e.status === 501 ? 'This control plane keeps no Cloudflare cost rollup.' : e.message); });
    return () => { current = false; };
  }, [api, period]);
  useEffect(load, [load]);

  const nameOf = (id: string) => tenants.get(id as TenantId)?.name ?? id;
  const priced = <T extends { costUsd: string; markupUsd: string | null; priceUsd: string | null; previewCostUsd: string }>(): TableColumn<T>[] => [
    { header: 'Cost', align: 'right', render: (r) => <span style={mono}>{usd(r.costUsd)}</span> },
    { header: 'Markup', align: 'right', render: (r) => <span style={{ ...mono, ...muted }}>{usd(r.markupUsd)}</span> },
    { header: 'Price', align: 'right', render: (r) => <span style={{ ...mono, fontWeight: 600 }}>{usd(r.priceUsd)}</span> },
    { header: 'Preview share', align: 'right', render: (r) => share(r.previewCostUsd, r.costUsd) },
  ];
  const tenantColumns: TableColumn<Tenantly>[] = [
    {
      header: 'Tenant',
      render: (r) => (
        <button type="button" onClick={(e) => { e.stopPropagation(); onOpenTenant(r.tenantId); }} style={{ all: 'unset', cursor: 'pointer', fontWeight: 500 }}>
          {nameOf(r.tenantId)}
        </button>
      ),
    },
    ...priced<Tenantly>(),
    {
      header: 'Top verticals',
      render: (r) => (
        <span style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
          {r.topVerticals.map((v) => `${v.vertical ?? 'no app'} ${usd(v.costUsd)}`).join(' · ')}
        </span>
      ),
    },
  ];
  const dayColumns = priced<Tenantly['days'][number]>();
  const residualColumns: TableColumn<StaffPlatformCosts['residual']['days'][number]>[] = [
    { header: 'Day', key: 'day', mono: true },
    { header: 'Unmapped', align: 'right', render: (r) => <span style={mono}>{usd(r.unmapped)}</span> },
    { header: 'Platform', align: 'right', render: (r) => <span style={mono}>{usd(r.platform)}</span> },
    { header: 'Unknown', align: 'right', render: (r) => <span style={mono}>{usd(r.unknown)}</span> },
    { header: 'Total', align: 'right', render: (r) => <span style={{ ...mono, fontWeight: 600 }}>{usd(r.costUsd)}</span> },
  ];

  const coverage = reading
    ? `${reading.since} – ${reading.until} · ${reading.readDays} of ${reading.totalDays} days read${reading.lastReadAt ? `, last ${new Date(reading.lastReadAt).toLocaleString()}` : ''}${reading.truncated ? ' · request or storage rows capped: a lower bound' : ''}`
    : 'Reading…';
  const failing = reading?.days.filter((d) => !d.read && d.error) ?? [];

  return (
    <Card
      title="Platform cost (Cloudflare)"
      description={`Attributed cost at list price, the markup in force each day, and the price a tenant sees. ${coverage}`}
      actions={<Segmented label="Period" options={PERIODS} value={period} onChange={setPeriod} />}
    >
      {error ? (
        <div role="alert" style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{error}</div>
      ) : !reading ? null : reading.state === 'not-read' ? (
        <div role="status" style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
          <strong>The cost rollup has read no day in this period.</strong> The scheduled pass reads each closed day after 03:00 UTC (and catches up three days per pass); a backfilled day appears once it is loaded. Nothing here means zero usage.
          {failing.length > 0 && <> Last failure: <span style={mono}>{failing[failing.length - 1]!.error}</span></>}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
            <Stat label="Attributed cost" value={usd(reading.totals.costUsd)} meta="list price, before allowances" />
            <Stat label="Markup" value={usd(reading.totals.markupUsd)} meta="price − cost, per the schedule" />
            <Stat label="Price" value={usd(reading.totals.priceUsd)} meta="what tenants would be charged" />
            <Stat label="Preview share" value={share(reading.totals.previewCostUsd, reading.totals.costUsd)} meta={`${usd(reading.totals.previewCostUsd)} of cost`} />
            <Stat label="Unattributed" value={usd(reading.totals.residualCostUsd)} meta="cost no tenant is charged for" />
          </div>
          {reading.state === 'empty' && (
            <div role="status" style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
              The read days hold no usage at all: no tenant and no residual.
            </div>
          )}
          {failing.length > 0 && (
            <div style={{ fontSize: 13 }}>
              <Badge status="warning">{failing.length} {failing.length === 1 ? 'day' : 'days'} failing</Badge>{' '}
              <span style={muted}>{failing.map((d) => d.day).join(', ')}</span>
            </div>
          )}
          <Table
            label="Platform cost per tenant"
            columns={tenantColumns}
            rows={reading.tenants}
            rowKey={(r) => r.tenantId}
            expanded={open}
            onRowClick={(r) => setOpen(open === r.tenantId ? undefined : r.tenantId)}
            detail={(r) => (
              <Table label={`Per day for ${nameOf(r.tenantId)}`} columns={[{ header: 'Day', key: 'day', mono: true }, ...dayColumns]} rows={[...r.days].reverse()} paged />
            )}
            emptyText="No tenant has attributed usage on the read days."
          />
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, margin: '4px 0 8px' }}>
              Unattributed residual · {usd(reading.residual.costUsd)}{' '}
              <span style={{ fontWeight: 400, ...muted }}>
                unmapped {usd(reading.residual.unmapped)} · platform {usd(reading.residual.platform)} · unknown {usd(reading.residual.unknown)}
              </span>
            </div>
            <Table label="Unattributed residual per day" columns={residualColumns} rows={[...reading.residual.days].reverse()} paged emptyText="Everything read is attributed to a tenant." />
          </div>
          <p style={{ margin: 0, fontSize: 12, ...muted }}>
            List rates: {reading.rates.map((r) => `${r.dimension} $${r.usd} per ${r.per.toLocaleString()} ${r.unit}`).join(' · ')}. Storage write units are not priced: SQLite-backed objects bill rows written.
          </p>
        </div>
      )}
    </Card>
  );
}
