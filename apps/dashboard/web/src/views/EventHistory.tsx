import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Button } from '@substrat-run/ui';
import { api, type CauseChain, type CauseTerminal, type EffectsTree, type EffectsTerminal, type EventEffects, type HistoryEntry, type InvocationEvents } from '../lib/api';
import { actorLabel, authorizationLabel, callButtonTitle, callLogsButtonTitle, impersonationLabel, operationLabel, payloadText } from '../lib/history';
import { causeChips, deliveryStatus, eventSummary, eventTime, newestFirst, payloadRows, stateChangingIds, type CauseChip, type Tone } from '../lib/event-history';
import { shortId } from '../lib/format';
import { DEV_MOCK } from '../lib/mock';
import { mockEntityHistory, mockEventCause, mockEventEffects, mockInvocationEvents } from '../lib/mock-timeline';
import { InvocationLogsStrip } from './InvocationLogsStrip';

/**
 * A record's Event history (#1235, restyled for #1767) — opened from a row in the Data
 * tab, and the one place a reader can ask of a single event: why did it happen, what did
 * it set off, what else did the same request do, and under whose authority.
 *
 * The four answers are four reads (`cause`, `effects`, `invocation`, the history page
 * itself); the preview answers them from `mock-timeline.ts` so the card renders with no
 * backend.
 */
const reads = {
  history: (scopeId: string, entityType: string, entityId: string, cursor?: string) =>
    DEV_MOCK ? Promise.resolve(mockEntityHistory()) : api.appEntityHistory(scopeId, entityType, entityId, cursor),
  cause: (scopeId: string, eventId: string): Promise<CauseChain> =>
    DEV_MOCK ? Promise.resolve(mockEventCause(eventId)) : api.appEventCause(scopeId, eventId),
  effects: (scopeId: string, eventId: string): Promise<EffectsTree> =>
    DEV_MOCK ? Promise.resolve(mockEventEffects(eventId)) : api.appEventEffects(scopeId, eventId),
  invocation: (scopeId: string, invocationId: string): Promise<InvocationEvents> =>
    DEV_MOCK ? Promise.resolve(mockInvocationEvents(invocationId)) : api.appInvocationEvents(scopeId, invocationId),
};

/** One read's lifecycle, keyed so a late answer for a previous key is dropped. */
function useRead<T>(key: string | null, read: () => Promise<T>): { data: T | null; err: string | null } {
  const [state, setState] = useState<{ key: string | null; data: T | null; err: string | null }>({ key: null, data: null, err: null });
  useEffect(() => {
    if (key === null) return;
    let live = true;
    setState({ key, data: null, err: null });
    read()
      .then((data) => live && setState({ key, data, err: null }))
      .catch((e) => live && setState({ key, data: null, err: e instanceof Error ? e.message : String(e) }));
    return () => {
      live = false;
    };
    // `read` closes over the same inputs `key` encodes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state.key === key ? state : { data: null, err: null };
}

const TONE_FG: Record<Tone, string> = {
  success: 'var(--status-success-fg)',
  warning: 'var(--status-warning-fg)',
  danger: 'var(--status-danger-fg)',
};

const label: CSSProperties = { fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-tertiary)', paddingTop: 3 };
const quiet: CSSProperties = { fontSize: 12, color: 'var(--text-tertiary)' };
const mono: CSSProperties = { fontFamily: 'var(--font-mono)' };
const bare: CSSProperties = { background: 'none', border: 0, padding: 0, font: 'inherit', color: 'inherit', textAlign: 'inherit', cursor: 'pointer' };

function ImpersonatedIcon() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden style={{ flexShrink: 0 }}>
      <circle cx="9" cy="8" r="4" />
      <path d="M2 21v-1a6 6 0 0 1 6-6h2" />
      <path d="m16 16 2 2 4-4" />
    </svg>
  );
}

/**
 * Why one event exists (#1237) — its cause chain as chips, from whoever began it to the
 * event itself.
 *
 * The value is in how it ENDS. A chain that reached the operation which started it and
 * one that ran out of recorded trail are the same shape, so a chain that did not reach a
 * beginning opens with a cut chip and says why in words underneath — a reader must never
 * conclude a consumer began something it merely continued.
 */
