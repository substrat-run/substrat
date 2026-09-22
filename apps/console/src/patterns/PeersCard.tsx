import { useEffect, useRef, useState } from 'react';
import type { PeerGrantsStatusEntry, Scope } from '@substrat-run/contracts';
import { Badge, Button, Card, Dialog, Input, Table } from '../components';
import type { Api } from '../lib/api';
import { peerBadgeStatus, peerStateLabel, peersCardState } from '../lib/peers';
import { errorMessage, performSwitch, submitSwitch, validReason } from '../lib/schedules';
import { ActorCell } from './ActorCell';

const stamp = (iso: string) => iso.replace('T', ' ').replace(/\.\d+Z$/, 'Z');

/**
 * The #1706 peer kill switch's console control — which of the tenant's OTHER apps may call
 * into this scope, and the lever that cuts one off.
 *
 * Deliberately the Schedules card's shape (#1675), down to the two-failure switch and the
 * 501-is-its-own-state read, because they are the same mechanism with the subject swapped and
 * an operator should not have to learn two of them. The one thing said differently is what a
 * position MEANS: a module's `ungranted` is background, whereas a peer's is a tenant-facing
 * fact ("holds nothing here"), so it is spelled out rather than shown as a bare word.
 *
 * No separate admin-log call: the status read already joins in who switched a peer off, when
 * and why. Reading the log again here would read the same fact twice and risk disagreeing.
 */
