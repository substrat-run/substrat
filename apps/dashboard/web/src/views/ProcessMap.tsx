import { useEffect, useMemo, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { Button, Select, Tabs } from '@substrat-run/ui';
import { api, type AppRow, type LifecycleFlowResult, type ProcessMapView, type ProcessPeriod } from '../lib/api';
import { card } from '../components/ui';
import { DEV_MOCK } from '../lib/mock';
import { mockProcessView } from '../lib/mock-processes';
import { NODE_H, NODE_W, formatDuration, funnelRows, pairId, processLayout, refusalStubs, stubId, stubPillWidth, type LaidPair, type LaidState, type LaidStub, type ProcessLayout } from '../lib/process-layout';
import { navigate, obsPath } from '../lib/router';
import { shortId } from '../lib/format';
import { EntityTimeline } from './EventHistory';

/**
 * The process map (#1744) — the design's signature screen: an entity's declared lifecycle
 * drawn as a state machine, with what the replay counted on top of it.
 *
 * Every number on it comes from `readLifecycleFlow` over this app's outbox, for the period
 * asked and the one before it. What the screen will not do is draw a number it does not
 * have: an edge nobody took is dashed only when the replay was complete, a state with no
 * finished stay says "—" rather than 0, and moves the replay could only infer or only saw
 * late are said so in the footer and the side panel.
 */

const PERIODS: { value: ProcessPeriod; label: string }[] = [
  { value: '24h', label: '24h' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
];

export type ProcessSelection = { kind: 'pair'; id: string } | { kind: 'state'; state: string } | { kind: 'refused'; id: string };

export function parseSelection(sel: string | undefined): ProcessSelection | null {
  if (!sel) return null;
  if (sel.startsWith('edge:')) return { kind: 'pair', id: sel.slice(5) };
  if (sel.startsWith('state:')) return { kind: 'state', state: sel.slice(6) };
  if (sel.startsWith('refused:')) return { kind: 'refused', id: sel.slice(8) };
  return null;
}
const selectionParam = (s: ProcessSelection) =>
  s.kind === 'pair' ? `edge:${s.id}` : s.kind === 'state' ? `state:${s.state}` : `refused:${s.id}`;

const ACTOR_LABEL: Record<string, string> = {
  principal: 'person',
  system: 'consumer',
  connection: 'connector',
  capability: 'link',
  vertical: 'another app',
  unknown: 'unrecorded',
};

const humanize = (s: string) => s.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_]/g, ' ').replace(/^./, (c) => c.toUpperCase());
const num = (n: number) => n.toLocaleString('en-US');
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const mono: CSSProperties = { fontFamily: 'var(--font-mono)' };

function change(now: number, before: number | undefined): string | null {
  if (before === undefined || before === 0) return null;
  const d = (now - before) / before;
  if (Math.abs(d) < 0.005) return '±0%';
  return `${d > 0 ? '+' : '−'}${Math.round(Math.abs(d) * 100)}%`;
}

export interface ProcessMapProps {
  app: AppRow;
  entity?: string;
  period: ProcessPeriod;
  sel?: string;
  compare: boolean;
  nonce: number;
  onChange: (next: { entity?: string; period?: ProcessPeriod; sel?: string | undefined; compare?: boolean }) => void;
}

