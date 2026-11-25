import { useCallback, useEffect, useState } from 'react';
import type { ReconcileProgressReading } from '@substrat-run/contracts';
import { Button, Card, Stat, Table } from '../components';
import type { TableColumn } from '../components';
import type { Api } from '../lib/api';
import { ApiError } from '../lib/api';

/**
 * How far a promote's provision reconcile has reached one vertical's installs (K-69, rfc/tenant-scale.md
 * §7.5), staff only. Each install reconciles on its next wake; an idle one is counted where its receipt
 * stands until it wakes, so "behind" can stay above zero for as long as some install is not used.
 * Read on demand; nothing here wakes a scope.
 */

type Row = { versionId: string | null; installs: number; reconciled: number };

const mono = { fontFamily: 'var(--font-mono)', fontSize: 12.5 } as const;
const muted = { color: 'var(--text-tertiary)' } as const;

export function ReconcileProgress({ api, slug }: { api: Api; slug: string }) {
  const [reading, setReading] = useState<ReconcileProgressReading | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    let current = true;
    setLoading(true);
    api
      .readReconcileProgress(slug)
      .then((r) => { if (current) { setReading(r); setError(null); } })
      .catch((e: Error) => { if (current) setError(e instanceof ApiError && e.status === 404 ? 'This control plane does not count reconcile progress.' : e.message); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [api, slug]);

  useEffect(() => load(), [load]);

  const columns: TableColumn<Row>[] = [
    {
      header: 'Runs version',
      render: (r) => (r.versionId ? <span style={mono}>{r.versionId}</span> : <span style={muted}>unknown</span>),
    },
    { header: 'Serving', render: (r) => (r.versionId !== null && r.versionId === reading?.servingVersionId ? 'yes' : '') },
    { header: 'Installs', align: 'right', render: (r) => r.installs },
    { header: 'Reconciled', align: 'right', render: (r) => r.reconciled },
    { header: 'Behind', align: 'right', render: (r) => (r.versionId === null ? <span style={muted}>—</span> : r.installs - r.reconciled) },
  ];

  const description = !reading
    ? 'Reading…'
    : `${reading.complete ? 'Complete' : `${reading.behind.total} behind`} as of ${reading.asOf}. Each install reconciles on its next wake; an idle one stays behind until it is used.`;

  return (
    <Card
      title="Reconcile progress"
      description={description}
      actions={
        <Button size="sm" loading={loading} onClick={() => load()}>
          Refresh
        </Button>
      }
    >
      {error ? (
        <div role="alert" style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{error}</div>
      ) : !reading ? null : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
            <Stat label="Installs" value={reading.installs} meta="active, previews and forks apart" />
            <Stat label="Reconciled" value={reading.reconciled} meta={`of ${reading.installs}, on the version each runs`} />
            <Stat label="Behind" value={reading.behind.total} meta={`${reading.behind.receipt} receipt, ${reading.behind.followUp} retirements or shapes`} />
            <Stat label="Copies" value={reading.copies} meta="previews and forks, never reconciled" />
          </div>
          <Table label="Installs by version run" columns={columns} rows={reading.running} rowKey={(r) => r.versionId ?? '(unknown)'} emptyText="No installs." />
        </div>
      )}
    </Card>
  );
}
