import { useMemo, useState, type CSSProperties } from 'react';
import type { EmittedLifecycle, HistoryEntry } from '../lib/api';
import { actorLabel } from '../lib/history';
import { formatDuration } from '../lib/process-layout';
import { dayTicks, instanceTimeline, type ActorKind, type Move, type Stay } from '../lib/instance-timeline';
import { navigate, obsPath } from '../lib/router';
import { shortId } from '../lib/format';
import { RequestSlideOver } from './RequestSlideOver';

/**
 * One record's lifecycle (#1916, design §5), above its event history: where its time went,
 * and what moved it.
 *
 * - **To scale**: one segment per stay, as long as the stay was. It is the only picture
 *   that shows a record spent four days snoozed and ten minutes everywhere else.
 * - **Transitions**: one column per move, all the same width — at true scale a short
 *   state vanishes, and the move out of it with it. Each names who moved it and by which
 *   operation, and opens the request that did it.
 *
 * Drawn from the history the card below already holds, so the two can never disagree
 * about what happened; when that history is incomplete, this says so.
 */

const mono: CSSProperties = { fontFamily: 'var(--font-mono)' };
const caps: CSSProperties = { fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-tertiary)' };

/** A state's tint, by its place in the declaration — stable for a model, whatever the record did. */
const TINTS = ['var(--brand-400)', 'var(--status-info-fg)', 'var(--status-warning-fg)', 'var(--status-success-fg)', 'var(--text-tertiary)', 'var(--status-danger-fg)'];

const KIND: Record<ActorKind, { icon: string; word: string }> = {
  person: { icon: '●', word: 'person' },
  consumer: { icon: '⚙', word: 'consumer' },
  connector: { icon: '⇄', word: 'connector' },
  link: { icon: '⛓', word: 'link' },
  app: { icon: '▣', word: 'another app' },
  unknown: { icon: '?', word: 'unrecorded' },
};

const when = (iso: string) => {
  const d = new Date(iso);
  return `${d.toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' })} ${d.toISOString().slice(11, 16)}`;
};

