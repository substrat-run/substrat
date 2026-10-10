import { useEffect, useRef, useState } from 'react';
import { capabilityStatus, type CapabilityRecord, type Scope } from '@substrat-run/contracts';
import { Badge, Button, Card, Checkbox, Dialog, Table } from '../components';
import type { Api } from '../lib/api';
import { errorMessage, switchCardState } from '../lib/schedules';
import {
  STATUS_LABEL,
  appendPage,
  authorLine,
  coverageLine,
  grantLine,
  operationsLine,
  capabilityTone,
  revocable,
  usesLine,
} from '../lib/capabilities';

const stamp = (iso: string) => iso.replace('T', ' ').replace(/\.\d+Z$/, 'Z');
const mono = { fontFamily: 'var(--font-mono)', fontSize: 12.5 } as const;

/**
 * The scope's capability directory (#1686): every link share and claim link that opens this
 * scope, what each may do, when it dies, how often it has been used — and the revoke for a
 * leaked one (`HostAdmin.revokeCapability`, audited on the admin log), behind an in-page
 * confirm. Every revoke attempt re-reads the directory afterwards, whatever it answered: a
 * failure whose answer was lost may still have revoked, and the card shows what is true now.
 *
 * Records only. A secret is stored nowhere and its hash is never selected, so there is
 * nothing here to copy a link from; the id is the handle for a revoke.
 */
export function CapabilitiesCard({
  api,
  scope,
  onToast,
}: {
  api: Api;
  scope: Scope;
  onToast: (title: string, detail?: string, status?: 'success' | 'danger') => void;
}) {
  const [rows, setRows] = useState<CapabilityRecord[] | null>(null);
  // Where the next page starts: null once the walk is complete, so "more" is never a guess.
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [moreError, setMoreError] = useState<unknown>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [revoked, setRevoked] = useState(false);
  // The capability the confirm is open for, and whether its revoke is in flight.
  const [confirming, setConfirming] = useState<CapabilityRecord | null>(null);
  const [busy, setBusy] = useState(false);
  // Bumped after a revoke so the read below runs again. A ref guards a double click, which a
  // `useState` flag cannot: both clicks would see it false before the setter lands.
  const [reload, setReload] = useState(0);
  const revoking = useRef(false);
  // Which read the screen is waiting on, so a page that lands after the filter moved is dropped.
  const generation = useRef(0);

  useEffect(() => {
    const mine = ++generation.current;
    setRows(null);
    setNext(null);
    setError(null);
    setMoreError(null);
    setLoadingMore(false);
    api
      .listCapabilities(scope.tenantId, scope.id, { includeRevoked: revoked })
      .then((p) => {
        if (generation.current !== mine) return;
        setRows(p.entries);
        setNext(p.nextCursor);
      })
      .catch((e) => {
        if (generation.current === mine) setError(e);
      });
    return () => {
      // Invalidates this read's answer if it is still in flight.
      generation.current++;
    };
  }, [api, scope.tenantId, scope.id, revoked, reload]);

  async function loadMore() {
    if (next === null || loadingMore) return;
    const mine = generation.current;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const p = await api.listCapabilities(scope.tenantId, scope.id, { includeRevoked: revoked, cursor: next as never });
      if (generation.current !== mine) return;
      setRows((held) => appendPage(held ?? [], p.entries));
      setNext(p.nextCursor);
    } catch (e) {
      if (generation.current === mine) setMoreError(e);
    } finally {
      if (generation.current === mine) setLoadingMore(false);
    }
  }

  async function confirmRevoke() {
    if (!confirming || revoking.current) return;
    const target = confirming;
    revoking.current = true;
    setBusy(true);
    try {
      await api.revokeCapability(scope.tenantId, scope.id, target.id as never);
      onToast('Capability revoked', `${target.label ?? target.id} on ${scope.slug}`);
    } catch (e) {
      onToast('Revoke failed', errorMessage(e), 'danger');
    } finally {
      revoking.current = false;
      setBusy(false);
      setConfirming(null);
      setReload((n) => n + 1);
    }
  }

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
            {
              header: '',
              render: (r) =>
                revocable(capabilityStatus(r, now)) ? (
                  <Button size="sm" variant="secondary" onClick={() => setConfirming(r)}>
                    Revoke
                  </Button>
                ) : null,
            },
          ]}
        />
      )}
      {state.kind === 'ready' && state.entries.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12 }}>
          <span style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }} aria-live="polite">
            {coverageLine(state.entries.length, next !== null)}
          </span>
          {next !== null && (
            <Button size="sm" variant="secondary" onClick={loadMore} loading={loadingMore}>
              Load older
            </Button>
          )}
          {moreError !== null && moreError !== undefined && (
            <Badge status="danger">
              {moreError instanceof Error ? moreError.message : 'Could not load older capabilities'}
            </Badge>
          )}
        </div>
      )}
      <Dialog
        open={confirming !== null}
        title={confirming ? `Revoke ${confirming.label ?? confirming.id}?` : ''}
        description={
          confirming?.mode === 'become'
            ? 'Its secret stops working at once: nobody can claim the seat with it. Anyone it has already bound keeps that binding. This cannot be undone; a new link has to be minted.'
            : 'Its secret stops working at once, and every session it handed out is refused from its next call. This cannot be undone; a new link has to be shared.'
        }
        danger
        confirmLabel="Revoke"
        width={480}
        busy={busy}
        onConfirm={confirmRevoke}
        onCancel={() => setConfirming(null)}
      />
    </Card>
  );
}
