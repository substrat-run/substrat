import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { api, type AppRow, type ConnectionSweepRow, type ConnectionSweepView, type DeadLetter, type FlowFinding, type FlowFindingsView, type FlowGraph, type FlowView, type OperationHealthView } from '../lib/api';
import { card } from '../components/ui';
import { relativeTime, shortId } from '../lib/format';
import { Button } from '@substrat-run/ui';
import { navigate, obsPath, teamPath } from '../lib/router';
import { callLogsButtonTitle, deadLetterCalls } from '../lib/history';
import { DEV_MOCK } from '../lib/mock';
import { MOCK_DEAD_LETTERS, MOCK_FLOW_VIEW } from '../lib/mock-flow';
import { FLOW_COLUMNS, HEALTH_GLYPH, NODE_H, NODE_W, flowLayout, highlight, type FlowHealth, type LaidNode } from '../lib/flow-layout';
import { InvocationStrip } from './InvocationStrip';
import { InvocationLogsStrip } from './InvocationLogsStrip';

/**
 * Processes › Flow (#1234, laid out to the #1767 design): the declared app drawn as six
 * columns — triggers, modules, events, consumers, connections, outbound hosts — coloured
 * by what the scope has recorded, with a side panel of the four lists that explain the
 * colours: dead letters, operation health, connection usage and declared vs observed.
 *
 * It reads one app's scope, so it is a sub-view of the team page narrowed to one app.
 * Read-only, always: there is no drag, no save, and no input of any kind. The moment a
 * node became editable this would be flows-as-data, outside every gate the platform is
 * built on.
 */

/** Colour for each health mark. Red, amber and green only where they mean something. */
const TONE: Record<FlowHealth | 'good', string> = {
  ok: 'var(--text-tertiary)',
  good: 'var(--status-success-fg)',
  warn: 'var(--status-warning-fg)',
  fail: 'var(--status-danger-fg)',
  unused: 'var(--text-tertiary)',
  unknown: 'var(--status-warning-fg)',
};
const BAR: Record<FlowHealth, string> = {
  ok: 'var(--border-strong)',
  warn: 'var(--status-warning-fg)',
  fail: 'var(--status-danger-fg)',
  unused: 'var(--border-strong)',
  unknown: 'var(--status-warning-fg)',
};

/** An in-app anchor: a real href for middle-click, the left-click handed to the router. */
function Go({ href, children, style, title }: { href: string; children: ReactNode; style?: CSSProperties; title?: string }) {
  return (
    <a
      href={teamPath(href)}
      title={title}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(href);
      }}
      style={style}
    >
      {children}
    </a>
  );
}

const linkButton: CSSProperties = {
  border: 0,
  background: 'none',
  padding: 0,
  cursor: 'pointer',
  color: 'var(--text-tertiary)',
  textDecoration: 'underline',
  fontSize: 11.5,
  whiteSpace: 'nowrap',
};

const note = (tone: 'warn' | 'plain'): CSSProperties => ({
  margin: 0,
  padding: '7px 14px',
  borderTop: '1px solid var(--border-subtle)',
  fontSize: 11.5,
  lineHeight: '16px',
  color: tone === 'warn' ? 'var(--status-warning-fg)' : 'var(--text-tertiary)',
});

function Panel({ title, sub, children }: { title: string; sub: ReactNode; children: ReactNode }) {
  return (
    <section style={{ ...card, boxShadow: 'var(--shadow-sm)', overflow: 'hidden' }} aria-label={title}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '10px 14px' }}>
        <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>{title}</h3>
        <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>{sub}</span>
      </div>
      {children}
    </section>
  );
}

