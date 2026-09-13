import { useEffect, useState } from 'react';
import { api, type AppRow, type FlowFindingsView, type FlowFinding, type FlowGraph, type FlowNode, type FlowView, type OperationHealthView } from '../lib/api';
import { card } from '../components/ui';
import { navigate, obsPath, teamPath } from '../lib/router';

/**
 * The flow map and its declared-vs-observed findings (#1234), moved off the app page
 * with the rest of the Observability tab (#1447). It reads one app's scope, so it is a
 * sub-view of the team page narrowed to one app rather than a team-level panel of its own.
 */

/**
 * The flow map (#1234): the declared app drawn as a layered graph, coloured by what
 * the scope has recorded.
 *
 * Drawn here rather than inside `@substrat-run/model-view` because its colour comes
 * from live per-scope facts, and because a no-script `srcdoc` iframe — the right shape
 * for the ER diagram, which is one self-contained artifact — could never link a node to
 * its exemplars the way #1231 asks every aggregate in this cluster to.
 *
 * Read-only, always. There is no drag, no save, and no input of any kind: the moment a
 * node became editable this would be flows-as-data, outside every gate the platform is
 * built on.
 */
function FlowMap({ graph, app }: { graph: FlowGraph; app: AppRow }) {
  if (!graph.available || graph.nodes.length === 0) return null;

  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  /** Where an event node goes: the Events sub-view, already grouped on that type. */
  const eventPath = (type: string) => obsPath({ app: app.app_scope_id, view: 'events', type });
  const STROKE: Record<FlowNode['status'], string> = {
    ok: 'var(--border-default)',
    warn: 'var(--status-warning-fg)',
    danger: 'var(--status-danger-fg)',
  };
  const FILL: Record<FlowNode['kind'], string> = {
    trigger: 'var(--surface-inset)',
    module: 'var(--surface-card)',
    event: 'var(--surface-card)',
    connection: 'var(--surface-inset)',
    egress: 'var(--surface-inset)',
  };

  return (
    <div style={{ ...card, padding: 14, display: 'grid', gap: 10 }}>
      <div>
        <h3 style={{ margin: 0, fontSize: 15 }}>Flow map</h3>
        <p style={{ margin: '4px 0 0', fontSize: 12.5, color: 'var(--text-tertiary)' }}>
          What this app declares, top to bottom: what starts work, the modules that do it, the events
          they carry, and what they are permitted to reach. Event counts are what this app has actually
          recorded.
        </p>
      </div>

      {graph.partialObservation && (
        <p style={{ margin: 0, fontSize: 12.5, color: 'var(--status-warning-fg)' }}>
          Some events could not be counted in one pass, so they are marked &ldquo;not counted&rdquo;
          &mdash; which is not the same as none.
        </p>
      )}

      {/* A truncated DECLARATION drops whole nodes, and unlike a missing count a missing
          node leaves nothing on screen to notice — so the heading's "what this app
          declares" has to be qualified rather than quietly narrowed. */}
      {!graph.declaredComplete && (
        <p style={{ margin: 0, fontSize: 12.5, color: 'var(--status-warning-fg)' }}>
          This app declares more than the platform carries with a version, so this is part of the map
          rather than all of it &mdash; there may be modules and event types that are not drawn here.
        </p>
      )}

      <div style={{ overflowX: 'auto' }}>
        <svg
          viewBox={`0 0 ${graph.width} ${graph.height}`}
          width={graph.width}
          height={graph.height}
          role="img"
          aria-label="Flow map of this app's declared triggers, modules, events and connections"
          style={{ maxWidth: '100%', height: 'auto' }}
        >
          <defs>
            <marker id="flow-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 8 4 L 0 8 z" fill="var(--text-tertiary)" />
            </marker>
          </defs>
          {graph.edges.map((e) => {
            const from = byId.get(e.from);
            const to = byId.get(e.to);
            if (!from || !to) return null;
            const x1 = from.x + from.w / 2;
            const x2 = to.x + to.w / 2;
            // Leave from whichever side actually faces the target, so a consume edge
            // pointing back up a band reads as going up rather than through its own box.
            const down = to.y > from.y;
            const y1 = down ? from.y + from.h : from.y;
            const y2 = down ? to.y : to.y + to.h;
            const mid = (y1 + y2) / 2;
            return (
              <path
                key={`${e.from}->${e.to}:${e.kind}`}
                d={`M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`}
                fill="none"
                stroke="var(--text-tertiary)"
                strokeWidth={1}
                strokeOpacity={0.55}
                strokeDasharray={e.kind === 'consumes' ? '4 3' : undefined}
                markerEnd="url(#flow-arrow)"
              >
                <title>{e.title}</title>
              </path>
            );
          })}
          {graph.nodes.map((n) => {
            // An event node LINKS to its exemplars — #1231's rule for every aggregate in
            // this cluster, and half the reason this graph lives in the dashboard instead
            // of a no-script model-view page. A real SVG anchor rather than an onClick
            // handler: it is keyboard-reachable, it middle-clicks into a new tab, and it
            // reads as a link to a screen reader. The left-click is intercepted so the
            // client router handles it, exactly as `lib/router` prescribes for anchors.
            const href = n.kind === 'event' ? eventPath(n.label) : null;
            const Wrapper = ({ children }: { children: React.ReactNode }) =>
              href === null ? (
                <g>{children}</g>
              ) : (
                <a
                  href={teamPath(href)}
                  onClick={(e) => {
                    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                    e.preventDefault();
                    navigate(href);
                  }}
                  style={{ cursor: 'pointer' }}
                >
                  {children}
                </a>
              );
            return (
            <Wrapper key={n.id}>
              <title>
                {n.title}
                {href === null ? '' : ' Opens this type in the event explorer.'}
              </title>
              <rect
                x={n.x}
                y={n.y}
                width={n.w}
                height={n.h}
                rx={8}
                fill={FILL[n.kind]}
                strokeWidth={n.status === 'ok' && !n.stale ? 1 : 1.5}
                // Two different silences, drawn differently. A DASHED outline is a path
                // nothing has ever taken; a solid warning outline is one that carried
                // traffic and stopped. Merging them would hide the second inside the
                // first, and the second is the one that means something changed.
                stroke={n.stale ? 'var(--status-warning-fg)' : STROKE[n.status]}
                strokeDasharray={n.silent ? '5 3' : undefined}
              />
              <text
                x={n.x + n.w / 2}
                y={n.y + 19}
                textAnchor="middle"
                fontSize={11.5}
                fontFamily="var(--font-mono)"
                fill="var(--text-primary)"
              >
                {n.label.length > 28 ? `${n.label.slice(0, 27)}…` : n.label}
              </text>
              {n.sublabel && (
                <text
                  x={n.x + n.w / 2}
                  y={n.y + 34}
                  textAnchor="middle"
                  fontSize={10.5}
                  fill={n.silent || n.stale ? 'var(--status-warning-fg)' : 'var(--text-tertiary)'}
                >
                  {n.sublabel}
                </text>
              )}
            </Wrapper>
            );
          })}
        </svg>
      </div>

      {/*
        The picture's content, as text.

        `role="img"` collapses the whole SVG to its single `aria-label`, so every node
        label, count, silence marker, schedule and connection status inside it is
        unreachable — a screen-reader user got the heading of a diagram and nothing in it.
        This list is the same facts in reading order, and it carries the event links too,
        so the deep link is not a mouse-only affordance. Visually hidden rather than
        conditionally rendered: it must stay in the accessibility tree.
      */}
      <ul
        style={{
          position: 'absolute',
          width: 1,
          height: 1,
          margin: -1,
          padding: 0,
          overflow: 'hidden',
          clip: 'rect(0 0 0 0)',
          clipPath: 'inset(50%)',
          whiteSpace: 'nowrap',
          border: 0,
        }}
      >
        {graph.nodes.map((n) => {
          const href = n.kind === 'event' ? eventPath(n.label) : null;
          const reaches = graph.edges.filter((e) => e.from === n.id).map((e) => byId.get(e.to)?.label ?? e.to);
          const text = `${n.kind}: ${n.label}${n.sublabel ? `, ${n.sublabel}` : ''}${
            n.silent ? ', never recorded' : ''
          }${reaches.length > 0 ? `. Reaches ${reaches.join(', ')}` : '. Reaches nothing declared'}.`;
          return (
            <li key={`sr:${n.id}`}>
              {href === null ? (
                text
              ) : (
                <a
                  href={teamPath(href)}
                  onClick={(e) => {
                    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                    e.preventDefault();
                    navigate(href);
                  }}
                >
                  {text} Open in the event explorer.
                </a>
              )}
            </li>
          );
        })}
      </ul>

      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 11.5, color: 'var(--text-tertiary)' }}>
        <span>solid arrow &mdash; emits</span>
        <span>dashed arrow &mdash; handles</span>
        <span>dashed outline &mdash; declared, nothing recorded</span>
        <span>amber outline &mdash; recorded, but not in the last 30 days</span>
      </div>
    </div>
  );
}

