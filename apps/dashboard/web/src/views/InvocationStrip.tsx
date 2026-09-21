import { useEffect, useState } from 'react';
import { api, type InvocationEvents } from '../lib/api';
import { operationLabel } from '../lib/history';
import { shortId } from '../lib/format';
import { MonoTag } from '../components/ui';

/**
 * Everything the call behind one event emitted (#1237), oldest first.
 *
 * The third read beside `CauseChainStrip` and `EffectsTreeStrip`, and the one they
 * cannot make: both follow cause, so two events an operation raised side by side are
 * invisible from each other. This reads by the call instead, and includes what its
 * handlers raised in the same tail — so a sibling and a consequence can both appear, and
 * the row says which is which.
 *
 * Only what the call RECORDED is here. A read, or a check that changed nothing, emits no
 * event, and the footer says so rather than letting a short list pass for a quiet call.
 *
 * Shared by the two places that hold a call id (#1525): an event in a record's history,
 * and a delivery that gave up. They differ on one thing — what an empty answer means —
 * so the caller says (`whenEmpty`) instead of this component guessing.
 */
export function InvocationStrip({
  scopeId,
  eventId,
  invocationId,
  whenEmpty = 'No events recorded under this call, although this event names it.',
}: {
  scopeId: string;
  /** The event the strip opened from, marked "this" when the call recorded it. */
  eventId: string;
  invocationId: string;
  /**
   * What to say when the call recorded nothing. The default is for an event, whose own
   * row NAMES the call, so an empty answer is the record disagreeing with itself. A
   * delivery attempt is not that: a retry in a drain can run a whole call that emitted
   * nothing, and a warning there would cry wolf.
   */
  whenEmpty?: string;
}) {
  const [read, setRead] = useState<InvocationEvents | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setRead(null);
    setErr(null);
    api
      .appInvocationEvents(scopeId, invocationId)
      .then((r) => live && setRead(r))
      .catch((e) => live && setErr(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [scopeId, invocationId]);

  if (err) return <div style={{ fontSize: 12, color: 'var(--status-danger-fg)' }}>{err}</div>;
  if (!read) return <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>Reading the call…</div>;

  // A cause inside this same call reads as a consequence; one outside it (or none) as
  // something the call did itself. Named by type, because an id means nothing here.
  const typeById = new Map(read.events.map((e) => [e.id, e.type]));

  return (
    <div style={{ display: 'grid', gap: 6, paddingLeft: 10, borderLeft: '2px solid var(--border-default)' }}>
      <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }} title={invocationId}>
        call {shortId(invocationId)}
      </div>
      {read.events.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--status-warning-fg)' }}>{whenEmpty}</div>
      ) : (
        read.events.map((e) => {
          const reactingTo = e.causedBy ? typeById.get(e.causedBy) : undefined;
          return (
            <div key={e.id} style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap', fontSize: 12 }}>
              <span style={{ color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)', minWidth: 28 }}>
                {e.id === eventId ? 'this' : ''}
              </span>
              <MonoTag>{e.type}</MonoTag>
              <span style={{ color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)', fontSize: 11.5 }}>
                {new Date(e.occurredAt).toLocaleString()}
              </span>
              <span style={{ color: 'var(--text-secondary)', fontSize: 11.5, fontFamily: 'var(--font-mono)' }}>
                {reactingTo ? `handler, reacting to ${reactingTo}` : operationLabel(e.operation)}
              </span>
            </div>
          );
        })
      )}
      {read.truncated && (
        <div style={{ fontSize: 12, color: 'var(--status-warning-fg)' }}>
          This call recorded more events than one read shows.
        </div>
      )}
      <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>
        What the call recorded, in order. Reads and checks that changed nothing leave no event, so they are not
        listed here.
      </div>
    </div>
  );
}