export function InstanceLifecycle({
  scopeId,
  entityType,
  lifecycle,
  entries,
  complete,
  medianMs,
}: {
  scopeId: string;
  entityType: string;
  lifecycle: EmittedLifecycle;
  entries: HistoryEntry[];
  /** False when later events exist than the ones read: the timeline then ends early. */
  complete: boolean;
  /** The lifecycle's median over the process map's period, when the opener has it. */
  medianMs?: number | null;
}) {
  const [request, setRequest] = useState<{ invocationId: string; atMs: number } | null>(null);
  const now = useMemo(() => new Date().toISOString(), [entries]);
  const t = useMemo(() => instanceTimeline(entries, lifecycle, now, actorLabel), [entries, lifecycle, now]);
  const tint = useMemo(() => {
    const order = Object.keys(lifecycle.states);
    return (s: string) => TINTS[Math.max(0, order.indexOf(s)) % TINTS.length]!;
  }, [lifecycle]);
  if (!t) return null;
  const end = t.finished ? t.stays.at(-1)!.since : now;
  const ticks = dayTicks(t.startedAt, end);
  const span = Math.max(1, Date.parse(end) - Date.parse(t.startedAt));

  return (
    <div style={{ padding: '14px 16px 16px', borderBottom: '1px solid var(--border-default)', display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={caps}>Lifecycle</span>
        <span
          style={{ ...mono, fontSize: 12, padding: '1px 8px', borderRadius: 999, border: `1px solid ${tint(t.current)}`, color: 'var(--text-primary)' }}
          title={t.finished ? 'terminal state' : 'where it is now'}
        >
          {t.current}
        </span>
        <span style={{ flex: 1 }} />
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            navigate(obsPath({ app: scopeId, view: 'map', entity: entityType, sel: `state:${t.current}` }));
          }}
          style={{ fontSize: 12.5, color: 'var(--text-link)' }}
        >
          Open in process map →
        </a>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
        <Fact label={t.finished ? 'Lifecycle' : 'So far'} value={formatDuration(t.lifecycleMs)} note={medianMs ? `median ${formatDuration(medianMs)}` : undefined} />
        <Fact label="Transitions" value={String(t.moves.length)} note={t.reopens ? `${t.reopens} reopen${t.reopens === 1 ? '' : 's'}` : undefined} />
        <Fact label="Calls" value={String(t.calls)} note="that recorded on it" />
        <Fact
          label="Moved most by"
          value={t.topActor ? (t.topActor.kind === 'person' ? shortId(t.topActor.label) : t.topActor.label) : '—'}
          title={t.topActor?.label}
          note={t.topActor ? `${KIND[t.topActor.kind].word} · ${t.topActor.moves} move${t.topActor.moves === 1 ? '' : 's'}` : undefined}
          mono
        />
      </div>

      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
          <span style={caps}>To scale</span>
          {!complete && <span style={{ fontSize: 12, color: 'var(--status-warning-fg)' }}>later events are not loaded — this ends at the last one read</span>}
        </div>
        <div style={{ position: 'relative', height: 8, borderRadius: 4, overflow: 'hidden', display: 'flex', background: 'var(--surface-inset)' }} role="img" aria-label={t.stays.map((s) => `${s.state} ${formatDuration(s.ms)}`).join(', ')}>
          {t.stays
            .filter((s) => !(s.terminal && s.until === null))
            .map((s, i) => (
              <span key={i} title={`${s.state} · ${formatDuration(s.ms)}`} style={{ width: `${(s.ms / span) * 100}%`, minWidth: s.ms > 0 ? 2 : 0, background: tint(s.state), opacity: 0.85 }} />
            ))}
        </div>
        <div style={{ position: 'relative', height: 16, marginTop: 3 }}>
          {ticks.map((k) => (
            <span key={k.at} style={{ position: 'absolute', left: `${k.share * 100}%`, transform: 'translateX(-50%)', ...mono, fontSize: 10.5, color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>
              {k.label}
            </span>
          ))}
        </div>
      </div>

      {t.moves.length > 0 && (
        <div>
          <div style={{ ...caps, marginBottom: 6 }}>Transitions</div>
          <div style={{ overflowX: 'auto', paddingBottom: 4 }}>
            <div style={{ display: 'grid', gridTemplateColumns: `repeat(${t.stays.length}, minmax(150px, 1fr))`, gap: 0, minWidth: t.stays.length * 150 }}>
              {t.stays.map((s, i) => (
                <Column key={i} stay={s} move={t.moves[i]} tint={tint(s.state)} onOpen={(m) => m.invocationId && setRequest({ invocationId: m.invocationId, atMs: Date.parse(m.at) })} />
              ))}
            </div>
          </div>
        </div>
      )}

      {request && <RequestSlideOver scopeId={scopeId} invocationId={request.invocationId} atMs={request.atMs} onClose={() => setRequest(null)} />}
    </div>
  );
}

function Fact({ label, value, note, title, mono: isMono }: { label: string; value: string; note?: string | undefined; title?: string | undefined; mono?: boolean }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 600, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', ...(isMono ? { ...mono, fontSize: 13 } : {}) }} title={title ?? value}>
        {value}
      </div>
      {note && <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', marginTop: 1 }}>{note}</div>}
    </div>
  );
}

/**
 * One stay, and the move that ended it. The last column is the stay the record is in (or
 * ended in) and has no move under it.
 */
function Column({ stay, move, tint, onOpen }: { stay: Stay; move: Move | undefined; tint: string; onOpen: (m: Move) => void }) {
  const flag = move ? (move.reopen ? { text: 'reopened', tone: 'var(--status-warning-fg)' } : !move.declared && !move.seenLate ? { text: 'not in the model', tone: 'var(--status-warning-fg)' } : null) : null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingRight: 10 }}>
      <div
        style={{
          height: 30,
          borderLeft: `3px solid ${tint}`,
          padding: '0 8px',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          borderRadius: 4,
          background: stay.terminal ? 'repeating-linear-gradient(45deg, var(--surface-inset) 0 4px, transparent 4px 8px)' : 'var(--surface-inset)',
        }}
      >
        <span style={{ fontSize: 12.5, fontWeight: 600 }}>{stay.state}</span>
        <span style={{ ...mono, fontSize: 11.5, color: 'var(--text-tertiary)' }}>{stay.terminal ? 'end' : stay.until === null ? `${formatDuration(stay.ms)} so far` : formatDuration(stay.ms)}</span>
      </div>
      {move && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, height: 14 }}>
            <span aria-hidden style={{ width: 12, height: 12, borderRadius: 999, background: 'var(--surface-card)', border: `2px solid ${tint}`, flexShrink: 0 }} />
            {flag && <span style={{ fontSize: 11.5, color: flag.tone }}>{flag.text}</span>}
          </div>
          <button
            type="button"
            onClick={() => onOpen(move)}
            disabled={!move.invocationId}
            title={move.invocationId ? 'Open the request that made this move' : 'No call was recorded for this move'}
            style={{
              all: 'unset',
              boxSizing: 'border-box',
              display: 'flex',
              flexDirection: 'column',
              gap: 3,
              padding: '8px 10px',
              borderRadius: 8,
              border: '1px solid var(--border-default)',
              background: 'var(--surface-card)',
              cursor: move.invocationId ? 'pointer' : 'default',
              flex: 1,
            }}
          >
            <span style={{ ...mono, fontSize: 11, color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>{when(move.at)}</span>
            <span style={{ ...mono, fontSize: 11.5, whiteSpace: 'nowrap' }}>
              {move.from} → {move.to}
            </span>
            <span style={{ fontSize: 11.5, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={actorLabel(move.actor)}>
              {KIND[move.actorKind].icon} {move.actorKind === 'person' ? shortId(actorLabel(move.actor)) : actorLabel(move.actor)}
            </span>
            <span style={{ ...mono, fontSize: 11.5, color: move.operation ? 'var(--text-link)' : 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={move.operation ?? undefined}>
              {move.operation ?? (move.seenLate ? 'not recorded — seen later' : 'a consumer')}
            </span>
          </button>
        </>
      )}
    </div>
  );
}