export function ProcessMap({ app, entity, period, sel, compare, nonce, onChange }: ProcessMapProps) {
  const [view, setView] = useState<ProcessMapView | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [history, setHistory] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setView(null);
    setFailed(null);
    if (DEV_MOCK) {
      setView(mockProcessView(period));
      return;
    }
    api
      .appProcesses(app.app_scope_id, { period, ...(entity ? { entity } : {}) })
      .then((v) => live && setView(v))
      .catch((e: unknown) => live && setFailed(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [app.app_scope_id, entity, period, nonce]);

  const layout = useMemo(
    () => (view?.lifecycle ? processLayout(view.lifecycle, view.current) : null),
    [view],
  );

  if (failed) return <Note tone="danger">The process map could not be read: {failed}</Note>;
  if (!view) return <Note>Replaying this app's lifecycles…</Note>;
  if (view.unavailable === 'no-version') return <Note>Nothing is running in this app yet, so there is no model to draw a process from.</Note>;
  if (view.unavailable === 'no-lifecycles')
    return (
      <Note>
        The version this app runs declares no lifecycle. A process map draws an entity's declared states and the operations
        that move it between them — declare one with <code style={mono}>defineLifecycle</code> in the model, and it appears here after the next push.
      </Note>
    );
  const current = view.current;
  if (view.unavailable === 'not-yet-available' || !current || !layout || !view.entity)
    return (
      <Note>
        This app's deployed code predates the process map's read, so its lifecycle cannot be replayed yet. It appears after the
        app is pushed again.
      </Note>
    );

  const previous = compare ? view.previous : null;
  const busiest = [...layout.pairs].sort((a, b) => b.count - a.count)[0];
  const selection: ProcessSelection | null =
    parseSelection(sel) ?? (busiest && busiest.count > 0 ? { kind: 'pair', id: busiest.id } : null);
  const select = (s: ProcessSelection) => onChange({ sel: selectionParam(s) });
  const periodLabel = PERIODS.find((p) => p.value === period)!.label.toLowerCase();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 320px', minWidth: 0 }}>
          <div style={{ ...mono, fontSize: 12, color: 'var(--text-tertiary)', display: 'flex', gap: 8, alignItems: 'center' }}>
            {app.vertical_slug} · process · {view.entity}
          </div>
          <h2 style={{ margin: '4px 0 2px', fontSize: 22, fontWeight: 600 }}>{humanize(view.entity)}</h2>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
            <Total n={current.totals.started} label="started" onClick={() => select({ kind: 'state', state: view.lifecycle!.initial })} /> ·{' '}
            <Total n={current.totals.finished} label="finished" /> · <Total n={current.totals.inFlight} label="in flight" />
            {current.totals.medianLifecycleMs !== null && <> · median lifecycle <span style={mono}>{formatDuration(current.totals.medianLifecycleMs)}</span></>}
            {' '}· last {periodLabel}
          </div>
        </div>
        {view.processes.length > 1 && (
          <Select
            ariaLabel="Process"
            size="sm"
            value={view.entity}
            options={view.processes.map((p) => ({ value: p.entity, label: humanize(p.entity) }))}
            onChange={(e) => onChange({ entity: e.target.value, sel: undefined })}
            style={{ width: 200 }}
          />
        )}
        <Tabs tabs={PERIODS} value={period} onChange={(v) => onChange({ period: v as ProcessPeriod })} style={{ borderBottom: 'none' }} />
        <Button variant={compare ? 'primary' : 'secondary'} size="sm" onClick={() => onChange({ compare: !compare })}>
          Compare: previous {period === '24h' ? 'day' : period === '7d' ? 'week' : '30 days'}
        </Button>
      </div>

      {compare && view.previous && <CompareChips layout={layout} previous={view.previous} onSelect={select} selection={selection} />}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-start' }}>
        <div style={{ ...card, flex: '999 1 560px', minWidth: 0, overflow: 'hidden' }}>
          <Legend />
          <Diagram layout={layout} current={current} selection={selection} onSelect={select} />
          <Footnote flow={current} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, flex: '1 1 340px', minWidth: 0 }}>
          <SidePanel
            app={app}
            layout={layout}
            current={current}
            previous={previous}
            selection={selection}
            onInstance={(id) => setHistory(id)}
          />
          <Funnel layout={layout} current={current} previous={previous} initial={view.lifecycle!.initial} onSelect={select} />
        </div>
      </div>
      {history && (
        <EntityTimeline
          scopeId={app.app_scope_id}
          entityType={view.entity}
          entityId={history}
          stateField={view.lifecycle!.field}
          lifecycle={view.lifecycle!}
          medianMs={current.totals.medianLifecycleMs}
          onClose={() => setHistory(null)}
        />
      )}
    </div>
  );
}

function Note({ children, tone }: { children: ReactNode; tone?: 'danger' }) {
  return (
    <div
      role={tone === 'danger' ? 'alert' : undefined}
      style={{ ...card, padding: 16, fontSize: 13, color: tone === 'danger' ? 'var(--status-danger-fg)' : 'var(--text-secondary)', maxWidth: 760 }}
    >
      {children}
    </div>
  );
}

