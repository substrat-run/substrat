import { useEffect, useMemo, useState } from 'react';
import type { ScopeId, StaleScope, StaleScopeFindingKind, StaleScopesReading, Tenant, TenantId } from '@substrat-run/contracts';
import { Card, Segmented, Table } from '../components';
import type { TableColumn } from '../components';
import type { Api } from '../lib/api';
import { ApiError } from '../lib/api';

/**
 * The daily stale-scopes report (#3313), staff only: the scopes nothing will clean up, as the
 * latest daily pass found them, grouped by finding and ordered by tenant. Each row's age is how long
 * the finding has been true. The report moves nothing: a row opens the scope, whose own Archive and
 * Retire doors are the way to act on it. "Last used" is the newest day the router counted a routed
 * request for the scope, so a scope reached only by peer calls or schedules shows none.
 */

const LABEL: Record<StaleScopeFindingKind, string> = {
  'tenant-not-active': 'Tenant not active',
  'vertical-gone': 'Vertical gone',
  unreachable: 'Unreachable',
  'stuck-provisioning': 'Stuck provisioning',
  'no-expiry': 'Copy with no expiry',
  'expired-not-reaped': 'Expired, not reaped',
  'archived-undated': 'Archived, undated',
  idle: 'Idle',
};
const ORDER = Object.keys(LABEL) as StaleScopeFindingKind[];
const DAY_MS = 86_400_000;
const mono = { fontFamily: 'var(--font-mono)', fontSize: 12.5 } as const;
const muted = { color: 'var(--text-tertiary)' } as const;
const plain = { background: 'none', border: 0, padding: 0, margin: 0, font: 'inherit', color: 'inherit', cursor: 'pointer' } as const;

export function StaleScopes({ api, tenants, onOpen }: { api: Api; tenants: Map<TenantId, Tenant>; onOpen: (id: ScopeId) => void }) {
  const [reading, setReading] = useState<StaleScopesReading | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [finding, setFinding] = useState<StaleScopeFindingKind | undefined>();

  useEffect(() => {
    let current = true;
    api
      .readStaleScopes({ limit: 5000 })
      .then((r) => { if (current) setReading(r); })
      .catch((e: Error) => { if (current) setError(e instanceof ApiError && e.status === 501 ? 'This control plane keeps no stale-scopes report.' : e.message); });
    return () => { current = false; };
  }, [api]);

  const counts = useMemo(() => {
    const m = new Map<StaleScopeFindingKind, number>();
    for (const f of reading?.findings ?? []) m.set(f.finding, (m.get(f.finding) ?? 0) + 1);
    return m;
  }, [reading]);
  const present = ORDER.filter((k) => counts.has(k));
  const shown = finding && counts.has(finding) ? finding : present[0];
  const rows = (reading?.findings ?? []).filter((f) => f.finding === shown);

  const columns: TableColumn<StaleScope>[] = [
    { header: 'Tenant', render: (f) => tenants.get(f.tenantId)?.name ?? f.tenantSlug ?? f.tenantId },
    {
      header: 'Scope',
      render: (f) => (
        <button type="button" onClick={() => onOpen(f.scopeId)} style={{ ...plain, ...mono }}>
          {f.scopeId}
        </button>
      ),
    },
    { header: 'Vertical', render: (f) => f.vertical ?? <span style={muted}>none</span> },
    { header: 'Status', key: 'status' },
    { header: 'Why', render: (f) => <span style={{ fontSize: 12.5 }}>{f.detail}</span> },
    { header: 'For', align: 'right', render: (f) => `${Math.floor((Date.parse(f.lastSeen) - Date.parse(f.firstSeen)) / DAY_MS) + 1} d` },
    { header: 'Last used', render: (f) => (f.lastRequestDay ? <span style={mono}>{f.lastRequestDay}</span> : <span style={muted}>—</span>) },
  ];

  const latest = reading?.latest;
  const description = !reading
    ? 'Reading…'
    : latest
      ? `Report of ${latest.day}${latest.takenAt ? '' : ` failed: ${latest.error ?? 'unknown error'}`}. ${reading.findings.length}${reading.truncated ? '+' : ''} findings. Idle is ${latest.idleJudged ? 'judged from the request rollup' : 'not judged: the request rollup has not read the whole window'}. Nothing here is moved automatically.`
      : 'No daily report has run yet.';

  return (
    <Card
      title="Stale scopes"
      description={description}
      actions={
        present.length > 0 && shown ? (
          <Segmented
            label="Finding"
            options={present.map((k) => ({ value: k, label: `${LABEL[k]} ${counts.get(k)}` }))}
            value={shown}
            onChange={(v) => setFinding(v as StaleScopeFindingKind)}
          />
        ) : undefined
      }
      padding={0}
    >
      {error ? (
        <div role="alert" style={{ fontSize: 13, color: 'var(--text-secondary)', padding: 16 }}>{error}</div>
      ) : (
        <Table label="Stale scopes" columns={columns} rows={rows} rowKey={(f) => `${f.scopeId} ${f.finding}`} paged emptyText="No stale scopes." />
      )}
    </Card>
  );
}