function CauseChainStrip({ scopeId, eventId, held, onPick }: { scopeId: string; eventId: string; held: ReadonlySet<string>; onPick: (id: string) => void }) {
  const { data: chain, err } = useRead(`${scopeId}|${eventId}`, () => reads.cause(scopeId, eventId));
  if (err) return <div style={{ fontSize: 12, color: 'var(--status-danger-fg)' }}>{err}</div>;
  if (!chain) return <div style={quiet}>Following the trail…</div>;
  if (chain.chain.length === 0) return <div style={quiet}>No chain to show.</div>;

  // One sentence per ending that is not a beginning. `operation` needs none: its first
  // two chips name who started it and what they ran.
  const ENDING: Record<CauseTerminal, { text: string; tone: string } | null> = {
    operation: null,
    unrecorded: {
      text: 'The trail stops here. Something produced this event before the platform recorded causes, so this is where the chain was cut, not where it began.',
      tone: 'var(--status-warning-fg)',
    },
    depth: { text: 'More of the chain exists above this. It was longer than one read follows.', tone: 'var(--status-warning-fg)' },
    missing: {
      text: 'This event names a cause that is not in this app’s records. The trail cannot be followed further, and this is not the beginning.',
      tone: 'var(--status-danger-fg)',
    },
    // Not "more above this": there is nothing above a loop. The one ending that says the
    // record itself is wrong, and it must not read like a long chain.
    cycle: {
      text: 'The trail loops back on itself. That cannot happen in a sound record, so this app’s history needs looking at rather than reading further.',
      tone: 'var(--status-danger-fg)',
    },
    // #1705: nothing is wrong. The cause is an event another app of this team exported.
    imported: {
      text: `Caused by an event the ${chain.imported?.vertical ?? 'other'} app sent. The rest of the chain is in that app’s records.`,
      tone: 'var(--text-secondary)',
    },
  };
  const ending = ENDING[chain.terminal];
  const chips = causeChips(chain);

  const chipStyle = (c: CauseChip): CSSProperties => ({
    display: 'inline-flex', alignItems: 'center', height: 22, padding: '0 8px', borderRadius: 999, fontSize: 11.5, whiteSpace: 'nowrap',
    ...(c.kind === 'op'
      ? { ...mono, color: 'var(--text-link)', border: '1px solid var(--border-default)' }
      : c.kind === 'cut'
        ? { ...mono, color: 'var(--text-secondary)', border: '1px dashed var(--border-strong)' }
        : { ...(c.kind === 'event' ? mono : {}), color: 'var(--text-primary)', border: '1px solid var(--border-default)', background: 'var(--surface-card)' }),
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 4 }}>
        {chips.map((c, i) => {
          // An event of THIS record that is not the one open can be opened in place.
          const pickable = c.eventId !== undefined && c.eventId !== eventId && held.has(c.eventId);
          return (
            <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              {pickable ? (
                <button type="button" onClick={() => onPick(c.eventId!)} title={c.title ?? 'open this event'} style={{ ...bare, ...chipStyle(c) }}>
                  {c.label}
                </button>
              ) : (
                <span title={c.title} style={chipStyle(c)}>{c.label}</span>
              )}
              {i < chips.length - 1 && <span style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>→</span>}
            </span>
          );
        })}
      </span>
      {ending && <span style={{ fontSize: 12, color: ending.tone }}>{ending.text}</span>}
    </div>
  );
}

/**
 * What one event set off (#1237) — the consumers it reached and what they emitted, as a
 * tree with each delivery's standing.
 *
 * Not a timing waterfall: the platform records no span for an operation or a check. The
 * one interval drawn is how long after the event a consumer finished with it, read off
 * the delivery row's own timestamp.
 */
