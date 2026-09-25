import { useEffect, useRef, useState } from 'react';
import type { EdgeHealth, EdgeHealthReport, Scope } from '@substrat-run/contracts';
import { Badge, Button, Card, Dialog, Input, Table } from '../components';
import type { Api } from '../lib/api';
import { edgeBadgeStatus, edgeStateLabel, edgesCardState, leverOffered, leverRequest, LEVER_EFFECT, type LeverKind } from '../lib/edges';
import { errorMessage, validReason } from '../lib/schedules';

const stamp = (iso: string) => iso.replace('T', ' ').replace(/\.\d+Z$/, 'Z');
const lag = (ms: number | null) =>
  ms === null ? '—' : ms < 60_000 ? `${Math.floor(ms / 1000)}s` : ms < 3_600_000 ? `${Math.floor(ms / 60_000)} min` : `${Math.floor(ms / 3_600_000)} h`;

/**
 * Cross-vertical event edges into and out of this scope (#1705 PR 3), read live, with the replay
 * lever on the edges INTO it.
 *
 * The same states, words and lever as the dashboard's panel, because a tenant and an operator
 * looking at one edge must not be told two things. A replay runs the consumer's handlers again,
 * and anything they send or call outside the app happens again. The dialog says that in the
 * platform's own words, and Confirm stays disabled until the box is ticked and a reason given.
 */
export function EdgesCard({
  api,
  scope,
  onToast,
}: {
  api: Api;
  scope: Scope;
  onToast: (title: string, detail?: string, status?: 'success' | 'danger') => void;
}) {
  const [report, setReport] = useState<EdgeHealthReport | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [dialog, setDialog] = useState<{ edge: EdgeHealth; kind: LeverKind } | null>(null);
  const [reason, setReason] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const moving = useRef(false);

  async function reload() {
    try {
      setReport(await api.crossVerticalEdges(scope.tenantId));
      setError(null);
    } catch (e) {
      setReport(null);
      setError(e);
    }
  }

  useEffect(() => {
    let cancelled = false;
    setReport(null);
    setError(null);
    api
      .crossVerticalEdges(scope.tenantId)
      .then((r) => {
        if (!cancelled) setReport(r);
      })
      .catch((e) => {
        if (!cancelled) setError(e);
      });
    return () => {
      cancelled = true;
    };
  }, [api, scope.tenantId]);

  const state = edgesCardState(report, error, scope.id);
  // Nothing to say on a scope with no edge, which is most of them.
  if (state.kind === 'ready' && state.entries.length === 0) return null;

  async function confirmMove() {
    if (!dialog || moving.current || !agreed || !validReason(reason)) return;
    moving.current = true;
    setBusy(true);
    try {
      const moved = await api.moveImportCursor(
        scope.tenantId,
        scope.id,
        leverRequest(dialog.kind, dialog.edge.producer.vertical, reason),
      );
      onToast(
        moved.mode === 'replay' ? 'Replay set' : 'Skipped to now',
        `${dialog.edge.producer.vertical} → ${scope.slug} · the next pass reads from the new watermark` +
          (moved.mode === 'replay' ? ` · ${moved.archived.journal} earlier deliveries kept as history` : ''),
      );
      setDialog(null);
      setReason('');
      setAgreed(false);
      await reload();
    } catch (e) {
      onToast('Nothing was moved', errorMessage(e), 'danger');
    } finally {
      moving.current = false;
      setBusy(false);
    }
  }

  return (
    <Card
      title="Cross-app events"
      description="The #1705 edges into and out of this scope, read live: whether each is caught up, behind, paused, or could not be asked. Replay and skip move this scope's watermark on an edge into it."
    >
      {state.kind === 'loading' && <p style={{ margin: 0, fontSize: 12.5, color: 'var(--text-tertiary)' }}>Loading…</p>}
      {state.kind === 'predates' && (
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <Badge status="warning">Redeploy needed</Badge>
          <p style={{ margin: 0, fontSize: 12.5, color: 'var(--text-tertiary)' }}>
            The control plane predates edge health (#1705). Deploy it, then retry.
          </p>
        </div>
      )}
      {state.kind === 'error' && (
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <Badge status="danger">Unavailable</Badge>
          <p style={{ margin: 0, fontSize: 12.5, color: 'var(--text-tertiary)' }}>{state.message}</p>
        </div>
      )}
      {report && !report.history.available && (
        <p style={{ margin: '0 0 8px', fontSize: 12.5, color: 'var(--text-tertiary)' }}>
          <Badge status="warning">No history</Badge> {report.history.reason}
        </p>
      )}
      {state.kind === 'ready' && (
        <Table<EdgeHealth>
          rows={state.entries}
          columns={[
            {
              header: 'Edge',
              render: (e) =>
                e.consumer.scopeId === scope.id ? (
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5 }}>from {e.producer.vertical}</span>
                ) : (
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5 }}>to {e.consumer.vertical}</span>
                ),
            },
            { header: 'State', render: (e) => <Badge status={edgeBadgeStatus(e.state)}>{edgeStateLabel(e.state)}</Badge> },
            { header: 'Oldest waiting', render: (e) => lag(e.lagMs) },
            {
              header: 'Last delivered',
              render: (e) => (e.lastDelivered ? stamp(e.lastDelivered.at) : <span style={{ color: 'var(--text-tertiary)' }}>—</span>),
            },
            {
              header: 'Why',
              render: (e) => (
                <span style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
                  {e.reason ?? (e.lastProblem ? `last pass: ${e.lastProblem.error ?? e.lastProblem.outcome}` : '—')}
                </span>
              ),
            },
            {
              header: 'Action',
              align: 'right',
              render: (e) =>
                leverOffered(e, scope.id) ? (
                  <span style={{ display: 'inline-flex', gap: 6 }}>
                    <Button size="sm" variant="secondary"
                      onClick={() => { setDialog({ edge: e, kind: 'replay' }); setReason(''); setAgreed(false); }}>
                      Replay
                    </Button>
                    <Button size="sm" variant="secondary"
                      onClick={() => { setDialog({ edge: e, kind: 'skip' }); setReason(''); setAgreed(false); }}>
                      Skip to now
                    </Button>
                  </span>
                ) : (
                  <span style={{ color: 'var(--text-tertiary)' }}>—</span>
                ),
            },
          ]}
        />
      )}

      <Dialog
        open={dialog !== null}
        title={dialog ? `${dialog.kind === 'replay' ? 'Replay' : 'Skip'} ${dialog.edge.producer.vertical} → ${scope.slug}?` : ''}
        description={
          dialog
            ? dialog.kind === 'replay'
              ? `Every event this scope has taken from ${dialog.edge.producer.vertical} is delivered again on the next pass: ${LEVER_EFFECT.replay}. The first deliveries are kept as history, not deleted.`
              : `Everything ${dialog.edge.producer.vertical} has sent up to now is passed over: ${LEVER_EFFECT.skip}.`
            : ''
        }
        danger
        confirmLabel={dialog?.kind === 'replay' ? 'Replay' : 'Skip'}
        width={500}
        busy={busy}
        confirmDisabled={!agreed || !validReason(reason)}
        onConfirm={confirmMove}
        onCancel={() => {
          if (!moving.current) setDialog(null);
        }}
      >
        <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13, margin: '0 0 10px' }}>
          <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
          <span>I understand: {dialog ? LEVER_EFFECT[dialog.kind] : ''}.</span>
        </label>
        <Input label="Reason" placeholder="Why is this watermark moving?" value={reason} onChange={(e) => setReason(e.target.value)} />
      </Dialog>
    </Card>
  );
}