/** One side-panel row, in the design's shape: glyph, mono subject, right-hand fact, a line under it. */
function PanelRow({
  glyph,
  tone,
  main,
  href,
  mainTitle,
  right,
  sub,
  links,
  wrap = false,
  children,
}: {
  glyph: string;
  tone: keyof typeof TONE;
  main: string;
  href: string;
  mainTitle?: string;
  right: string;
  sub: ReactNode;
  links?: ReactNode;
  /** Let the line under the row wrap: for a sentence that IS the row's content. */
  wrap?: boolean;
  children?: ReactNode;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '7px 14px', borderTop: '1px solid var(--border-subtle)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
        <span aria-hidden style={{ fontSize: 11, color: TONE[tone], width: 10, textAlign: 'center', flexShrink: 0 }}>
          {glyph}
        </span>
        <Go
          href={href}
          title={mainTitle ?? main}
          style={{ flex: 1, minWidth: 0, fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
        >
          {main}
        </Go>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: TONE[tone], whiteSpace: 'nowrap' }}>{right}</span>
      </div>
      <div style={{ display: 'flex', gap: 10, paddingLeft: 18, fontSize: 11.5, color: 'var(--text-tertiary)' }}>
        <span
          style={wrap ? { flex: 1, minWidth: 0, lineHeight: '16px' } : { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          title={typeof sub === 'string' && !wrap ? sub : undefined}
        >
          {sub}
        </span>
        {links}
      </div>
      {children}
    </div>
  );
}

/**
 * The map. Clicking a node lights everything that feeds it and everything it feeds;
 * clicking it again clears. Nodes are buttons, so the picture is keyboard-reachable and
 * each one reads out its column, name and the worker's sentence about it.
 */
function FlowMap({ graph, deadLetters, app }: { graph: FlowGraph; deadLetters: readonly DeadLetter[] | null; app: AppRow }) {
  const layout = useMemo(() => flowLayout(graph, deadLetters), [graph, deadLetters]);
  const [sel, setSel] = useState<string | null>(null);
  const lit = useMemo(() => (sel ? highlight(layout.edges, sel) : null), [layout, sel]);
  const selected = sel ? layout.nodes.find((n) => n.id === sel) : undefined;

  return (
    <div style={{ ...card, boxShadow: 'var(--shadow-sm)', padding: '12px 0 16px', overflow: 'hidden', minWidth: 0, flex: '999 1 480px' }}>
      <div style={{ overflowX: 'auto' }}>
        <div style={{ position: 'relative', width: layout.width, height: layout.height, margin: '0 auto' }}>
          {layout.columns.map((c) => (
            <span
              key={c.key}
              style={{ position: 'absolute', top: 0, left: c.x, width: NODE_W, fontSize: 10.5, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-tertiary)' }}
            >
              {c.label}
            </span>
          ))}
          <svg width={layout.width} height={layout.height} aria-hidden style={{ position: 'absolute', inset: 0, overflow: 'visible' }}>
            {layout.edges.map((e) => {
              const hot = lit?.edges.has(e) ?? false;
              return (
                <path
                  key={`${e.from}->${e.to}`}
                  d={e.d}
                  fill="none"
                  stroke={hot ? 'var(--brand-400)' : 'var(--border-strong)'}
                  strokeWidth={hot ? 2 : 1.5}
                  strokeDasharray={e.dashed ? '4 3' : undefined}
                  opacity={lit && !hot ? 0.25 : 0.9}
                />
              );
            })}
          </svg>
          {layout.nodes.map((n) => (
            <MapNode key={n.id} n={n} on={sel === n.id} dim={lit !== null && !lit.nodes.has(n.id)} onPick={() => setSel((s) => (s === n.id ? null : n.id))} />
          ))}
        </div>
      </div>
      <div style={{ margin: '10px 16px 0', paddingTop: 10, borderTop: '1px solid var(--border-subtle)', fontSize: 12.5, color: 'var(--text-secondary)', display: 'grid', gap: 6 }}>
        <div aria-live="polite">
          {selected ? (
            <>
              {/* The worker's sentences mostly open with the node's name; don't say it twice. */}
              {!selected.title.startsWith(selected.label) && <><span style={{ fontFamily: 'var(--font-mono)' }}>{selected.label}</span>: </>}
              {selected.title} Highlighting what feeds it and what it
              feeds. Click again to clear.
              {selected.column === 'event' && (
                <>
                  {' '}
                  <Go href={obsPath({ app: app.app_scope_id, view: 'events', type: selected.label })}>Open in the event explorer</Go>
                </>
              )}
              {selected.column === 'connection' && (
                <>
                  {' '}
                  <Go href={`/apps/${app.app_scope_id}/settings/integrations`}>Open integrations</Go>
                </>
              )}
            </>
          ) : (
            'Click any node to highlight what feeds it and what it feeds. Health comes from the events this app has recorded, its dead letters and its connections.'
          )}
        </div>
        {graph.partialObservation && (
          <p style={{ margin: 0, fontSize: 12, color: 'var(--status-warning-fg)' }}>
            Some events could not be counted in one pass, so they carry no count &mdash; which is not the same as none.
          </p>
        )}
        {/* A truncated DECLARATION drops whole nodes, and unlike a missing count a missing
            node leaves nothing on screen to notice — so the map has to say it is partial. */}
        {!graph.declaredComplete && (
          <p style={{ margin: 0, fontSize: 12, color: 'var(--status-warning-fg)' }}>
            This app declares more than the platform carries with a version, so this is part of the map rather than all of it.
          </p>
        )}
      </div>
    </div>
  );
}

function MapNode({ n, on, dim, onPick }: { n: LaidNode; on: boolean; dim: boolean; onPick: () => void }) {
  const unused = n.health === 'unused';
  const column = FLOW_COLUMNS.find((c) => c.key === n.column)!.label;
  const side = unused ? '1px dashed var(--border-strong)' : on ? '1.5px solid var(--brand-400)' : '1px solid var(--border-default)';
  return (
    <button
      type="button"
      onClick={onPick}
      aria-pressed={on}
      aria-label={`${column}: ${n.label}${n.sublabel ? `, ${n.sublabel}` : ''}. ${n.title}`}
      title={`${n.label}${n.sublabel ? ` · ${n.sublabel}` : ''}\n${n.title}`}
      data-node={n.id}
      data-dim={dim ? '1' : undefined}
      style={{
        position: 'absolute',
        left: n.x,
        top: n.y,
        width: NODE_W,
        height: NODE_H,
        boxSizing: 'border-box',
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        padding: '0 6px 0 7px',
        borderRadius: 6,
        fontFamily: 'var(--font-mono)',
        fontSize: 10.5,
        color: 'var(--text-primary)',
        cursor: 'pointer',
        opacity: dim ? 0.35 : 1,
        background: 'var(--surface-raised)',
        // Three sides spelled out rather than a `border` shorthand: React re-applies a
        // changed shorthand over `borderLeft` on rerender, which wiped the health bar.
        borderTop: side,
        borderRight: side,
        borderBottom: side,
        borderLeft: unused ? '1px dashed var(--border-strong)' : `3px solid ${BAR[n.health]}`,
        textAlign: 'left',
      }}
    >
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.label}</span>
      <span aria-hidden style={{ flexShrink: 0, fontSize: 10, color: TONE[n.health] }}>
        {HEALTH_GLYPH[n.health]}
      </span>
    </button>
  );
}

/**
 * One delivery that gave up (#1525), with the way into the call behind it.
 *
 * A call control appears only where the row carries an id. Null is common here — a drain
 * or an alarm attempts with no call, and rows from before the columns existed have none —
 * so the absence is left unmarked rather than shown as a shut control. "Same call" is the
 * attempt that gave up; the emitting call is offered beside it only when it differs.
 */
function DeadLetterRow({ scopeId, d }: { scopeId: string; d: DeadLetter }) {
  const [open, setOpen] = useState<string | null>(null);
  const [logsOpen, setLogsOpen] = useState(false);
  const calls = deadLetterCalls(d);
  const opened = calls.find((c) => c.invocationId === open);
  // Logs are for the attempt call: it is the one that gave up. Anchored on `at`, when that
  // attempt ran, not `occurredAt` — retries can put the last attempt hours after the event,
  // outside the log window an event-anchored read would search.
  const attemptId = d.attemptInvocationId;
  return (
    <PanelRow
      glyph={HEALTH_GLYPH.fail}
      tone="fail"
      main={`${d.eventType} → ${d.consumer}`}
      href={obsPath({ app: scopeId, view: 'events', type: d.eventType })}
      mainTitle={`${d.eventType} → ${d.consumer}: open this event type in the event explorer`}
      right={d.attempts === 1 ? '1 attempt' : `${d.attempts} attempts`}
      sub={
        <span title={`${d.error} · ${d.entity.entityType} ${d.entity.entityId} · last attempt ${new Date(d.at).toLocaleString()}`}>
          {d.error} · {d.entity.entityType} <span style={{ fontFamily: 'var(--font-mono)' }}>{shortId(d.entity.entityId)}</span> · {relativeTime(d.at)}
        </span>
      }
      links={
        <>
          {calls.map((c) => (
            <button
              key={c.kind}
              type="button"
              onClick={() => setOpen((w) => (w === c.invocationId ? null : c.invocationId))}
              aria-expanded={open === c.invocationId}
              title={c.title}
              style={linkButton}
            >
              {c.kind === 'attempt' ? 'same call' : 'emitting call'}
            </button>
          ))}
          {attemptId !== null && (
            <button type="button" onClick={() => setLogsOpen((w) => !w)} aria-expanded={logsOpen} title={callLogsButtonTitle(attemptId)} style={linkButton}>
              logs for this call
            </button>
          )}
        </>
      }
    >
      {logsOpen && attemptId !== null && (
        <InvocationLogsStrip scopeId={scopeId} invocationId={attemptId} occurredAt={d.at} anchorNoun="last delivery attempt" />
      )}
      {opened && (
        <InvocationStrip
          scopeId={scopeId}
          eventId={d.eventId}
          invocationId={opened.invocationId}
          whenEmpty={
            opened.kind === 'attempt'
              ? 'This call recorded no events. That is ordinary for a retry — it ran the delivery and emitted nothing itself.'
              : 'No events recorded under this call, although this delivery names it.'
          }
        />
      )}
    </PanelRow>
  );
}

interface DeadLetterState {
  entries: DeadLetter[] | null;
  nextCursor: string | null;
  failed: boolean;
  loading: boolean;
}

/**
 * Deliveries that gave up (#1525) — "which deliveries in this app gave up?", the first
 * question in most incidents. An in-scope consumer does not retry, so every row waits for
 * a person, and a list that failed to load says so rather than reading as a clean bill.
 */
function DeadLetters({ app, state, onMore }: { app: AppRow; state: DeadLetterState; onMore: () => void }) {
  const { entries, nextCursor, failed, loading } = state;
  const n = entries?.length ?? 0;
  return (
    <Panel title="Dead letters" sub={entries === null ? (failed ? 'could not be read' : 'loading…') : `${n}${nextCursor ? '+' : ''} · gave up, newest first`}>
      {failed && (
        <p style={note('warn')}>
          {entries === null
            ? 'The delivery record could not be read, so this is not a statement that nothing gave up.'
            : 'The next page could not be read; the list above is not the whole of it.'}
        </p>
      )}
      {entries !== null && n === 0 && <p style={note('plain')}>No delivery in this app has given up.</p>}
      {entries?.map((d) => (
        <DeadLetterRow key={`${d.eventId}|${d.consumer}`} scopeId={app.app_scope_id} d={d} />
      ))}
      {nextCursor !== null && (
        <div style={{ padding: '7px 14px', borderTop: '1px solid var(--border-subtle)' }}>
          <Button variant="ghost" size="sm" onClick={onMore} disabled={loading}>
            {loading ? 'Loading…' : 'Load older'}
          </Button>
        </div>
      )}
    </Panel>
  );
}

/**
 * Per-operation health (#1234's overlay). Deliberately not a latency table: nothing in
 * the platform emits a span for an operation (#1237). What exists is what the spine wrote
 * down — the events an operation emitted, when it last emitted one, and how often it was
 * refused. The count is events, not calls: an operation that emits nothing is invisible
 * here however often it runs, and refusals are counted only over what the denial log
 * still holds, which drains rather than expires.
 */
function OperationHealth({ view, app }: { view: OperationHealthView; app: AppRow }) {
  const refusals = view.refusals;
  // The buckets are the log's own per-operation aggregate (#1456), so every count shown is
  // exact whatever `complete` says. What an incomplete window withholds is whole
  // OPERATIONS, so the caveat is about absence and no count gets a "+".
  const partial = refusals !== null && !refusals.complete;
  // Refusals have no list of their own to open, so every row opens the event explorer
  // grouped by operation — the one place the operation's recorded events can be read.
  const href = obsPath({ app: app.app_scope_id, view: 'events', groupBy: 'operation' });
  return (
    <Panel title="Operation health" sub="emitted · last seen · refusals">
      {view.rows.length === 0 && <p style={note('plain')}>No operation has recorded an event or a refusal.</p>}
      {view.rows.map((r) => {
        const refused = r.refusals !== null && r.refusals > 0;
        return (
          <PanelRow
            key={r.operation}
            glyph={refused ? HEALTH_GLYPH.warn : HEALTH_GLYPH.ok}
            tone={refused ? 'warn' : 'ok'}
            main={r.operation}
            href={href}
            mainTitle={`${r.operation}: open the event explorer grouped by operation`}
            // Null is "not counted" / "not read", which is not zero.
            right={`${r.events === null ? '—' : r.events.toLocaleString()} · ${r.refusals === null ? '—' : r.refusals} refused`}
            sub={
              r.refusedOnly
                ? 'every record is a refusal; nothing emitted'
                : r.lastSeen
                  ? `last seen ${relativeTime(r.lastSeen)}`
                  : 'no event recorded'
            }
          />
        );
      })}
      {!view.observedComplete && (
        <p style={note('warn')}>More operations have recorded events than can be counted in one pass, so this is the busiest of them.</p>
      )}
      {partial && (
        <p style={note('warn')}>
          The refusal log holds {refusals.held.toLocaleString()} entries; the {refusals.counted.toLocaleString()} counted belong to the most
          refused operations. An operation refused less often may be missing, or show 0.
        </p>
      )}
      <p style={note('plain')}>
        {/* An unread log is not an empty one. */}
        {refusals === null
          ? 'The refusal log could not be read, so no refusal count here means anything.'
          : refusals.since
            ? `Refusals counted from ${new Date(refusals.since).toLocaleDateString()}; older ones are no longer held.`
            : 'No refusals are currently held for this app.'}
      </p>
    </Panel>
  );
}

/**
 * Whether a bound connection has actually been USED (#1234's last finding). The sweep
 * log is pruned, so the absence of a run means "not in the last {windowDays} days" and
 * nothing stronger — calling that unused would send somebody to disconnect a working
 * integration. A LAPSED connection is not also reported as idle: its story is the lapse.
 */
function connectionState(r: ConnectionSweepRow, windowDays: number): { glyph: string; tone: keyof typeof TONE; right: string; sub: string } {
  const used = r.lastSweptAt
    ? `last used ${relativeTime(r.lastSweptAt)}`
    : r.unknown
      ? 'sweep record unavailable'
      : r.idle
        ? `not used in ${windowDays} days`
        : 'no run recorded';
  const sub = `${r.label} · ${used}`;
  if (r.status !== 'active') return { glyph: HEALTH_GLYPH.fail, tone: 'fail', right: r.status, sub };
  if (r.lastOutcomeFailed === true) return { glyph: HEALTH_GLYPH.fail, tone: 'fail', right: 'last run failed', sub };
  if (r.unknown) return { glyph: '—', tone: 'ok', right: 'not measured', sub };
  if (r.idle) return { glyph: HEALTH_GLYPH.unused, tone: 'unused', right: 'idle', sub };
  return { glyph: HEALTH_GLYPH.ok, tone: 'good', right: 'ok', sub };
}

function ConnectionUsage({ view, app }: { view: ConnectionSweepView; app: AppRow }) {
  const href = `/apps/${app.app_scope_id}/settings/integrations`;
  return (
    <Panel title="Connection usage" sub={`last used · state · ${view.windowDays}d kept`}>
      {view.rows.length === 0 && <p style={note('plain')}>This app holds no connections.</p>}
      {view.rows.map((r) => {
        const s = connectionState(r, view.windowDays);
        return <PanelRow key={r.connectionId} glyph={s.glyph} tone={s.tone} main={r.provider} href={href} mainTitle={`${r.provider}: open this app's integrations`} right={s.right} sub={s.sub} />;
      })}
      {view.idleCount > 0 && (
        <p style={note('plain')}>Older runs are not kept, so an idle connection is not proof one has never been used.</p>
      )}
    </Panel>
  );
}

/**
 * Declared-vs-observed findings (#1234) — the gap between what this app's modules SAY
 * they do and what its scope has actually carried. Each row carries the finding's own
 * sentence and opens the most relevant real place: the event explorer on that type, or
 * the app's integrations for a provider. There is no findings page to open yet (#1748).
 */
const FINDING: Record<FlowFinding['kind'], { label: string; health: FlowHealth }> = {
  // A path that never ran may simply not be built yet: marked like the dashed node, not
  // as a fault. One that ran and stopped is a change in behaviour, and louder.
  unemitted: { label: 'never emitted', health: 'unused' },
  unconsumed: { label: 'nothing handles it', health: 'unused' },
  stale: { label: 'stopped', health: 'warn' },
  'unconnected-provider': { label: 'not connected', health: 'warn' },
  'unhealthy-provider': { label: 'needs reconnecting', health: 'fail' },
};

function DeclaredVsObserved({ view, app }: { view: FlowFindingsView; app: AppRow }) {
  if (!view.available) {
    return (
      <Panel title="Declared vs observed" sub="not available">
        <p style={note('plain')}>
          The version this app runs was pushed before the platform carried which events each module declares. It appears after the next push.
        </p>
      </Panel>
    );
  }
  const where = (f: FlowFinding) =>
    f.kind === 'unconnected-provider' || f.kind === 'unhealthy-provider'
      ? `/apps/${app.app_scope_id}/settings/integrations`
      : obsPath({ app: app.app_scope_id, view: 'events', type: f.subject });
  return (
    <Panel
      title="Declared vs observed"
      // Both counts are qualified when their side was cut: `observedTypes` under a
      // truncated facet is the number RETURNED, not the number recorded.
      sub={`${view.declaredComplete ? '' : '≥ '}${view.declaredTypes} declared · ${view.observedComplete ? '' : '> '}${view.observedTypes} recorded`}
    >
      {view.findings.length === 0 && (
        <p style={note('plain')}>
          {view.observedComplete
            ? 'Everything this app declares has happened at least once, and every provider it uses is connected.'
            : 'Every provider this app uses is connected.'}
        </p>
      )}
      {view.findings.map((f) => {
        const k = FINDING[f.kind];
        return (
          <PanelRow
            key={`${f.kind}:${f.subject}:${f.moduleId ?? ''}`}
            glyph={HEALTH_GLYPH[k.health]}
            tone={k.health}
            main={f.subject}
            href={where(f)}
            right={k.label}
            sub={f.detail}
            wrap
          />
        );
      })}
      {!view.observedComplete && (
        <p style={note('warn')}>
          This app has recorded more event types than can be compared at once, so nothing is reported as never recorded.
        </p>
      )}
      {!view.declaredComplete && (
        <p style={note('warn')}>The declarations are a sample: the findings shown are real, and there may be others nobody checked.</p>
      )}
    </Panel>
  );
}

function Legend({ unknown }: { unknown: boolean }) {
  const item = (bar: ReactNode, label: string, color = 'var(--text-tertiary)') => (
    <span style={{ display: 'flex', alignItems: 'center', gap: 5, color }}>
      {bar}
      {label}
    </span>
  );
  const bar = (c: string) => <span style={{ width: 3, height: 12, background: c }} />;
  return (
    <span style={{ display: 'flex', flexWrap: 'wrap', gap: 12, fontSize: 12, color: 'var(--text-tertiary)' }}>
      {item(bar('var(--border-strong)'), '✓ healthy')}
      {item(bar('var(--status-warning-fg)'), '▲ degraded', 'var(--status-warning-fg)')}
      {item(bar('var(--status-danger-fg)'), '● failing', 'var(--status-danger-fg)')}
      {item(<span style={{ width: 12, height: 10, border: '1px dashed var(--border-strong)', boxSizing: 'border-box' }} />, 'declared, unused')}
      {unknown && item(bar('var(--status-warning-fg)'), '? not known', 'var(--status-warning-fg)')}
    </span>
  );
}

/**
 * The flow read, rendered as a map and as lists from ONE request. They are resolutions of
 * the same join, and fetching twice would let them disagree about what was observed. The
 * dead letters are their own paged read — a different question about different rows —
 * held here so the map can mark the consumers they name.
 */
export function Flow({ app }: { app: AppRow }) {
  const [view, setView] = useState<FlowView | null>(null);
  const [dead, setDead] = useState<DeadLetterState>({ entries: null, nextCursor: null, failed: false, loading: false });

  useEffect(() => {
    let live = true;
    setView(null);
    setDead({ entries: null, nextCursor: null, failed: false, loading: false });
    if (DEV_MOCK) {
      setView(MOCK_FLOW_VIEW);
      setDead({ entries: MOCK_DEAD_LETTERS, nextCursor: null, failed: false, loading: false });
      return;
    }
    api
      .appFlow(app.app_scope_id)
      .then((v) => live && setView(v))
      // A worker predating the route: nothing here can say anything true, so it says nothing.
      .catch(() => live && setView(null));
    api
      .appDeadLetters(app.app_scope_id)
      .then((page) => live && setDead({ entries: page.entries, nextCursor: page.nextCursor, failed: false, loading: false }))
      .catch(() => live && setDead((s) => ({ ...s, failed: true })));
    return () => {
      live = false;
    };
  }, [app.app_scope_id]);

  const more = () => {
    if (dead.nextCursor === null || dead.loading) return;
    setDead((s) => ({ ...s, loading: true }));
    api
      .appDeadLetters(app.app_scope_id, dead.nextCursor)
      .then((page) => setDead((s) => ({ entries: [...(s.entries ?? []), ...page.entries], nextCursor: page.nextCursor, failed: false, loading: false })))
      .catch(() => setDead((s) => ({ ...s, failed: true, loading: false })));
  };

  if (!view) return null;
  return (
    <div data-flow-root style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* The design's page head ("How <app> is wired") is already the page subtitle, so
          only its provenance line and the legend are drawn here. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 240, fontSize: 12.5, color: 'var(--text-tertiary)' }}>
          <span style={{ fontFamily: 'var(--font-mono)' }}>{app.vertical_slug}</span> · flow · declared by the running version, observed over the
          events this app holds
        </div>
        <Legend unknown={dead.entries === null} />
      </div>
      {/* The design's map-plus-340px-panel, as a wrapping row: the map takes nearly all the
          free space beside the panel, and below ~840px the panel drops under it full width. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-start' }}>
        {view.graph.available && view.graph.nodes.length > 0 ? (
          // Null until a page of dead letters is in hand: a consumer's health is not
          // known before then, and the map must not draw it as healthy (#1779 review).
          <FlowMap graph={view.graph} deadLetters={dead.entries} app={app} />
        ) : (
          <div style={{ ...card, padding: 16, fontSize: 12.5, color: 'var(--text-secondary)', flex: '999 1 480px' }}>
            {view.graph.available
              ? 'This app declares no schedules, modules or events, so there is nothing to draw.'
              : 'The version this app runs was pushed before the platform carried which events each module declares, so there is no map to draw. It appears after the next push.'}
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0, flex: '1 1 340px' }}>
          <DeadLetters app={app} state={dead} onMore={more} />
          <OperationHealth view={view.operations} app={app} />
          <ConnectionUsage view={view.connectionSweep} app={app} />
          <DeclaredVsObserved view={view.findings} app={app} />
        </div>
      </div>
    </div>
  );
}