function EffectsTreeStrip({ scopeId, eventId }: { scopeId: string; eventId: string }) {
  const { data: tree, err } = useRead(`${scopeId}|${eventId}`, () => reads.effects(scopeId, eventId));
  if (err) return <div style={{ fontSize: 12, color: 'var(--status-danger-fg)' }}>{err}</div>;
  if (!tree) return <div style={quiet}>Following what it set off…</div>;
  if (!tree.root) return <div style={quiet}>This event is not in the app’s records.</div>;

  const ENDING: Record<EffectsTerminal, string | null> = {
    complete: null,
    depth: 'More happened below this than one read follows.',
    missing: 'Part of this trail names an event the app no longer holds.',
    cycle: 'An event appears twice in this trail. That should not be possible, so it is worth reporting rather than reading as a long chain.',
  };
  const ending = ENDING[tree.terminal];

  const lines: ReactNode[] = [];
  const line = (key: string, depth: number, branch: string, text: ReactNode, status?: ReactNode, title?: string) =>
    lines.push(
      <span key={key} title={title} style={{ display: 'flex', alignItems: 'center', gap: 6, paddingLeft: depth * 14, fontSize: 12.5 }}>
        {branch && <span style={{ ...mono, color: 'var(--text-tertiary)' }}>{branch}</span>}
        <span style={mono}>{text}</span>
        {status}
      </span>,
    );
  const walk = (n: EventEffects, depth: number, branch: string) => {
    line(n.event.id, depth, branch, n.event.type);
    const items = [...n.deliveries.map((d) => ({ d })), ...n.effects.map((c) => ({ c }))];
    if (items.length === 0) {
      // Ambiguous, and said so: the delivery table records arrivals, never their absence.
      line(`${n.event.id}:none`, depth + 1, '└', 'no delivery recorded', <span style={{ color: 'var(--text-tertiary)' }}>—</span>,
        'either nothing handles this type, or dispatch has not run yet');
      return;
    }
    items.forEach((it, i) => {
      const b = i === items.length - 1 ? '└' : '├';
      if ('d' in it) {
        const s = deliveryStatus(it.d, n.event.occurredAt);
        line(`${n.event.id}:${it.d.consumer}`, depth + 1, b, it.d.consumer,
          <span style={{ color: TONE_FG[s.tone] }}>{s.glyph} {s.text}</span>,
          it.d.error ? `${it.d.error} — last attempt ${new Date(it.d.at).toLocaleString()}` : `handled ${new Date(it.d.at).toLocaleString()}`);
      } else {
        walk(it.c, depth + 1, b);
      }
    });
  };
  walk(tree.root, 0, '');

  return (
    <span style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      {lines}
      {ending && <span style={{ fontSize: 12, color: 'var(--status-warning-fg)' }}>{ending}</span>}
    </span>
  );
}

/**
 * Everything else the request behind one event recorded (#1237) — the read the two
 * cause walks cannot make, since two events one operation raised side by side are not
 * each other's cause. A sibling that is an event of this record opens in place; one
 * about another record is named, not linked, because this card cannot show it.
 */
function SameCallStrip({
  scopeId, eventId, invocationId, held, onPick, logsOpen, onLogs,
}: {
  scopeId: string; eventId: string; invocationId: string | null; held: ReadonlySet<string>; onPick: (id: string) => void; logsOpen: boolean; onLogs: () => void;
}) {
  const { data: read, err } = useRead(invocationId === null ? null : `${scopeId}|${invocationId}`, () => reads.invocation(scopeId, invocationId!));
  // No id is a fact, not a gap: a seed or internal call carries none.
  if (invocationId === null) return <span style={quiet} title={callButtonTitle(null)}>No call recorded for this event</span>;
  if (err) return <div style={{ fontSize: 12, color: 'var(--status-danger-fg)' }}>{err}</div>;
  if (!read) return <div style={quiet}>Reading the call…</div>;

  const typeById = new Map(read.events.map((e) => [e.id, e.type]));
  const siblings = read.events.filter((e) => e.id !== eventId);
  const pill: CSSProperties = {
    display: 'inline-flex', height: 22, alignItems: 'center', padding: '0 8px', border: '1px solid var(--border-default)', borderRadius: 999,
    background: 'var(--surface-card)', ...mono, fontSize: 11.5, color: 'var(--text-primary)', whiteSpace: 'nowrap',
  };
  return (
    <span style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
        {read.events.length === 0 ? (
          <span style={{ fontSize: 12, color: 'var(--status-warning-fg)' }}>No events recorded under this call, although this event names it.</span>
        ) : siblings.length === 0 ? (
          <span style={{ ...pill, color: 'var(--text-tertiary)' }}>only event in this call</span>
        ) : (
          siblings.map((s) => {
            const reactingTo = s.causedBy ? typeById.get(s.causedBy) : undefined;
            const how = reactingTo ? `handler, reacting to ${reactingTo}` : operationLabel(s.operation);
            return held.has(s.id) ? (
              <button key={s.id} type="button" title={`${how} — ${eventTime(s.occurredAt)}`} onClick={() => onPick(s.id)} style={{ ...bare, ...pill }}>
                {s.type}
              </button>
            ) : (
              <span key={s.id} title={`${how} — ${eventTime(s.occurredAt)} · about another record`} style={{ ...pill, color: 'var(--text-secondary)' }}>
                {s.type}
              </span>
            );
          })
        )}
        <button type="button" onClick={onLogs} aria-expanded={logsOpen} title={callLogsButtonTitle(invocationId)} style={{ ...bare, fontSize: 12, color: 'var(--text-link)' }}>
          {logsOpen ? 'Hide logs' : 'Logs for this call'}
        </button>
      </span>
      {read.truncated && <span style={{ fontSize: 12, color: 'var(--status-warning-fg)' }}>This call recorded more events than one read shows.</span>}
    </span>
  );
}

