import { useEffect, useRef, useState } from 'react';
import {
  EDGE_STATE,
  LEVER_EFFECT,
  lagText,
  leverOffered,
  leverRequest,
  type EdgeHealth,
  type EdgeHealthReport,
  type LeverMode,
} from '@substrat-run/contracts';
import { Button, Dialog, Input } from '@substrat-run/ui';
import { api } from '../lib/api';
import { validPeerReason } from '../lib/peer-switch';
import { Pill, card } from '../components/ui';
import { relativeTime } from '../lib/format';

/**
 * Events this app exchanges with the team's other apps (#1705 PR 3): each edge into it (it
 * imports) and out of it (another app imports what it exports), read live.
 *
 * Hidden when the app has no edge at all, the common case. It is NOT hidden when the read fails:
 * "no edges" and "could not be read" are different answers, and only one of them is safe to
 * leave unsaid. An `unavailable` edge is red, never green (`EDGE_STATE`).
 *
 * The lever sits on edges INTO this app, because the watermark is this app's. Replay runs the
 * handlers again, and the dialog says so in the words the platform refuses in, behind a box the
 * person has to tick.
 */
export function AppEdges({ scopeId }: { scopeId: string }) {
  const [view, setView] = useState<EdgeHealthReport | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ edge: EdgeHealth; kind: LeverMode } | null>(null);
  const [reason, setReason] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const moving = useRef(false);

  /** Read the edges. `live` says whether the answer is still wanted when it lands. */
  const load = async (live: () => boolean = () => true): Promise<void> => {
    try {
      const v = await api.appEdges(scopeId);
      if (live()) {
        setView(v);
        setFailed(null);
      }
    } catch (e) {
      if (live()) {
        setView(null);
        setFailed(e instanceof Error ? e.message : String(e));
      }
    }
  };
  const openLever = (edge: EdgeHealth, kind: LeverMode) => {
    setDialog({ edge, kind });
    setReason('');
    setAgreed(false);
    setNotice(null);
  };

  useEffect(() => {
    let cancelled = false;
    setView(null);
    setFailed(null);
    void load(() => !cancelled);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeId]);

  async function confirmMove() {
    if (!dialog || moving.current || !agreed || !validPeerReason(reason)) return;
    moving.current = true;
    setBusy(true);
    setNotice(null);
    try {
      const moved = await api.moveAppEdge(scopeId, leverRequest(dialog.kind, dialog.edge.producer.vertical, reason));
      setDialog(null);
      setReason('');
      setAgreed(false);
      setNotice(
        moved.mode === 'replay'
          ? `Replay set. The next pass delivers again from the start (${moved.archived.journal} earlier deliveries kept as history).`
          : 'Skipped. Events up to now will not be delivered; later ones will.',
      );
      await load();
    } catch (e) {
      setNotice(`Nothing was moved: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      moving.current = false;
      setBusy(false);
    }
  }

  if (failed !== null) {
    return (
      <section style={card} role="status">
        <h2 style={{ margin: '0 0 4px', fontSize: 15 }}>Cross-app events</h2>
        <Pill kind="danger">Unavailable</Pill>{' '}
        <span style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
          Could not read where this app's event edges stand: {failed}
        </span>
      </section>
    );
  }
  if (view === null) return null;
  if (view.edges.length === 0 && view.unavailable === null) return null;

  return (
    <section style={card}>
      {notice && <p role="status">{notice}</p>}
      <h2 style={{ margin: '0 0 4px', fontSize: 15 }}>Cross-app events</h2>
      <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--text-secondary)', lineHeight: '19px' }}>
        Events this app takes from the team's other apps, and gives to them. Checked {relativeTime(view.checkedAt)}.
      </p>
      {view.unavailable !== null && (
        <p style={{ margin: '0 0 10px', fontSize: 12.5 }}>
          <Pill kind="danger">Unavailable</Pill> {view.unavailable}
        </p>
      )}
      {!view.history.available && (
        <p style={{ margin: '0 0 10px', fontSize: 12.5, color: 'var(--text-secondary)' }}>
          <Pill kind="warning">No history</Pill> {view.history.reason}
        </p>
      )}
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 10 }}>
        {view.edges.map((edge) => {
          const into = edge.consumer.scopeId === scopeId;
          const badge = EDGE_STATE[edge.state];
          const lag = lagText(edge.lagMs);
          return (
            <li key={`${edge.consumer.scopeId}:${edge.producer.vertical}`} style={{ display: 'grid', gap: 4 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                <Pill kind={badge.tone}>{badge.label}</Pill>
                <span style={{ fontSize: 12.5 }}>
                  {into ? (
                    <>
                      from <code>{edge.producer.vertical}</code>
                    </>
                  ) : (
                    <>
                      to <code>{edge.consumer.vertical}</code>
                    </>
                  )}
                </span>
                {lag && <span style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>oldest waiting {lag}</span>}
                {leverOffered(edge, scopeId) && (
                  <>
                    <Button size="sm" variant="secondary" disabled={busy} onClick={() => openLever(edge, 'replay')}>
                      Replay from the start
                    </Button>
                    <Button size="sm" variant="secondary" disabled={busy} onClick={() => openLever(edge, 'skip')}>
                      Skip to now
                    </Button>
                  </>
                )}
              </div>
              {edge.reason && (
                <span style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: '18px' }}>{edge.reason}</span>
              )}
              <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                {edge.lastDelivered ? `Last delivered ${relativeTime(edge.lastDelivered.at)}.` : 'No delivery recorded.'}
                {edge.lastProblem && ` Last problem ${relativeTime(edge.lastProblem.at)}: ${edge.lastProblem.error ?? edge.lastProblem.outcome}.`}
              </span>
            </li>
          );
        })}
      </ul>
      <Dialog open={dialog !== null}
        title={dialog ? `${dialog.kind === 'replay' ? 'Replay' : 'Skip'} events from ${dialog.edge.producer.vertical}?` : ''}
        description={dialog
          ? dialog.kind === 'replay'
            ? `Every event this app has taken from ${dialog.edge.producer.vertical} is delivered again: ${LEVER_EFFECT.replay}. Earlier deliveries are kept as history.`
            : `Everything ${dialog.edge.producer.vertical} has sent up to now is passed over: ${LEVER_EFFECT.skip}.`
          : ''}
        danger confirmLabel={dialog?.kind === 'replay' ? 'Replay' : 'Skip'}
        busy={busy} confirmDisabled={!agreed || !validPeerReason(reason)} onConfirm={confirmMove}
        onCancel={() => { if (!moving.current) setDialog(null); }}>
        <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13, margin: '0 0 10px' }}>
          <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
          <span>I understand: {dialog ? LEVER_EFFECT[dialog.kind] : ''}.</span>
        </label>
        <Input label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} />
        {notice && <p role="alert">{notice}</p>}
      </Dialog>
    </section>
  );
}
