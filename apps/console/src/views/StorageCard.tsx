import { useEffect, useState } from 'react';
import type { ScopeId, TenantId } from '@substrat-run/contracts';
import { Badge, Button, Card, Stat } from '../components';
import type { Api } from '../lib/api';
import {
  EXCLUSION_LABEL,
  foldStoragePage,
  formatBytes,
  partialNote,
  scopesLeftOut,
  type StorageTally,
} from '../lib/storage';

/**
 * One tenant's storage, read on demand (#1524).
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
}: {
  api: Api;
  tenantId: TenantId;
  /** Non-reaped scopes, from meter 1: what a full reading will wake. */
  readableScopes: number;
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
  const excluded = (tally?.excluded ?? (['attachments', 'tenant-stores', 'lake'] as const))
    .map((k) => EXCLUSION_LABEL[k])
    .join(', ');

  return (
    <Card
      title="Storage (scope databases)"
      description="The size of each scope's own database, summed. Read only when you ask for it, because each scope read wakes that scope. Nothing is stored or billed."
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
      {error && (
        <div style={{ marginBottom: 12 }}>
          <Badge status="danger">Could not read</Badge>{' '}
          <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{error}</span>
        </div>
      )}
      {!tally ? (
        <span style={{ fontSize: 13, color: 'var(--text-placeholder)' }}>
          {readableScopes === 0 ? 'No scope holds data.' : 'Not read yet.'}
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
