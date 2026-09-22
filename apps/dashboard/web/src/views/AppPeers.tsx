import { useEffect, useRef, useState } from 'react';
import { Button, Dialog, Input } from '@substrat-run/ui';
import { showPeerDisclosure } from '../lib/peer-disclosure';
import { changePeerAccess, validPeerReason } from '../lib/peer-switch';
import { api, type AppPeersView, type DeclaredCallRow, type PeerCallerRow } from '../lib/api';
import { Pill, card, type PillKind } from '../components/ui';
import { relativeTime } from '../lib/format';

/**
 * What one app reaches into the tenant's other apps, and what reaches it (#1706) — the
 * install disclosure, on the app's own page.
 *
 * Two lists, because a tenant's one question has two halves and only the second is a lever:
 * what this app DECLARES it calls (its manifest's `substrat.calls`, which is a claim), and
 * who may call INTO this app (the switch in this scope, which is a fact and is pullable).
 *
 * Hidden entirely when the app declares no calls and nothing may call in — the common case
 * by far, and a panel on every app saying "nothing" would outnumber the feature. It is NOT
 * hidden when only one half is empty: "nothing calls in here" is worth saying on an app
 * that calls out, and vice versa.
 */

const CALL_STATE: Record<DeclaredCallRow['state'], { kind: PillKind; label: string }> = {
  ambiguous: { kind: 'warning', label: 'Multiple instances' },
  allowed: { kind: 'success', label: 'Grants active' },
  // Not a fault, and deliberately neutral rather than warning: declaring a call on an app
  // the tenant does not run is the ordinary state of a freshly installed vertical.
  'not-installed': { kind: 'neutral', label: 'Not installed here' },
  'switched-off': { kind: 'danger', label: 'Switched off' },
  'no-grant': { kind: 'warning', label: 'Refused at the door' },
  unreadable: { kind: 'warning', label: 'Could not read' },
};

const CALLER_STATE: Record<PeerCallerRow['calls'], { kind: PillKind; label: string }> = {
  on: { kind: 'success', label: 'Grants active' },
  off: { kind: 'danger', label: 'Switched off' },
  ungranted: { kind: 'neutral', label: 'Holds nothing here' },
};

function callLine(row: DeclaredCallRow): string {
  switch (row.state) {
    case 'not-installed':
      return `You do not run ${row.vertical}. Nothing is wrong — this app simply has nowhere to call.`;
    case 'ambiguous':
      return `You run ${row.count} active instances of ${row.vertical}. Calls are refused; instance binding is not available yet.`;
    case 'allowed':
      return `Grants are active at ${row.vertical}. Its manifest separately decides which operations this app may invoke.`;
    case 'switched-off':
      return row.switchedOff
        ? `Cut off at ${row.vertical} by ${row.switchedOff.actor} ${relativeTime(row.switchedOff.at)} — “${row.switchedOff.reason}”`
        : `Cut off at ${row.vertical}. Let it back in from that app's page.`;
    case 'no-grant':
      return `${row.vertical} grants this app nothing, so its calls are refused. Usually the target has not declared this app as a peer.`;
    case 'unreadable':
      return `Could not read where this stands at ${row.vertical}: ${row.message}`;
  }
}