/**
 * Per-operation health (#1234's overlay).
 *
 * Deliberately NOT a latency table. Nothing in the platform emits a span for an
 * operation — what reaches the trace dataset is the runtime's own outbound `fetch`
 * and DO-entry spans — so per-operation timing does not exist to render (#1237). What
 * does exist is what the spine wrote down: the events an operation emitted, when it
 * last emitted one, and how often it was refused.
 *
 * Two limits the copy states rather than lets a reader assume: an operation that emits
 * nothing is invisible to the event side however often it runs, and refusals are
 * counted only over what the denial log still holds, which drains rather than expires.
 */
function OperationHealth({ view }: { view: OperationHealthView }) {
  if (view.rows.length === 0) return null;
  const refusals = view.refusals;
  const since = refusals?.since ? new Date(refusals.since).toLocaleDateString() : null;
  // A count from a capped page is a floor: the page held the newest rows, and this
  // operation's older refusals may lie beyond it.
  const atLeast = refusals !== null && !refusals.complete;

  return (
    <div style={{ ...card, padding: 14, display: 'grid', gap: 10 }}>
      <div>
        <h3 style={{ margin: 0, fontSize: 15 }}>Operations</h3>
        <p style={{ margin: '4px 0 0', fontSize: 12.5, color: 'var(--text-tertiary)' }}>
          What each operation has recorded. The count is events, not calls: an operation that raises
          no events shows nothing here however often it runs, and appears only if it has been refused.
        </p>
      </div>

      {!view.observedComplete && (
        <p style={{ margin: 0, fontSize: 12.5, color: 'var(--status-warning-fg)' }}>
          More operations have recorded events than can be counted in one pass, so this is the
          busiest of them rather than all of them.
        </p>
      )}

      {atLeast && (
        <p style={{ margin: 0, fontSize: 12.5, color: 'var(--status-warning-fg)' }}>
          The refusal log holds {refusals.held.toLocaleString()} entries and only the newest{' '}
          {refusals.counted.toLocaleString()} are counted here, so a refusal count is a floor and an
          operation refused only earlier may be missing.
        </p>
      )}

      <div style={{ display: 'grid', gap: 4 }}>
        {view.rows.map((r) => (
          <div
            key={r.operation}
            style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap', fontSize: 12.5 }}
          >
            <span style={{ fontFamily: 'var(--font-mono)', flex: '1 1 220px', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {r.operation}
            </span>
            <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-tertiary)', minWidth: 96, textAlign: 'right' }}>
              {/* Null is "not counted", which is not zero. */}
              {r.events === null ? 'not counted' : `${r.events.toLocaleString()} events`}
            </span>
            <span style={{ color: 'var(--text-tertiary)', minWidth: 110, textAlign: 'right', fontSize: 11.5 }}>
              {r.lastSeen ? new Date(r.lastSeen).toLocaleDateString() : '—'}
            </span>
            {r.refusals !== null && r.refusals > 0 && (
              <span
                style={{
                  fontSize: 11,
                  padding: '2px 6px',
                  borderRadius: 4,
                  background: 'var(--status-warning-bg)',
                  color: 'var(--status-warning-fg)',
                }}
                title={
                  r.refusedOnly
                    ? 'every record of this operation is a refusal — it has emitted nothing'
                    : 'permission refusals recorded for this operation'
                }
              >
                {atLeast ? `${r.refusals}+` : r.refusals} refused{r.refusedOnly ? ', nothing emitted' : ''}
              </span>
            )}
          </div>
        ))}
      </div>

      <p style={{ margin: 0, fontSize: 11.5, color: 'var(--text-tertiary)' }}>
        {/* An unread log is not an empty one: no badges here mean nothing about refusals. */}
        {refusals === null
          ? 'The refusal log could not be read, so no operation here carries a refusal count.'
          : since
            ? `Refusals counted from ${since}. Older ones are no longer held, so no badge does not mean an operation has never been refused.`
            : 'No refusals are currently held for this app.'}
      </p>
    </div>
  );
}

/**
 * The flow read, rendered as both a map and a list from ONE request. They are two
 * resolutions of the same join, and fetching twice would let them disagree about what
 * was observed — the map showing a count for a type the list called silent.
 */
export function Flow({ app }: { app: AppRow }) {
  const [view, setView] = useState<FlowView | null>(null);

  useEffect(() => {
    let live = true;
    setView(null);
    api
      .appFlow(app.app_scope_id)
      .then((v) => live && setView(v))
      // A worker predating the route: nothing here can say anything true, so it says nothing.
      .catch(() => live && setView(null));
    return () => {
      live = false;
    };
  }, [app.app_scope_id]);

  if (!view) return null;
  return (
    <>
      <FlowMap graph={view.graph} app={app} />
      <OperationHealth view={view.operations} />
      <FlowFindings view={view.findings} />
    </>
  );
}

/**
 * Declared-vs-observed findings (#1234) — the gap between what this app's modules
 * SAY they do and what its scope has actually carried.
 *
 * The claim every finding makes is about declarations against a bounded window of
 * observation, and the copy says so. Two states are deliberately not silence:
 * a version pushed before the declared-event surface existed says it cannot answer
 * (rather than reporting the app as emitting nothing), and a truncated observation
 * withholds the event findings (rather than calling a type dead because its bucket
 * fell off the tail).
 */
function FlowFindings({ view }: { view: FlowFindingsView }) {
  if (!view.available) {
    return (
      <div style={{ ...card, padding: 14, display: 'grid', gap: 6 }}>
        <h3 style={{ margin: 0, fontSize: 15 }}>Declared vs. observed</h3>
        <p style={{ margin: 0, fontSize: 12.5, color: 'var(--text-tertiary)' }}>
          Not available for the version this app runs &mdash; it was pushed before the platform
          carried which events each module declares. It appears after the next push.
        </p>
      </div>
    );
  }

  const TONE: Record<FlowFinding['kind'], { label: string; fg: string; bg: string }> = {
    unemitted: { label: 'never emitted', fg: 'var(--text-secondary)', bg: 'var(--surface-inset)' },
    unconsumed: { label: 'nothing to handle', fg: 'var(--text-secondary)', bg: 'var(--surface-inset)' },
    // Louder than the two above on purpose: a path that never ran may simply not be
    // built yet, while one that ran and stopped is a change in behaviour.
    stale: { label: 'stopped', fg: 'var(--status-warning-fg)', bg: 'var(--status-warning-bg)' },
    'unconnected-provider': { label: 'not connected', fg: 'var(--status-warning-fg)', bg: 'var(--status-warning-bg)' },
    'unhealthy-provider': { label: 'needs reconnecting', fg: 'var(--status-danger-fg)', bg: 'var(--status-danger-bg)' },
  };

  return (
    <div style={{ ...card, padding: 14, display: 'grid', gap: 10 }}>
      <div>
        <h3 style={{ margin: 0, fontSize: 15 }}>Declared vs. observed</h3>
        <p style={{ margin: '4px 0 0', fontSize: 12.5, color: 'var(--text-tertiary)' }}>
          {/* Both counts are qualified when their side was cut, because each number is a
              claim about what was looked at. `observedTypes` under a truncated facet is
              the number RETURNED, not the number recorded — printing it as a total would
              contradict the warning directly below it. */}
          This app declares {view.declaredComplete ? '' : 'at least '}
          {view.declaredTypes} event {view.declaredTypes === 1 ? 'type' : 'types'} and has recorded{' '}
          {view.observedComplete ? view.observedTypes : `more than ${view.observedTypes}`}. Everything below is
          a gap between the two &mdash; a statement about what was declared, not a fault.
        </p>
      </div>

      {!view.observedComplete && (
        <p style={{ margin: 0, fontSize: 12.5, color: 'var(--status-warning-fg)' }}>
          This app has recorded more event types than can be compared at once, so nothing is reported as
          never recorded &mdash; a type missing from a shortened list is not evidence that it never
          happened. Events that were counted are still judged on how recently they ran.
        </p>
      )}

      {!view.declaredComplete && (
        <p style={{ margin: 0, fontSize: 12.5, color: 'var(--status-warning-fg)' }}>
          This app declares more event types than the platform carries with a version, so the declarations
          below are a sample. The findings shown are real; there may be others nobody checked.
        </p>
      )}

      {view.findings.length === 0 ? (
        <p style={{ margin: 0, fontSize: 12.5, color: 'var(--text-secondary)' }}>
          {view.observedComplete
            ? 'Everything this app declares has happened at least once, and every provider it uses is connected.'
            : 'Every provider this app uses is connected.'}
        </p>
      ) : (
        <div style={{ display: 'grid', gap: 8 }}>
          {view.findings.map((f) => (
            <div key={`${f.kind}:${f.subject}:${f.moduleId ?? ''}`} style={{ display: 'grid', gap: 3 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5 }}>{f.subject}</span>
                <span
                  style={{
                    fontSize: 11,
                    padding: '2px 6px',
                    borderRadius: 4,
                    background: TONE[f.kind].bg,
                    color: TONE[f.kind].fg,
                  }}
                >
                  {TONE[f.kind].label}
                </span>
              </div>
              <p style={{ margin: 0, fontSize: 12.5, color: 'var(--text-tertiary)' }}>{f.detail}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
