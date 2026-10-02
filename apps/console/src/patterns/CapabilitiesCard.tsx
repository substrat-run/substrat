import { useEffect, useState } from 'react';
import { capabilityStatus, type CapabilityRecord, type Scope } from '@substrat-run/contracts';
import { Badge, Card, Checkbox, Table } from '../components';
import type { Api } from '../lib/api';
import { switchCardState } from '../lib/schedules';
import {
  STATUS_LABEL,
  authorLine,
  grantLine,
  operationsLine,
  capabilityTone,
  usesLine,
} from '../lib/capabilities';

const stamp = (iso: string) => iso.replace('T', ' ').replace(/\.\d+Z$/, 'Z');
const mono = { fontFamily: 'var(--font-mono)', fontSize: 12.5 } as const;

/**
 * The scope's capability directory (#1686): every link share and claim link that opens this
 * scope, what each may do, when it dies, how often it has been used. Read-only — a revoke is
 * `HostAdmin.revokeCapability`, a separate and audited act that this card does not front.
 *
 * Records only. A secret is stored nowhere and its hash is never selected, so there is
 * nothing here to copy a link from; the id is the handle for a revoke.
 */
export function CapabilitiesCard({ api, scope }: { api: Api; scope: Scope }) {
  const [rows, setRows] = useState<CapabilityRecord[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [revoked, setRevoked] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setError(null);
    api
      .listCapabilities(scope.tenantId, scope.id, { includeRevoked: revoked })
      .then((r) => {
        if (!cancelled) setRows(r);
      })
      .catch((e) => {
        if (!cancelled) setError(e);
      });
    return () => {
      cancelled = true;
    };
  }, [api, scope.tenantId, scope.id, revoked]);

  const state = switchCardState(rows, error);
  // Stamped at render: a standing is judged against the clock at the moment it is shown.
  const now = new Date().toISOString();

  return (
    <Card
      title="Capabilities"
      description="Links and claim links that act on this scope without a signed-in person: what each may do, who minted it, when it expires and how often it has been used. Only the directory row is shown — the secret is stored nowhere."
      actions={<Checkbox label="Show revoked" checked={revoked} onChange={setRevoked} />}
    >
      {state.kind === 'loading' && (
        <p style={{ margin: 0, fontSize: 12.5, color: 'var(--text-tertiary)' }}>Loading…</p>
      )}
      {state.kind === 'predates' && (
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <Badge status="warning">Redeploy needed</Badge>
          <p style={{ margin: 0, fontSize: 12.5, color: 'var(--text-tertiary)' }}>
            This scope's deployment predates the capability read (#1686). Deploy it, then retry.
          </p>
        </div>
      )}
      {state.kind === 'error' && (
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <Badge status="danger">Unavailable</Badge>
          <p style={{ margin: 0, fontSize: 12.5, color: 'var(--text-tertiary)' }}>{state.message}</p>
        </div>
      )}
      {state.kind === 'ready' && (
        <Table<CapabilityRecord>
          rows={state.entries}
          emptyText={revoked ? 'This scope has minted no capability.' : 'No live capability.'}
          columns={[
            {
              header: 'Capability',
              render: (r) => (
                <span>
                  <span title={r.id} style={mono}>
                    {r.id.slice(0, 4)}…{r.id.slice(-4)}
                  </span>
                  {r.label && <span style={{ display: 'block', fontSize: 12.5 }}>{r.label}</span>}
                </span>
              ),
            },
            { header: 'Kind', render: (r) => r.mode, mono: true },
            { header: 'May', render: (r) => grantLine(r), mono: true },
            { header: 'Operations', render: (r) => operationsLine(r), mono: true },
            {
              header: 'Minted',
              render: (r) => (
                <span style={{ fontSize: 12.5 }}>
                  {stamp(r.mintedAt)}
                  <span style={{ display: 'block', color: 'var(--text-tertiary)', ...mono }}>
                    by {authorLine(r.mintedBy)}
                  </span>
                </span>
              ),
            },
            { header: 'Expires', render: (r) => (r.expiresAt ? stamp(r.expiresAt) : 'never'), muted: true },
            { header: 'Uses', render: (r) => usesLine(r), align: 'right' },
            {
              header: 'Status',
              render: (r) => {
                const s = capabilityStatus(r, now);
                return (
                  <span>
                    <Badge status={capabilityTone(s)}>{STATUS_LABEL[s]}</Badge>
                    {r.revokedAt && r.revokedBy && (
                      <span style={{ display: 'block', fontSize: 12, color: 'var(--text-tertiary)' }}>
                        {stamp(r.revokedAt)} by {authorLine(r.revokedBy)}
                      </span>
                    )}
                  </span>
                );
              },
            },
          ]}
        />
      )}
    </Card>
  );
}