function Total({ n, label, onClick }: { n: number; label: string; onClick?: () => void }) {
  const body = (
    <>
      <span style={{ ...mono, color: 'var(--text-primary)' }}>{num(n)}</span> {label}
    </>
  );
  return onClick ? (
    <button onClick={onClick} style={{ all: 'unset', cursor: 'pointer' }}>
      {body}
    </button>
  ) : (
    body
  );
}

function Legend() {
  const item: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6 };
  return (
    <div
      style={{
        display: 'flex',
        gap: 18,
        flexWrap: 'wrap',
        padding: '10px 16px',
        borderBottom: '1px solid var(--border-default)',
        fontSize: 12,
        color: 'var(--text-tertiary)',
      }}
    >
      <span style={item}>
        <svg width="26" height="8" aria-hidden><line x1="0" y1="4" x2="26" y2="4" stroke="var(--text-tertiary)" strokeWidth="5" /></svg>
        thickness = moves
      </span>
      <span style={item}>
        <svg width="26" height="8" aria-hidden><line x1="0" y1="4" x2="26" y2="4" stroke="var(--border-strong)" strokeWidth="1.5" strokeDasharray="4 3" /></svg>
        declared, never taken
      </span>
      <span style={item}>
        <svg width="26" height="8" aria-hidden><line x1="0" y1="4" x2="26" y2="4" stroke="var(--status-warning-fg)" strokeWidth="2.5" /></svg>
        not in the model
      </span>
      <span style={item}>
        <svg width="18" height="14" aria-hidden>
          <line x1="2" y1="13" x2="12" y2="3" stroke="var(--status-danger-fg)" strokeWidth="2.5" />
          <path d="M 9 0 L 15 6 M 15 0 L 9 6" stroke="var(--status-danger-fg)" strokeWidth="1.8" />
        </svg>
        refused attempt
      </span>
      <span style={{ marginLeft: 'auto' }}>time in state: median · p90</span>
    </div>
  );
}