/**
 * Under whose authority (K-34), and as whom (K-42). Three authorization answers that
 * must stay apart — unrecorded, checked nothing, and the permissions checked — and a
 * permission that passed through a grant names the grant, since "someone shared this
 * record" and "they hold a role" are different stories.
 */
function AllowedBy({ e }: { e: HistoryEntry }) {
  const imp = impersonationLabel(e);
  return (
    <span style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 12.5, color: 'var(--text-secondary)' }}>
      {e.authorization === null || e.authorization.length === 0 ? (
        <span style={{ color: 'var(--text-tertiary)' }}>{authorizationLabel(e.authorization)}</span>
      ) : (
        e.authorization.map((a, i) => (
          <span key={i}>
            <span style={{ ...mono, color: 'var(--text-primary)' }}>{a.permission}</span>
            {a.grant ? <> · via grant <span style={mono}>{a.grant}</span></> : ' · by role'}
          </span>
        ))
      )}
      {e.impersonation && (
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--status-warning-fg)' }} title={imp ?? undefined}>
          <ImpersonatedIcon />
          <span>
            <b style={{ fontWeight: 600 }}>Impersonated</b> · <span style={mono}>{e.impersonation.by}</span> acting as {actorLabel(e.actor)} · session{' '}
            <span style={mono} title={e.impersonation.session}>{shortId(e.impersonation.session)}</span>
          </span>
        </span>
      )}
    </span>
  );
}