export function AppPeers({ scopeId }: { scopeId: string }) {
  const [view, setView] = useState<AppPeersView | null>(null);
  const [failed, setFailed] = useState(false);
  const [dialog, setDialog] = useState<{ vertical: string; to: 'on' | 'off' } | null>(null);
  const [reason, setReason] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const switching = useRef(false);

  async function confirmSwitch() {
    if (!dialog || switching.current || !validPeerReason(reason)) return;
    switching.current = true;
    setBusy(true);
    setNotice(null);
    try {
      const outcome = await changePeerAccess(
        () => api.switchAppPeer(scopeId, dialog.vertical, dialog.to, reason.trim()),
        async () => {
          const fresh = await api.appPeers(scopeId);
          if (fresh.callersError !== null) throw new Error(fresh.callersError);
          return fresh;
        },
      );
      if (outcome.kind === 'write-failed') {
        setNotice(`Could not confirm the change: ${String(outcome.error)}`);
        return;
      }
      setDialog(null);
      setReason('');
      if (outcome.kind === 'unconfirmed') {
        // The write succeeded. Invalidate the old position instead of offering it again.
        setView(null);
        setFailed(true);
        setNotice(`Access changed, but its status could not be refreshed: ${String(outcome.error)}. Reload to read it again.`);
        return;
      }
      setView(outcome.view);
      setNotice('Access updated.');
    } finally {
      switching.current = false;
      setBusy(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    setView(null);
    setFailed(false);
    api
      .appPeers(scopeId)
      .then((v) => {
        if (!cancelled) setView(v);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [scopeId]);

  if (failed) return <section style={card} role="status">{notice ?? 'Could not read app-to-app access. Reload to try again.'}</section>;
  if (view === null) return null;
  const callers = view.callers ?? [];
  // The whole panel is hidden only when there is genuinely nothing to say in EITHER
  // direction and no read failed. A failed mirror read is something to say.
  if (!showPeerDisclosure(view)) return null;

  return (
    <section style={card}>
      {notice && <p role="status">{notice}</p>}
      <h2 style={{ margin: '0 0 4px', fontSize: 15 }}>App-to-app access</h2>
      <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--text-secondary)', lineHeight: '19px' }}>
        Apps of this team can call each other's operations without an API key — the platform
        names the calling app, and each side declares its half. Nothing outside this team can
        use it. Grants shown here do not promise admission to every operation; the target’s manifest decides that separately.
      </p>

      {view.declares === null && (
        <p role="status">This version predates outgoing call declarations. Its targets are not restricted by
          <code> substrat.calls</code>; each target still enforces its own peer grants and operations.
          Redeploy with an explicit calls declaration to restrict outgoing targets.</p>
      )}
      {view.calls.length > 0 && (
        <>
          <h3 style={{ margin: '0 0 6px', fontSize: 13, color: 'var(--text-secondary)' }}>
            What this app calls
          </h3>
          <ul style={{ listStyle: 'none', margin: '0 0 16px', padding: 0, display: 'grid', gap: 8 }}>
            {view.calls.map((row) => (
              <li key={row.vertical} style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                <Pill kind={CALL_STATE[row.state].kind}>{CALL_STATE[row.state].label}</Pill>
                <code style={{ fontSize: 12.5 }}>{row.vertical}</code>
                <span style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: '18px' }}>
                  {callLine(row)}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      <h3 style={{ margin: '0 0 6px', fontSize: 13, color: 'var(--text-secondary)' }}>
        What may call into this app
      </h3>
      {view.callersError !== null ? (
        <p style={{ margin: 0, fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: '18px' }}>
          <Pill kind="warning">Could not read</Pill> {view.callersError}
        </p>
      ) : callers.length === 0 ? (
        <p style={{ margin: 0, fontSize: 12.5, color: 'var(--text-secondary)' }}>
          No other app of this team has a way in here.
        </p>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 }}>
          {callers.map((row) => (
            <li key={row.vertical} style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
              <Pill kind={CALLER_STATE[row.calls].kind}>{CALLER_STATE[row.calls].label}</Pill>
              <code style={{ fontSize: 12.5 }}>{row.vertical}</code>
              {row.calls !== 'ungranted' && (
                <Button size="sm" variant={row.calls === 'on' ? 'danger' : 'secondary'} disabled={busy}
                  onClick={() => {
                    setDialog({ vertical: row.vertical, to: row.calls === 'on' ? 'off' : 'on' });
                    setReason('');
                    setNotice(null);
                  }}>
                  {row.calls === 'on' ? `Cut off ${row.vertical}` : `Let ${row.vertical} back in`}
                </Button>
              )}
              {row.calls === 'off' && row.switchedOff && (
                <span style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: '18px' }}>
                  Cut off by {row.switchedOff.actor} {relativeTime(row.switchedOff.at)} — “{row.switchedOff.reason}”
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      <Dialog open={dialog !== null}
        title={dialog ? `${dialog.to === 'off' ? 'Cut off' : 'Let back in'} ${dialog.vertical}?` : ''}
        description={dialog?.to === 'off'
          ? 'Refuses future calls into this app and removes the peer’s permissions here. Existing writes remain. Only restoring access turns it back on.'
          : 'Restores the access removed by this switch. Permissions removed separately stay removed.'}
        danger={dialog?.to === 'off'} confirmLabel={dialog?.to === 'off' ? 'Cut off' : 'Let back in'}
        busy={busy} confirmDisabled={!validPeerReason(reason)} onConfirm={confirmSwitch}
        onCancel={() => { if (!switching.current) setDialog(null); }}>
        <Input label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} />
        {notice && <p role="alert">{notice}</p>}
      </Dialog>
    </section>
  );
}
