import { useEffect, useState } from 'react';
import type { ScopeId, StorageGauge, TenantId } from '@substrat-run/contracts';
import { Badge, Button, Card, Stat } from '../components';
import type { Api } from '../lib/api';
import {
  EXCLUSION_LABEL,
  foldStoragePage,
  formatBytes,
  gaugeView,
  partialNote,
  scopesLeftOut,
  type StorageTally,
} from '../lib/storage';

/**
 * One tenant's storage (#1524): the stored daily figure, and a live reading on demand.
 *
 * The stored figure comes with meter 1 and wakes nothing. The live reading is the one to
 * press for when the stored one is partial or stale, or a number from right now is needed.
 *
 * Nothing is read when the page opens. Every scope in the reading is a Durable Object the
 * platform wakes, so the card reads only when someone presses the button, one page of
 * scopes at a time (the platform caps a page). A sum that is missing any scope, because a
 * page is left or a read failed, is labelled partial and never shown as the total.
 */
export function StorageCard({
  api,
  tenantId,
  readableScopes,
  stored,
}: {
  api: Api;
  tenantId: TenantId;
  /** Non-reaped scopes, from meter 1: what a full reading will wake. */
  readableScopes: number;
  /** The stored gauge, from meter 1. Absent when the host keeps none. */
  stored?: StorageGauge;
}) {
  const [tally, setTally] = useState<StorageTally | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A different tenant is a different reading. Never carry one tenant's sum onto another.
  useEffect(() => {
    setTally(null);
    setError(null);
  }, [tenantId]);

  const read = (from: StorageTally | null) => {
    setBusy(true);
    setError(null);
    api
      .readStorage(tenantId, (from?.nextCursor ?? undefined) as ScopeId | undefined)
      .then((page) => setTally(foldStoragePage(from, page)))
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };

  const left = tally ? scopesLeftOut(tally) : null;
  const daily = gaugeView(stored, Date.now());
  const excluded = (tally?.excluded ?? (['attachments', 'tenant-stores', 'lake'] as const))
    .map((k) => EXCLUSION_LABEL[k])
    .join(', ');

  return (
    <Card
      title="Storage (scope databases)"
      description="The size of each scope's own database, summed. The stored figure is sampled daily by the scheduled pass; the live reading wakes every scope, so it waits for you to ask. Nothing is billed."
      actions={
        tally?.nextCursor ? (
          <Button variant="secondary" onClick={() => read(tally)} disabled={busy}>
            {busy ? 'Reading…' : 'Read next page'}
          </Button>
        ) : (
          <Button variant="secondary" onClick={() => read(null)} disabled={busy || readableScopes === 0}>
            {busy ? 'Reading…' : tally ? 'Re-read' : `Read storage (${readableScopes} scope${readableScopes === 1 ? '' : 's'})`}
          </Button>
        )
      }
      footer={`Not counted: ${excluded}.${tally ? ` Read at ${new Date(tally.readAt).toLocaleString()}.` : ''}`}
    >
      {stored && (
        <div style={{ marginBottom: 12, fontSize: 13, color: 'var(--text-secondary)' }}>
          <strong style={{ color: 'var(--text-primary)' }}>Stored: {daily.value}</strong>{' '}
          {daily.label !== 'total' && <Badge status={daily.label === 'failing' ? 'danger' : 'warning'}>{daily.label}</Badge>} {daily.detail}
        </div>
      )}
      {error && (
        <div style={{ marginBottom: 12 }}>
          <Badge status="danger">Could not read</Badge>{' '}
          <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{error}</span>
        </div>
      )}
      {!tally ? (
        <span style={{ fontSize: 13, color: 'var(--text-placeholder)' }}>
          {readableScopes === 0 ? 'No scope holds data.' : 'Not read live yet.'}
        </span>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
            <Stat
              label={tally.complete ? 'Total' : 'Partial sum'}
              value={formatBytes(tally.bytes)}
              meta={
                tally.complete
                  ? `across all ${tally.read} scope${tally.read === 1 ? '' : 's'}`
                  : `${tally.read} scope${tally.read === 1 ? '' : 's'} read over ${tally.pages} page${tally.pages === 1 ? '' : 's'} · not the total`
              }
            />
            <Stat
              label="Not in the sum"
              value={left === null ? 'unknown' : left}
              meta={
                left === null
                  ? 'the directory may have changed during the walk'
                  : tally.failed > 0
                    ? `${tally.failed} failed${tally.nextCursor ? ' · more pages left' : ''}`
                    : tally.nextCursor
                      ? 'more pages left'
                      : 'none'
              }
            />
            <Stat label="Reaped" value={tally.reaped} meta="not read: their storage is gone" />
          </div>
          {!tally.complete && (
            <div>
              <Badge status="warning">Partial</Badge>{' '}
              <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{partialNote(tally)}</span>
            </div>
          )}
          {tally.failures.length > 0 && (
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
              {tally.failures.map((f) => (
                <li key={f.scopeId}>
                  <span style={{ fontFamily: 'var(--font-mono)' }}>{f.scopeId}</span>: {f.error}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}