/** The payload, split by key, with the previous event's value struck through where it differs. */
function Payload({ e, previous }: { e: HistoryEntry; previous?: HistoryEntry }) {
  const rows = payloadRows(e, previous);
  const anyWas = rows?.some((r) => r.was !== undefined);
  return (
    <>
      <div style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
        <span style={{ ...label, paddingTop: 0 }}>Payload</span>
        {anyWas && <span style={quiet}>struck through: what the previous event said</span>}
      </div>
      {rows === null ? (
        // Null after an erasure is a supported result, not an error, and says so.
        <div style={{ ...mono, fontSize: 12, color: e.payload == null ? 'var(--text-tertiary)' : 'var(--text-primary)', wordBreak: 'break-word' }}>
          {payloadText(e.payload)}
        </div>
      ) : rows.length === 0 ? (
        <div style={{ ...mono, fontSize: 12, color: 'var(--text-tertiary)' }}>{'{}'}</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {rows.map((r) => (
            <div key={r.key} style={{ display: 'grid', gridTemplateColumns: '140px minmax(0,1fr)', gap: 12, ...mono, fontSize: 12 }}>
              <span style={{ color: 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.key}</span>
              <span style={{ wordBreak: 'break-word' }}>
                {r.was !== undefined && (
                  <>
                    <span style={{ color: 'var(--text-tertiary)', textDecoration: 'line-through' }}>{r.was}</span>{' '}
                    <span style={{ color: 'var(--text-tertiary)' }}>→</span>{' '}
                  </>
                )}
                <span style={{ color: 'var(--text-primary)' }}>{r.value}</span>
              </span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/**
 * One record's story (#1235) — `readHistory`'s answer as the design's Event history
 * card (#1767): one row per event, newest first, and the row opens in place to the
 * investigation strips.
 *
 * The read walks `ORDER BY id ASC` a page at a time, so the pages held are always the
 * OLDEST part of the story. Shown newest first, the missing part is therefore at the
 * top, and the card says so there rather than letting the first row pass for the latest.
 *
 * The entity type is DERIVED from the model's table mapping, so an empty result is
 * shown against the key it looked under: a vertical that emits a different `entityType`
 * than its model's entity name would otherwise read as "nothing ever happened".
 */
export function EntityTimeline({
  scopeId,
  entityType,
  entityId,
  stateField,
  onClose,
}: {
  scopeId: string;
  entityType: string;
  entityId: string;
  /** The payload key the entity's lifecycle moves, when the model declares one. */
  stateField?: string;
  onClose: () => void;
}) {
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  /** The open row, and whether its call's log lines are showing. One at a time: each open row is four scope reads. */
  const [open, setOpen] = useState<{ id: string; logs: boolean } | null>(null);
  // Which walk the state below belongs to, so a page that arrives after the record
  // changed is discarded rather than appended to another record's story.
  const walk = useRef('');

  useEffect(() => {
    let live = true;
    walk.current = `${scopeId}|${entityType}|${entityId}`;
    setEntries(null);
    setCursor(null);
    setErr(null);
    setOpen(null);
    reads
      .history(scopeId, entityType, entityId)
      .then((p) => {
        if (!live) return;
        setEntries(p.entries);
        setCursor(p.nextCursor);
      })
      .catch((e) => live && setErr(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [scopeId, entityType, entityId]);

  const readMore = () => {
    if (cursor === null || reading) return;
    const at = walk.current;
    setReading(true);
    reads
      .history(scopeId, entityType, entityId, cursor)
      .then((p) => {
        if (walk.current !== at) return;
        setEntries((prev) => [...(prev ?? []), ...p.entries]);
        setCursor(p.nextCursor);
      })
      .catch((e) => walk.current === at && setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => walk.current === at && setReading(false));
  };

  const { rows, previous, transitions } = useMemo(() => {
    const asc = newestFirst(entries ?? []).reverse();
    const prev = new Map(asc.map((e, i) => [e.id, asc[i - 1]]));
    return { rows: [...asc].reverse(), previous: prev, transitions: stateChangingIds(asc, stateField) };
  }, [entries, stateField]);

  const held = useMemo(() => new Set(rows.map((r) => r.id)), [rows]);
  /** Open another event of this record in place. */
  const pick = (id: string) => setOpen({ id, logs: false });

  return (
    <div style={{ border: '1px solid var(--border-default)', borderRadius: 12, background: 'var(--surface-card)', boxShadow: 'var(--shadow-sm)', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderBottom: '1px solid var(--border-default)' }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>Event history</span>
        <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>append-only · newest first · select an event to investigate it</span>
        <div style={{ flex: 1 }} />
        <span style={{ ...mono, fontSize: 12, color: 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={`${entityType} · ${entityId}`}>
          {entityType} · {entityId}
        </span>
        <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
      </div>

      {err && <div style={{ padding: '10px 16px', fontSize: 12.5, color: 'var(--status-danger-fg)' }}>{err}</div>}
      {!err && entries === null && <div style={{ padding: '10px 16px', ...quiet, fontSize: 12.5 }}>Reading…</div>}
      {entries !== null && entries.length === 0 && (
        <div style={{ padding: '10px 16px', fontSize: 12.5, color: 'var(--text-tertiary)' }}>
          No events recorded for <code>{entityType}</code> · <code>{entityId}</code>. If this record has a history, its events
          name a different entity type than the model’s.
        </div>
      )}

      {cursor !== null && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 16px', fontSize: 12.5, color: 'var(--status-warning-fg)', background: 'var(--status-warning-bg)' }}>
          <span>Later events exist than these. The read walks oldest first, so the newest are not loaded yet.</span>
          <Button variant="secondary" size="sm" onClick={readMore} disabled={reading}>
            {reading ? 'Reading…' : 'Read later events'}
          </Button>
        </div>
      )}

      {rows.map((e) => {
        const isOpen = open?.id === e.id;
        const imp = impersonationLabel(e);
        return (
          <div key={e.id} data-event-id={e.id} style={{ borderTop: '1px solid var(--border-subtle)' }}>
            <div
              onClick={() => setOpen(isOpen ? null : { id: e.id, logs: false })}
              style={{
                display: 'grid', gridTemplateColumns: '156px 190px 150px minmax(0,1fr) 100px', gap: '0 12px', alignItems: 'center',
                height: 38, padding: '0 16px', cursor: 'pointer', background: isOpen ? 'var(--surface-active)' : 'transparent',
              }}
              onMouseEnter={(ev) => !isOpen && (ev.currentTarget.style.background = 'var(--surface-hover)')}
              onMouseLeave={(ev) => (ev.currentTarget.style.background = isOpen ? 'var(--surface-active)' : 'transparent')}
            >
              {/* The keyboard way in: the row's click target is the whole row, this is its focusable half. */}
              <button
                type="button"
                aria-expanded={isOpen}
                title={new Date(e.occurredAt).toLocaleString()}
                onClick={(ev) => {
                  ev.stopPropagation();
                  setOpen(isOpen ? null : { id: e.id, logs: false });
                }}
                style={{ ...bare, ...mono, fontSize: 12, color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}
              >
                {eventTime(e.occurredAt)}
              </button>
              <span
                title={transitions.has(e.id) ? `${e.type} — moved ${stateField}` : e.type}
                style={{
                  ...mono, fontSize: 12.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  color: transitions.has(e.id) || !stateField ? 'var(--text-primary)' : 'var(--text-secondary)',
                }}
              >
                {e.type}
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0, fontSize: 12.5, color: 'var(--text-secondary)' }} title={imp ?? actorLabel(e.actor)}>
                {e.impersonation && (
                  <span style={{ color: 'var(--status-warning-fg)', display: 'inline-flex' }} aria-label="impersonated">
                    <ImpersonatedIcon />
                  </span>
                )}
                <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{actorLabel(e.actor)}</span>
              </span>
              <span
                title={eventSummary(e)}
                style={{
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  // An operation name is an identifier, so it is set in mono; the sentences that stand in for a missing one are not.
                  ...(e.operation ? { ...mono, fontSize: 12.5, color: 'var(--text-primary)' } : { fontSize: 13, color: 'var(--text-tertiary)' }),
                }}
              >
                {eventSummary(e)}
              </span>
              {e.invocationId !== null ? (
                <button
                  type="button"
                  title={callLogsButtonTitle(e.invocationId)}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    setOpen(isOpen && open?.logs ? { id: e.id, logs: false } : { id: e.id, logs: true });
                  }}
                  style={{ ...bare, ...mono, fontSize: 12, textAlign: 'right', color: 'var(--text-link)' }}
                >
                  {shortId(e.invocationId)}
                </button>
              ) : (
                <span title={callLogsButtonTitle(null)} style={{ ...mono, fontSize: 12, textAlign: 'right', color: 'var(--text-tertiary)' }}>—</span>
              )}
            </div>

            {isOpen && (
              <div style={{ padding: '12px 16px 14px 184px', background: 'var(--surface-inset)', borderTop: '1px solid var(--border-subtle)', display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '110px minmax(0,1fr)', gap: '6px 12px', alignItems: 'start' }}>
                  <span style={label}>Why?</span>
                  <CauseChainStrip scopeId={scopeId} eventId={e.id} held={held} onPick={pick} />
                  <span style={label}>What did it do?</span>
                  <EffectsTreeStrip scopeId={scopeId} eventId={e.id} />
                  <span style={label}>Same call</span>
                  <SameCallStrip
                    scopeId={scopeId}
                    eventId={e.id}
                    invocationId={e.invocationId}
                    held={held}
                    onPick={pick}
                    logsOpen={open.logs}
                    onLogs={() => setOpen({ id: e.id, logs: !open.logs })}
                  />
                  <span style={label}>Allowed by</span>
                  <AllowedBy e={e} />
                  <span style={label}>Recorded</span>
                  <span style={{ ...mono, fontSize: 12, color: 'var(--text-secondary)', paddingTop: 2 }}>
                    <span title={e.id}>event {shortId(e.id)}</span> · {e.version ? `version ${e.version}` : 'no version recorded'} · PII {e.piiClass}
                  </span>
                  {open.logs && e.invocationId !== null && (
                    <>
                      <span style={label}>Logs</span>
                      <InvocationLogsStrip scopeId={scopeId} invocationId={e.invocationId} occurredAt={e.occurredAt} />
                    </>
                  )}
                </div>
                <Payload e={e} previous={previous.get(e.id)} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