function Diagram({
  layout,
  current,
  selection,
  onSelect,
}: {
  layout: ProcessLayout;
  current: LifecycleFlowResult;
  selection: ProcessSelection | null;
  onSelect: (s: ProcessSelection) => void;
}) {
  const stateOf = new Map(current.states.map((s) => [s.state, s]));
  const { stubs, unplaced, top } = refusalStubs(layout, current.refused ?? []);
  return (
    <div style={{ padding: 12, overflowX: 'auto' }}>
      <svg
        // Starts above 0 when a top-row state has refusals, so their stubs are not clipped.
        viewBox={`0 ${top} ${layout.width} ${layout.height - top}`}
        width="100%"
        style={{ display: 'block', minWidth: Math.min(layout.width, 640), maxWidth: layout.width * 1.15 }}
        role="group"
        aria-label="Process map: select a state or a move to see its details"
      >
        <defs>
          {(['idle', 'on', 'warn'] as const).map((k) => (
            <marker key={k} id={`pm-arrow-${k}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="11" markerHeight="11" markerUnits="userSpaceOnUse" orient="auto">
              <path d="M 0 0 L 10 5 L 0 10 z" fill={k === 'on' ? 'var(--brand-400)' : k === 'warn' ? 'var(--status-warning-fg)' : 'var(--text-tertiary)'} />
            </marker>
          ))}
        </defs>
        {layout.pairs.map((p) => (
          <Edge key={p.id} pair={p} selected={selection?.kind === 'pair' && selection.id === p.id} onSelect={() => onSelect({ kind: 'pair', id: p.id })} />
        ))}
        {layout.states.map((s) => (
          <StateNode
            key={s.state}
            laid={s}
            flow={stateOf.get(s.state)}
            lifecycleMs={current.totals.medianLifecycleMs}
            selected={selection?.kind === 'state' && selection.state === s.state}
            onSelect={() => onSelect({ kind: 'state', state: s.state })}
          />
        ))}
        {/* Above the states: a refusal leaves one, and must not be hidden under it. */}
        {stubs.map((st) => (
          <Stub key={st.id} stub={st} selected={selection?.kind === 'refused' && selection.id === st.id} onSelect={() => onSelect({ kind: 'refused', id: st.id })} />
        ))}
      </svg>
      {/* Refusals out of a state this version's model does not declare have no node to
          leave — listed here, so they stay reachable rather than silently undrawn. */}
      {unplaced.length > 0 && (
        <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, fontSize: 12 }}>
          <span style={{ color: 'var(--text-tertiary)' }}>Refused from states this model does not declare:</span>
          {unplaced.map((u) => {
            const id = stubId(u);
            const on = selection?.kind === 'refused' && selection.id === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => onSelect({ kind: 'refused', id })}
                aria-pressed={on}
                style={{
                  appearance: 'none',
                  font: 'inherit',
                  ...mono,
                  fontSize: 11.5,
                  padding: '2px 10px',
                  borderRadius: 999,
                  cursor: 'pointer',
                  background: 'var(--status-danger-bg)',
                  color: 'var(--status-danger-fg)',
                  border: `1px solid ${on ? 'var(--status-danger-fg)' : 'transparent'}`,
                }}
              >
                {u.from} → {u.attempted ?? '?'} ×{num(u.count)}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * What makes an SVG group a control: focusable, announced as a button with its own label,
 * and pressed with Enter or Space as well as a click — a `<g>` gets none of that for free.
 */
function selectable(label: string, selected: boolean, onSelect: () => void) {
  return {
    role: 'button',
    tabIndex: 0,
    'aria-label': label,
    'aria-pressed': selected,
    onClick: onSelect,
    onKeyDown: (ev: KeyboardEvent<SVGGElement>) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        onSelect();
      }
    },
    style: { cursor: 'pointer' },
  } as const;
}

function Edge({ pair, selected, onSelect }: { pair: LaidPair; selected: boolean; onSelect: () => void }) {
  const warn = !pair.declared;
  const stroke = selected ? 'var(--brand-400)' : warn ? 'var(--status-warning-fg)' : pair.untaken ? 'var(--border-strong)' : 'var(--text-tertiary)';
  const label = String(pair.count === 0 && !pair.untaken ? '·' : num(pair.count));
  const w = 12 + label.length * 7;
  const describe = `${pair.from} → ${pair.to}: ${num(pair.count)} moves${pair.untaken ? ' (declared, never taken)' : ''}${pair.undeclared ? ` · ${num(pair.undeclared)} not in the model` : ''}${pair.seenLate ? ` · ${num(pair.seenLate)} seen late` : ''}`;
  return (
    <g {...selectable(describe, selected, onSelect)}>
      <title>{describe}</title>
      <path d={pair.d} fill="none" stroke="transparent" strokeWidth={14} />
      <path
        d={pair.d}
        fill="none"
        stroke={stroke}
        strokeWidth={pair.width}
        strokeDasharray={pair.untaken ? '5 4' : undefined}
        opacity={pair.untaken ? 0.8 : 1}
        markerEnd={`url(#pm-arrow-${selected ? 'on' : warn ? 'warn' : 'idle'})`}
      />
      <rect
        x={pair.labelX - w / 2}
        y={pair.labelY - 10}
        width={w}
        height={20}
        rx={10}
        fill="var(--surface-card)"
        stroke={selected ? 'var(--brand-400)' : warn ? 'var(--status-warning-fg)' : 'var(--border-default)'}
      />
      <text x={pair.labelX} y={pair.labelY + 4} textAnchor="middle" fontSize={11} fontFamily="var(--font-mono)" fill="var(--text-primary)">
        {label}
      </text>
    </g>
  );
}

function StateNode({
  laid,
  flow,
  lifecycleMs,
  selected,
  onSelect,
}: {
  laid: LaidState;
  flow: LifecycleFlowResult['states'][number] | undefined;
  lifecycleMs: number | null;
  selected: boolean;
  onSelect: () => void;
}) {
  const { x, y } = laid;
  const dwell = flow?.dwell;
  const line3 = laid.terminal
    ? lifecycleMs !== null
      ? `lifecycle ${formatDuration(lifecycleMs)}`
      : 'terminal'
    : `${num(flow?.entered ?? 0)} entered`;
  const describe = `${laid.state}: ${num(flow?.current ?? 0)} now${dwell ? ` · median ${formatDuration(dwell.medianMs)}, p90 ${formatDuration(dwell.p90Ms)} over ${num(dwell.samples)} stays` : ''}`;
  return (
    <g {...selectable(describe, selected, onSelect)}>
      <title>{describe}</title>
      <rect
        x={x}
        y={y}
        width={NODE_W}
        height={NODE_H}
        rx={10}
        fill={laid.terminal ? 'var(--surface-inset)' : 'var(--surface-raised)'}
        stroke={selected ? 'var(--brand-400)' : 'var(--border-strong)'}
        strokeWidth={selected ? 1.5 : 1}
      />
      <text x={x + 12} y={y + 22} fontSize={13} fontWeight={600} fill="var(--text-primary)">
        {laid.state}
      </text>
      <text x={x + NODE_W - 12} y={y + 22} fontSize={11} textAnchor="end" fontFamily="var(--font-mono)" fill="var(--text-tertiary)">
        {laid.terminal ? 'terminal' : `${num(flow?.current ?? 0)} now`}
      </text>
      <text x={x + 12} y={y + 46} fontSize={12} fontFamily="var(--font-mono)" fill="var(--text-secondary)">
        {laid.terminal ? `${num(flow?.current ?? 0)} here` : dwell ? `${formatDuration(dwell.medianMs)} · ${formatDuration(dwell.p90Ms)}` : '— · —'}
      </text>
      <text x={x + 12} y={y + 70} fontSize={11.5} fill="var(--text-tertiary)">
        {laid.initial ? 'start' : line3}
      </text>
    </g>
  );
}

/**
 * A refused move (#1745): a short stroke out of the state the record was in, ending in a
 * cross — it goes nowhere, which is the point — and a count beyond it.
 */
function Stub({ stub, selected, onSelect }: { stub: LaidStub; selected: boolean; onSelect: () => void }) {
  const w = stubPillWidth(stub.label);
  const k = 4;
  return (
    <g
      onClick={onSelect}
      onKeyDown={(e: KeyboardEvent) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onSelect())}
      tabIndex={0}
      role="button"
      aria-pressed={selected}
      aria-label={`Refused: ${stub.label}, by ${stub.operation}`}
      style={{ cursor: 'pointer' }}
    >
      <title>{`Refused ${stub.count} times: ${stub.operation} from ${stub.from}`}</title>
      <line x1={stub.x1} y1={stub.y1} x2={stub.x2} y2={stub.y2} stroke="transparent" strokeWidth={14} />
      <line x1={stub.x1} y1={stub.y1} x2={stub.x2} y2={stub.y2} stroke="var(--status-danger-fg)" strokeWidth={selected ? 3.5 : 2.5} />
      <path d={`M ${stub.x2 - k} ${stub.y2 - k} L ${stub.x2 + k} ${stub.y2 + k} M ${stub.x2 + k} ${stub.y2 - k} L ${stub.x2 - k} ${stub.y2 + k}`} stroke="var(--status-danger-fg)" strokeWidth={2} />
      <rect
        x={stub.labelX - w / 2}
        y={stub.labelY - 10}
        width={w}
        height={20}
        rx={10}
        fill="var(--status-danger-bg)"
        stroke={selected ? 'var(--status-danger-fg)' : 'transparent'}
      />
      <text x={stub.labelX} y={stub.labelY + 4} textAnchor="middle" fontSize={11} fontFamily="var(--font-mono)" fill="var(--status-danger-fg)">
        {stub.label}
      </text>
    </g>
  );
}

function Footnote({ flow }: { flow: LifecycleFlowResult }) {
  const o = flow.observation;
  const bits = [`Replayed ${num(o.events)} events across ${num(o.entities)} instances.`];
  if (o.inferred > 0) bits.push(`${num(o.inferred)} moves were read from the operation because the event did not carry the state.`);
  if (o.seenLate > 0) bits.push(`${num(o.seenLate)} were only seen on a later event: the operation that made them recorded nothing on this entity.`);
  if (o.unexplained > 0) bits.push(`${num(o.unexplained)} events named an operation that cannot move the entity from where it was.`);
  // #1745: an app on a version from before refusals were recorded answers without them —
  // no stubs then means "not reported", and the reader is told which.
  if (flow.refused === undefined) bits.push('This app’s version does not report refused moves; they appear after it is pushed again.');
  return (
    <div style={{ padding: '10px 16px', borderTop: '1px solid var(--border-default)', fontSize: 12.5, color: 'var(--text-secondary)' }}>
      {!o.complete && (
        <strong style={{ color: 'var(--status-warning-fg)', fontWeight: 550 }}>
          Partial: the replay stopped at its limit, so every number here is a lower bound.{' '}
        </strong>
      )}
      {bits.join(' ')}
    </div>
  );
}

function CompareChips({
  layout,
  previous,
  selection,
  onSelect,
}: {
  layout: ProcessLayout;
  previous: LifecycleFlowResult;
  selection: ProcessSelection | null;
  onSelect: (s: ProcessSelection) => void;
}) {
  const before = new Map<string, number>();
  for (const e of previous.edges) before.set(pairId(e.from, e.to), (before.get(pairId(e.from, e.to)) ?? 0) + e.count);
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      {layout.pairs
        .filter((p) => p.count > 0 || (before.get(p.id) ?? 0) > 0)
        .map((p) => {
          const d = change(p.count, before.get(p.id));
          const on = selection?.kind === 'pair' && selection.id === p.id;
          return (
            <button
              key={p.id}
              onClick={() => onSelect({ kind: 'pair', id: p.id })}
              style={{
                all: 'unset',
                cursor: 'pointer',
                ...mono,
                fontSize: 11.5,
                padding: '3px 10px',
                borderRadius: 999,
                border: `1px solid ${on ? 'var(--brand-400)' : 'var(--border-default)'}`,
                color: 'var(--text-secondary)',
              }}
            >
              {p.from} → {p.to} {d ?? 'new'}
            </button>
          );
        })}
    </div>
  );
}

const panelHead: CSSProperties = { padding: '12px 16px', borderBottom: '1px solid var(--border-default)' };
const kicker: CSSProperties = { fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-tertiary)' };
const row: CSSProperties = { display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px', borderBottom: '1px solid var(--border-subtle, var(--border-default))' };

function SidePanel({
  app,
  layout,
  current,
  previous,
  selection,
  onInstance,
}: {
  app: AppRow;
  layout: ProcessLayout;
  current: LifecycleFlowResult;
  previous: LifecycleFlowResult | null;
  selection: ProcessSelection | null;
  onInstance: (entityId: string) => void;
}) {
  if (!selection) return <div style={{ ...card, padding: 16, fontSize: 13, color: 'var(--text-secondary)' }}>Nothing moved in this period. Pick a state to see what is in it.</div>;
  if (selection.kind === 'refused') {
    const r = (current.refused ?? []).find((x) => stubId(x) === selection.id);
    if (!r) return null;
    return (
      <div style={card}>
        <div style={panelHead}>
          <div style={kicker}>Refused attempt</div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
            <span style={{ ...mono, fontSize: 15, fontWeight: 600 }}>
              {r.from} → {r.attempted ?? '?'}
            </span>
            <span style={{ ...mono, fontSize: 13 }}>×{num(r.count)}</span>
          </div>
        </div>
        <div style={{ margin: 12, padding: 12, borderRadius: 8, background: 'var(--status-danger-bg)', color: 'var(--status-danger-fg)', fontSize: 12.5 }}>
          <strong style={{ fontWeight: 600 }}>Invariant.</strong> The model does not allow <span style={mono}>{r.operation}</span> from{' '}
          <span style={mono}>{r.from}</span>, and every attempt was refused with a conflict — nothing moved.
          {r.attempted === null && ' The operation leads to more than one state elsewhere, so which move was meant is not known.'}
        </div>
        <div style={{ ...row, ...kicker }}>
          <span style={{ flex: 1 }}>Attempted by</span>
          <span>Count</span>
        </div>
        {Object.entries(r.actors)
          .sort(([, a], [, b]) => (b ?? 0) - (a ?? 0))
          .map(([k, n]) => (
            <div key={k} style={row}>
              <span style={{ flex: 1, fontSize: 12.5 }}>{ACTOR_LABEL[k] ?? k}</span>
              <span style={{ ...mono, fontSize: 12.5 }}>{num(n ?? 0)}</span>
            </div>
          ))}
        <div style={{ padding: '10px 16px' }}>
          <a
            href="#"
            onClick={(ev) => {
              ev.preventDefault();
              navigate(obsPath({ app: app.app_scope_id, view: 'requests', op: r.operation, code: 'conflict' }));
            }}
            style={{ fontSize: 12.5, color: 'var(--text-link, var(--brand-400))' }}
          >
            The refused requests →
          </a>
        </div>
      </div>
    );
  }
  if (selection.kind === 'state') {
    const s = current.states.find((x) => x.state === selection.state);
    if (!s) return null;
    const before = previous?.states.find((x) => x.state === s.state);
    return (
      <div style={card}>
        <div style={panelHead}>
          <div style={kicker}>State{s.terminal ? ' · terminal' : ''}</div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
            <span style={{ ...mono, fontSize: 15, fontWeight: 600 }}>{s.state}</span>
            <span style={{ ...mono, fontSize: 13 }}>{num(s.current)} now</span>
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 4 }}>
            {num(s.entered)} entered{before && change(s.entered, before.entered) ? ` (${change(s.entered, before.entered)} vs before)` : ''}
            {s.dwell
              ? ` · median ${formatDuration(s.dwell.medianMs)}, p90 ${formatDuration(s.dwell.p90Ms)} over ${num(s.dwell.samples)} stays that ended`
              : s.terminal
                ? ''
                : ' · no stay here ended in this period'}
          </div>
        </div>
        {!s.terminal && (
          <>
            <div style={{ ...panelHead, ...kicker }}>Stuck longest</div>
            {s.stuck.length === 0 ? (
              <div style={{ padding: '12px 16px', fontSize: 12.5, color: 'var(--text-tertiary)' }}>Nothing is in this state now.</div>
            ) : (
              s.stuck.map((x) => (
                <button key={x.entityId} onClick={() => onInstance(x.entityId)} style={{ all: 'unset', ...row, cursor: 'pointer', width: '100%', boxSizing: 'border-box' }}>
                  <span style={{ ...mono, fontSize: 12.5, color: 'var(--text-link, var(--brand-400))' }} title={x.entityId}>
                    {shortId(x.entityId)}
                  </span>
                  <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    last <span style={mono}>{x.lastOperation ?? 'a consumer'}</span>
                  </span>
                  <span style={{ ...mono, fontSize: 12 }}>{formatDuration(Date.parse(current.until) - Date.parse(x.since))}</span>
                </button>
              ))
            )}
          </>
        )}
      </div>
    );
  }

  const pair = layout.pairs.find((p) => p.id === selection.id);
  if (!pair) return null;
  const ops = current.edges.filter((e) => e.from === pair.from && e.to === pair.to);
  const beforeCount = previous?.edges.filter((e) => e.from === pair.from && e.to === pair.to).reduce((n, e) => n + e.count, 0);
  const d = change(pair.count, beforeCount);
  const opLabel = (e: LifecycleFlowResult['edges'][number]) =>
    e.seenLate ? 'not recorded — seen on a later event' : e.operation ?? 'a consumer';
  return (
    <div style={card}>
      <div style={panelHead}>
        <div style={kicker}>Transition · what caused it</div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
          <span style={{ ...mono, fontSize: 15, fontWeight: 600 }}>
            {pair.from} → {pair.to}
          </span>
          <span style={{ ...mono, fontSize: 13 }}>{num(pair.count)}</span>
        </div>
        {d && <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 4 }}>{d} vs the previous period.</div>}
      </div>
      {!pair.declared && (
        <div style={{ margin: 12, padding: 12, borderRadius: 8, background: 'var(--status-warning-bg)', color: 'var(--status-warning-fg)', fontSize: 12.5 }}>
          The model does not declare this move, and it happened {num(pair.undeclared)} times. Either the lifecycle is missing an
          edge, or an operation writes a state it should not.
        </div>
      )}
      {pair.untaken ? (
        <div style={{ padding: '12px 16px', fontSize: 12.5, color: 'var(--text-secondary)' }}>
          Declared and permitted, but nothing took this path in the period.
        </div>
      ) : (
        <>
          <div style={{ ...row, ...kicker }}>
            <span style={{ flex: 1 }}>Operation</span>
            <span>Count</span>
          </div>
          {ops
            .filter((e) => e.count > 0)
            .sort((a, b) => b.count - a.count)
            .map((e) => (
              <div key={`${e.operation}:${e.seenLate}:${e.declared}`} style={row}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ ...mono, fontSize: 12.5, color: e.seenLate ? 'var(--text-tertiary)' : 'var(--text-primary)' }}>{opLabel(e)}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', marginTop: 2 }}>
                    {Object.entries(e.actors)
                      .sort(([, a], [, b]) => (b ?? 0) - (a ?? 0))
                      .map(([k, n]) => `${ACTOR_LABEL[k] ?? k} ${num(n ?? 0)}`)
                      .join(' · ')}
                  </div>
                </div>
                <span style={{ ...mono, fontSize: 12.5 }}>{num(e.count)}</span>
              </div>
            ))}
          {ops.some((e) => e.operation && e.count > 0) && (
            <div style={{ padding: '10px 16px' }}>
              <a
                href="#"
                onClick={(ev) => {
                  ev.preventDefault();
                  const operations = ops.filter((e) => e.operation && e.count > 0).map((e) => e.operation!);
                  navigate(obsPath({ app: app.app_scope_id, view: 'requests', op: [...new Set(operations)].join(',') }));
                }}
                style={{ fontSize: 12.5, color: 'var(--text-link, var(--brand-400))' }}
              >
                Requests for these operations →
              </a>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Funnel({
  layout,
  current,
  previous,
  initial,
  onSelect,
}: {
  layout: ProcessLayout;
  current: LifecycleFlowResult;
  previous: LifecycleFlowResult | null;
  initial: string;
  onSelect: (s: ProcessSelection) => void;
}) {
  const rows = funnelRows(layout, current, previous);
  if (current.funnel.started === 0) {
    return (
      <div style={{ ...card, padding: 16, fontSize: 12.5, color: 'var(--text-secondary)' }}>
        <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-primary)', marginBottom: 6 }}>Funnel from {initial}</div>
        Nothing started in this period, so there is no funnel to draw.
      </div>
    );
  }
  return (
    <div style={card}>
      <div style={panelHead}>
        <div style={{ fontWeight: 600, fontSize: 13 }}>Funnel from {initial}</div>
        <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', marginTop: 2 }}>
          Share of the {num(current.funnel.started)} that started here and reached each state{previous ? ' · this period, then the previous one' : ''}
        </div>
      </div>
      {rows.map((r) => {
        const delta = r.share !== null && r.previousShare !== null ? (r.share - r.previousShare) * 100 : null;
        return (
          <button key={r.state} onClick={() => onSelect({ kind: 'state', state: r.state })} style={{ all: 'unset', display: 'block', width: '100%', boxSizing: 'border-box', padding: '10px 16px', cursor: 'pointer' }}>
            <div style={{ display: 'flex', gap: 12, fontSize: 12.5 }}>
              <span style={{ ...mono, flex: 1 }}>{r.state}</span>
              <span style={mono}>{r.share === null ? '—' : pct(r.share)}</span>
              {previous && <span style={{ ...mono, color: 'var(--text-tertiary)', width: 52, textAlign: 'right' }}>{r.previousShare === null ? '—' : pct(r.previousShare)}</span>}
              {previous && (
                <span style={{ ...mono, width: 44, textAlign: 'right', color: delta !== null && delta < -0.05 ? 'var(--status-warning-fg)' : 'var(--text-tertiary)' }}>
                  {delta === null ? '' : `${delta >= 0 ? '+' : '−'}${Math.abs(delta).toFixed(1)}`}
                </span>
              )}
            </div>
            <div style={{ marginTop: 6, height: 6, borderRadius: 3, background: 'var(--surface-inset)' }}>
              <div style={{ width: `${(r.share ?? 0) * 100}%`, height: 6, borderRadius: 3, background: 'var(--brand-500)' }} />
            </div>
            {previous && (
              <div style={{ marginTop: 3, height: 3, borderRadius: 2, background: 'var(--surface-inset)' }}>
                <div style={{ width: `${(r.previousShare ?? 0) * 100}%`, height: 3, borderRadius: 2, background: 'var(--border-strong)' }} />
              </div>
            )}
          </button>
        );
      })}
    </div>
  );
}