export function PeersCard({
  api,
  scope,
  onToast,
}: {
  api: Api;
  scope: Scope;
  onToast: (title: string, detail?: string, status?: 'success' | 'danger') => void;
}) {
  const [entries, setEntries] = useState<PeerGrantsStatusEntry[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [dialog, setDialog] = useState<{ vertical: string; to: 'on' | 'off' } | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  // A ref, not `useState`: two clicks on Confirm in the same tick both see a `useState`
  // flag as false, because the setter only lands on the next render (#1702 review).
  const switching = useRef(false);

  async function load() {
    return api.peerGrantsStatus(scope.tenantId, scope.id);
  }

  useEffect(() => {
    let cancelled = false;
    setEntries(null);
    setError(null);
    load()
      .then((e) => {
        if (!cancelled) setEntries(e);
      })
      .catch((e) => {
        if (!cancelled) setError(e);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, scope.tenantId, scope.id]);

  const state = peersCardState(entries, error);

  async function confirmSwitch() {
    if (!dialog || switching.current) return;
    const { vertical, to } = dialog;
    const trimmed = reason.trim();
    if (!validReason(trimmed)) return;
    setBusy(true);
    try {
      // The write and the re-read are two failures, not one (#1707): a switch that lands
      // but whose follow-up read fails must never say "Refused" — the write already
      // happened, and "Refused" would send an operator to retry it.
      const attempt = await submitSwitch(switching, () =>
        performSwitch(
          () =>
            to === 'off'
              ? api.switchPeerOff(scope.tenantId, scope.id, vertical, trimmed)
              : api.switchPeerOn(scope.tenantId, scope.id, vertical, trimmed),
          load,
        ),
      );
      if (attempt === null) return; // a submit was already in flight — this click was skipped
      if (attempt.kind === 'refused') {
        onToast('Refused', errorMessage(attempt.error), 'danger');
        return;
      }
      if (attempt.kind === 'unconfirmed') {
        // The switch applied, but the read that would prove it failed. Clear the stale
        // entries: the card must never show "May call in" once it can no longer vouch for
        // that being true — on this switch, a wrong "on" is a tenant believing it cut off
        // access it did not cut off.
        setEntries(null);
        setError(attempt.error);
        onToast(
          `${to === 'off' ? 'Switched off' : 'Switched back on'}, but the status could not be re-read`,
          `${vertical} on ${scope.slug} · ${errorMessage(attempt.error)}`,
          'danger',
        );
        setDialog(null);
        setReason('');
        return;
      }
      setEntries(attempt.entries);
      setError(null);
      setDialog(null);
      setReason('');
      onToast(
        to === 'off' ? 'Peer switched off' : 'Peer switched back on',
        `${vertical} on ${scope.slug}${attempt.result.changed ? '' : ' · already in that position'}`,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title="Peers"
      description="The #1706 kill switch — which of this tenant's other apps may call into this scope. Restore is the only way back on; no re-provision re-seats a switched-off peer."
    >
      {state.kind === 'loading' && (
        <p style={{ margin: 0, fontSize: 12.5, color: 'var(--text-tertiary)' }}>Loading…</p>
      )}
      {state.kind === 'predates' && (
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <Badge status="warning">Redeploy needed</Badge>
          <p style={{ margin: 0, fontSize: 12.5, color: 'var(--text-tertiary)', lineHeight: '18px' }}>
            This scope's deployment predates the peer switch (#1706). Redeploy the vertical,
            then retry — nothing here can be read or moved until then.
          </p>
        </div>
      )}
      {state.kind === 'error' && (
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <Badge status="danger">Unavailable</Badge>
          <p style={{ margin: 0, fontSize: 12.5, color: 'var(--text-tertiary)', lineHeight: '18px' }}>
            {state.message}
          </p>
        </div>
      )}
      {state.kind === 'ready' &&
        (state.entries.length === 0 ? (
          <p style={{ margin: 0, fontSize: 12.5, color: 'var(--text-tertiary)' }}>
            No other app of this tenant has been granted a way in here.
          </p>
        ) : (
          <Table<PeerGrantsStatusEntry>
            rows={state.entries}
            columns={[
              { header: 'Calling app', key: 'vertical', mono: true },
              {
                header: 'Position',
                render: (e) => <Badge status={peerBadgeStatus(e.calls)}>{peerStateLabel(e.calls)}</Badge>,
              },
              {
                header: 'Switched off',
                render: (e) =>
                  e.switchedOff ? (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      <ActorCell actor={e.switchedOff.actor} />
                      <span style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
                        “{e.switchedOff.reason}”
                      </span>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-tertiary)' }}>
                        {stamp(e.switchedOff.at)}
                      </span>
                    </span>
                  ) : (
                    <span style={{ color: 'var(--text-tertiary)' }}>—</span>
                  ),
              },
              {
                header: 'Action',
                align: 'right',
                render: (e) =>
                  e.calls === 'ungranted' ? (
                    <span style={{ color: 'var(--text-tertiary)' }}>—</span>
                  ) : (
                    <Button
                      variant={e.calls === 'on' ? 'danger' : 'secondary'}
                      size="sm"
                      onClick={() => {
                        setDialog({ vertical: e.vertical, to: e.calls === 'on' ? 'off' : 'on' });
                        setReason('');
                      }}
                    >
                      {e.calls === 'on' ? `Cut off ${e.vertical}` : `Let ${e.vertical} back in`}
                    </Button>
                  ),
              },
            ]}
          />
        ))}

      <Dialog
        open={dialog !== null}
        title={dialog ? `${dialog.to === 'off' ? 'Cut off' : 'Let back in'} ${dialog.vertical}?` : ''}
        description={
          dialog?.to === 'off'
            ? "From its next call on, this app is refused at this scope's door and every permission it held here reads as not held. Nothing it has already written is undone, and no re-provision gives the access back — only restoring it here does."
            : 'Restores exactly the access this switch took. A permission removed separately before the switch was pulled stays removed.'
        }
        danger={dialog?.to === 'off'}
        confirmLabel={dialog?.to === 'off' ? 'Cut off' : 'Let back in'}
        width={480}
        busy={busy}
        confirmDisabled={!validReason(reason)}
        onConfirm={confirmSwitch}
        onCancel={() => {
          setDialog(null);
          setReason('');
        }}
      >
        <Input
          label="Reason"
          placeholder="Why is this switch moving?"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </Dialog>
    </Card>
  );
}
