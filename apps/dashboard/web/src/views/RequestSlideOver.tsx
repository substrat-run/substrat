import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Button } from '@substrat-run/ui';
import { ApiError, api, type EffectsTree, type EmittedLifecycle, type HistoryEntry, type ObservabilityLogEvent, type RequestRecord } from '../lib/api';
import { LogList } from '../components/LogList';
import { callLogsWindow } from '../lib/history';
import { shortId } from '../lib/format';
import { navigate, obsPath } from '../lib/router';
import { DEV_MOCK } from '../lib/mock';
import { mockRequestDetail } from '../lib/mock-request-detail';
import { principalKindLabel } from '../lib/requests';
import {
  causedTransition,
  followUps as flattenFollowUps,
  isInvocationLine,
  msLabel,
  parseEntity,
  recordFromLogs,
  requestTimeline,
  type CausedTransition,
  type FollowUp,
  type RequestTimeline,
} from '../lib/request-detail';
import { EntityTimeline } from './EventHistory';

/**
 * One request, opened from anywhere that holds its call id (#1752, design §7a): a Requests
 * row, a log line's request id. A panel over the page rather than a page of its own,
 * because the question it answers — "what did this one request do?" — is asked in the
 * middle of another one, and closing it must leave the reader where they were.
 *
 * Everything on it is recorded today: the stamped request line (#1746), the call's log
 * lines, what it emitted and what that set off, and the move it made. The design's
 * waterfall of spans — database, connector and model calls — is not recorded yet, so the
 * time axis carries the lines and events at the moment they happened and says so.
 */

const mono: CSSProperties = { fontFamily: 'var(--font-mono)' };
const caps: CSSProperties = { fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-tertiary)' };
/** Most emitted events whose effects are walked: each is one scope read. */
const EFFECTS_MAX = 10;
/** Most entities whose history is read for a transition: each is one scope read. */
const ENTITIES_MAX = 5;

type Part<T> = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; value: T };
const loading = { state: 'loading' } as const;
const errorText = (e: unknown) =>
  e instanceof ApiError ? (e.status === 501 ? 'not available on this platform' : `${e.status}: ${e.message}`) : e instanceof Error ? e.message : String(e);

interface Detail {
  logs: Part<ObservabilityLogEvent[]>;
  record: RequestRecord | null;
  events: Part<HistoryEntry[]>;
  /** Walked trees, or (preview) follow-ups already flattened; timed at render from the request's end. */
  followUps: Part<{ trees: EffectsTree[] } | { flat: FollowUp[] }>;
  /** Some events' consumers could not be read — said beside the ones that could, never instead of them. */
  followUpsError: string | null;
  transitions: Part<CausedTransition[]>;
  /** The running model's lifecycles, read for the transitions and handed on to a record's history. */
  lifecycles: Record<string, EmittedLifecycle>;
}

function useRequestDetail(scopeId: string, invocationId: string, atMs: number): Detail {
  const [d, setD] = useState<Detail>({ logs: loading, record: null, events: loading, followUps: loading, followUpsError: null, transitions: loading, lifecycles: {} });
  useEffect(() => {
    let live = true;
    const set = (patch: Partial<Detail>) => live && setD((prev) => ({ ...prev, ...patch }));
    setD({ logs: loading, record: null, events: loading, followUps: loading, followUpsError: null, transitions: loading, lifecycles: {} });
    if (DEV_MOCK) {
      const m = mockRequestDetail(invocationId);
      setD({
        logs: { state: 'ready', value: m.logs },
        record: m.record,
        events: { state: 'ready', value: m.events },
        followUps: { state: 'ready', value: { flat: m.followUps } },
        followUpsError: null,
        transitions: { state: 'ready', value: m.transitions },
        lifecycles: {},
      });
      return;
    }
    const window = callLogsWindow(new Date(atMs).toISOString());
    // The lines first: the request itself is one of them, and what it touched is on it.
    const logsRead = window
      ? api.appTenantLogs(scopeId, { invocationId, since: window.since, until: window.until, limit: 200 })
      : Promise.reject(new Error('this request carries no usable time'));
    logsRead
      .then(async (logs) => {
        const record = recordFromLogs(logs);
        set({ logs: { state: 'ready', value: logs }, record });
        const refs = (record?.entities ?? []).map(parseEntity).filter((x): x is NonNullable<typeof x> => x !== null);
        if (refs.length === 0) {
          set({ transitions: { state: 'ready', value: [] } });
          return;
        }
        try {
          const lifecycles = (await api.appModel(scopeId)).running.model?.lifecycles ?? {};
          set({ lifecycles });
          const withLifecycle = refs.filter((r) => lifecycles[r.entityType]).slice(0, ENTITIES_MAX);
          const found = await Promise.all(
            withLifecycle.map(async (r) => {
              const page = await api.appEntityHistory(scopeId, r.entityType, r.entityId);
              return causedTransition(r.entityType, r.entityId, invocationId, lifecycles[r.entityType]!, page.entries);
            }),
          );
          set({ transitions: { state: 'ready', value: found.filter((t): t is CausedTransition => t !== null) } });
        } catch (e) {
          set({ transitions: { state: 'error', message: errorText(e) } });
        }
      })
      .catch((e) => set({ logs: { state: 'error', message: errorText(e) }, transitions: { state: 'ready', value: [] } }));
    api
      .appInvocationEvents(scopeId, invocationId)
      .then(async (r) => {
        set({ events: { state: 'ready', value: r.events } });
        // Each event's consumers are their own read: one that fails costs its own rows,
        // not the events list or the consumers of the others.
        const settled = await Promise.allSettled(r.events.slice(0, EFFECTS_MAX).map((e) => api.appEventEffects(scopeId, e.id)));
        const trees = settled.flatMap((s) => (s.status === 'fulfilled' ? [s.value] : []));
        const failed = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected');
        set({ followUps: { state: 'ready', value: { trees } }, followUpsError: failed ? errorText(failed.reason) : null });
      })
      .catch((e) => set({ events: { state: 'error', message: errorText(e) }, followUps: { state: 'error', message: errorText(e) } }));
    return () => {
      live = false;
    };
  }, [scopeId, invocationId, atMs]);
  return d;
}

export function RequestSlideOver({
  scopeId,
  invocationId,
  atMs,
  onClose,
}: {
  scopeId: string;
  invocationId: string;
  /** When the request happened, epoch ms — what its log read is windowed around. */
  atMs: number;
  onClose: () => void;
}) {
  const d = useRequestDetail(scopeId, invocationId, atMs);
  const panel = useRef<HTMLDivElement>(null);
  const [history, setHistory] = useState<CausedTransition | null>(null);
  // The caller's close is a new function every render; the key handler reads the latest
  // through a ref, so focus is taken once on open rather than on every render.
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    panel.current?.focus();
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && close.current();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, []);

  const r = d.record;
  const events = d.events.state === 'ready' ? d.events.value : [];
  const logs = d.logs.state === 'ready' ? d.logs.value : [];
  const timeline = r ? requestTimeline(r, logs, events) : null;
  const title = r?.operation ?? (r?.method && r.path ? `${r.method} ${r.path}` : 'Request');
  const failed = r ? (r.status ?? 0) >= 400 || r.threw : false;

  return (
    <>
      <div aria-hidden onClick={onClose} style={{ position: 'fixed', inset: '56px 0 0 0', background: 'color-mix(in srgb, var(--gray-950) 35%, transparent)', zIndex: 40 }} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={`Request ${invocationId}`}
        tabIndex={-1}
        style={{
          position: 'fixed',
          top: 56,
          right: 0,
          bottom: 0,
          width: 'min(760px, 100vw)',
          background: 'var(--surface-card)',
          borderLeft: '1px solid var(--border-default)',
          boxShadow: 'var(--shadow-popover)',
          zIndex: 41,
          overflowY: 'auto',
          outline: 'none',
        }}
      >
        <div style={{ position: 'sticky', top: 0, zIndex: 1, display: 'flex', alignItems: 'center', gap: 8, padding: '10px 20px', background: 'var(--surface-card)', borderBottom: '1px solid var(--border-default)' }}>
          <span style={{ fontSize: 12.5, color: 'var(--text-tertiary)', flex: 1, minWidth: 0 }}>
            Request · <span style={mono} title={invocationId}>{shortId(invocationId)}</span> · {new Date(atMs).toISOString().replace('T', ' ').slice(0, 23)}
          </span>
          <Button variant="ghost" size="sm" onClick={() => navigate(obsPath({ app: scopeId, view: 'logs', invocationId }))}>
            Only its lines
          </Button>
          {r?.operation && (
            <Button variant="ghost" size="sm" onClick={() => navigate(obsPath({ app: scopeId, view: 'requests', op: r.operation! }))}>
              Similar requests
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close">
            ✕
          </Button>
        </div>

        <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
              <span style={{ ...mono, fontSize: 17, fontWeight: 600 }}>{title}</span>
              {r?.durationMs !== null && r?.durationMs !== undefined && <span style={{ ...mono, fontSize: 13, color: 'var(--text-secondary)' }}>{msLabel(r.durationMs)}</span>}
              {r && <ResultBadge record={r} />}
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 6 }}>
              {r
                ? [
                    r.principalKind ? principalKindLabel(r.principalKind) : 'unknown caller',
                    r.surface ? `${r.surface} surface` : null,
                    r.versionId ? `version ${r.versionId}` : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')
                : d.logs.state === 'loading'
                  ? 'Reading the request…'
                  : 'The request’s own line was not found — the version that served it may predate per-request records, or it is older than the logs are kept. What it emitted is below.'}
            </div>
          </div>

          <Transitions part={d.transitions} scopeId={scopeId} onHistory={setHistory} />
          {history && (
            <EntityTimeline
              scopeId={scopeId}
              entityType={history.entityType}
              entityId={history.entityId}
              stateField={history.field}
              {...(d.lifecycles[history.entityType] ? { lifecycle: d.lifecycles[history.entityType]! } : {})}
              onClose={() => setHistory(null)}
            />
          )}

          <Section title="Timeline" hint="lines and events where they happened">
            {timeline ? <Timeline t={timeline} failed={failed} /> : <Quiet>{d.logs.state === 'loading' ? 'Reading…' : 'No duration was recorded, so there is no axis to draw.'}</Quiet>}
            <Quiet>Database, connector and model calls are not recorded as spans yet, so they do not appear on the axis.</Quiet>
          </Section>

          <Section title="Emitted" hint={d.events.state === 'ready' ? (events.length === 0 ? undefined : `${events.length} event${events.length === 1 ? '' : 's'} · consumers timed from the response`) : undefined}>
            <FollowUps
              error={d.followUpsError}
              events={d.events}
              followUps={
                d.followUps.state === 'ready'
                  ? {
                      state: 'ready',
                      value: 'flat' in d.followUps.value ? d.followUps.value.flat : flattenFollowUps(d.followUps.value.trees, r?.timestamp ?? atMs),
                    }
                  : d.followUps
              }
            />
          </Section>

          <Section title="Log lines" hint={d.logs.state === 'ready' ? `${logs.filter((l) => !isInvocationLine(l)).length} lines` : undefined}>
            {d.logs.state === 'loading' ? (
              <Quiet>Reading the call’s log lines…</Quiet>
            ) : d.logs.state === 'error' ? (
              <Quiet tone="danger">Log lines are unavailable ({d.logs.message}).</Quiet>
            ) : logs.filter((l) => !isInvocationLine(l)).length === 0 ? (
              <Quiet>{r ? 'No lines besides the request’s own.' : 'No log lines were found for this call near this time.'}</Quiet>
            ) : (
              <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 8, overflow: 'hidden' }}>
                <LogList events={logs.filter((l) => !isInvocationLine(l))} maxHeight={320} compact />
              </div>
            )}
          </Section>
        </div>
      </div>
    </>
  );
}

function ResultBadge({ record }: { record: RequestRecord }) {
  const s = record.status;
  const tone = record.threw || (s !== null && s >= 500) ? 'danger' : s !== null && s >= 400 ? 'warning' : 'success';
  const text = record.threw ? 'threw' : s === null ? 'no status' : `${s}${record.problemCode ? ` ${record.problemCode}` : s < 400 ? ' ok' : ''}`;
  return (
    <span
      style={{
        ...mono,
        fontSize: 12,
        padding: '2px 8px',
        borderRadius: 999,
        background: `var(--status-${tone}-bg)`,
        color: `var(--status-${tone}-fg)`,
      }}
    >
      {text}
    </span>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string | undefined; children: ReactNode }) {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <span style={caps}>{title}</span>
        {hint && <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{hint}</span>}
      </div>
      {children}
    </section>
  );
}

function Quiet({ children, tone }: { children: ReactNode; tone?: 'danger' }) {
  return <div style={{ fontSize: 12.5, color: tone === 'danger' ? 'var(--status-danger-fg)' : 'var(--text-tertiary)' }}>{children}</div>;
}

function Transitions({ part, scopeId, onHistory }: { part: Detail['transitions']; scopeId: string; onHistory: (t: CausedTransition) => void }) {
  if (part.state !== 'ready' || part.value.length === 0) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {part.value.map((t) => (
        <div
          key={`${t.entityType}:${t.entityId}`}
          style={{ padding: '12px 14px', borderRadius: 8, background: 'var(--surface-brand-subtle, var(--surface-inset))', border: '1px solid var(--border-brand, var(--border-default))' }}
        >
          <div style={caps}>Caused transition</div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginTop: 6, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13 }}>
              {t.entityType} <span style={mono} title={t.entityId}>{shortId(t.entityId)}</span>
            </span>
            <span style={{ ...mono, fontSize: 13.5, fontWeight: 600 }}>
              {t.from ?? '?'} → {t.to}
            </span>
            <span style={{ flex: 1 }} />
            {t.from !== null && (
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  navigate(obsPath({ app: scopeId, view: 'map', entity: t.entityType, sel: `edge:${t.from}>${t.to}` }));
                }}
                style={{ fontSize: 12.5, color: 'var(--text-link)' }}
              >
                In the process map →
              </a>
            )}
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                onHistory(t);
              }}
              style={{ fontSize: 12.5, color: 'var(--text-link)' }}
            >
              Its history →
            </a>
          </div>
          {t.from === null && <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 4 }}>Nothing earlier on this record carries its state, so where it moved from is not on record.</div>}
        </div>
      ))}
    </div>
  );
}

const LEVEL_COLOR: Record<string, string> = {
  debug: 'var(--border-strong)',
  info: 'var(--text-tertiary)',
  warn: 'var(--status-warning-fg)',
  error: 'var(--status-danger-fg)',
};

function Timeline({ t, failed }: { t: RequestTimeline; failed: boolean }) {
  const pct = (ms: number) => `${Math.max(0, Math.min(100, (ms / t.axisMs) * 100))}%`;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * t.axisMs);
  const row: CSSProperties = { display: 'grid', gridTemplateColumns: '220px 1fr 64px', alignItems: 'center', gap: 10, minHeight: 26 };
  const track = (children: ReactNode) => (
    <div style={{ position: 'relative', height: 26 }}>
      {ticks.map((x) => (
        <span key={x} aria-hidden style={{ position: 'absolute', left: pct(x), top: 0, bottom: 0, width: 1, background: 'var(--border-subtle)' }} />
      ))}
      {children}
    </div>
  );
  return (
    <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 8, padding: '8px 12px' }}>
      <div style={{ ...row, minHeight: 18 }}>
        <span />
        <div style={{ position: 'relative', height: 14 }}>
          {ticks.map((x, i) => (
            <span key={x} style={{ position: 'absolute', left: pct(x), transform: i === ticks.length - 1 ? 'translateX(-100%)' : i === 0 ? 'none' : 'translateX(-50%)', ...mono, fontSize: 10.5, color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>
              {msLabel(x)}
            </span>
          ))}
        </div>
        <span />
      </div>
      <div style={row}>
        <span style={{ display: 'flex', gap: 6, alignItems: 'center', minWidth: 0 }}>
          <Tag>op</Tag>
          <span style={{ ...mono, fontSize: 12.5 }}>request</span>
        </span>
        {track(
          <span
            style={{
              position: 'absolute',
              left: 0,
              width: pct(t.durationMs),
              top: 7,
              height: 12,
              borderRadius: 3,
              background: failed ? 'var(--status-danger-fg)' : 'var(--text-tertiary)',
              opacity: failed ? 0.85 : 0.55,
            }}
          />,
        )}
        <span style={{ ...mono, fontSize: 12, textAlign: 'right' }}>{msLabel(t.durationMs)}</span>
      </div>
      {t.marks.map((m, i) => (
        <div key={i} style={{ ...row, background: m.level === 'error' ? 'color-mix(in srgb, var(--status-danger-bg) 60%, transparent)' : m.level === 'warn' ? 'color-mix(in srgb, var(--status-warning-bg) 60%, transparent)' : undefined }}>
          <span style={{ display: 'flex', gap: 6, alignItems: 'center', minWidth: 0 }}>
            <Tag dashed={m.kind === 'event'}>{m.kind === 'event' ? 'emit' : m.level === 'warn' ? 'wrn' : m.level === 'error' ? 'err' : m.level === 'debug' ? 'dbg' : 'log'}</Tag>
            <span style={{ ...mono, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: m.kind === 'event' ? 'var(--text-primary)' : 'var(--text-secondary)' }} title={m.label}>
              {m.label || '—'}
            </span>
          </span>
          {track(
            <span
              aria-hidden
              style={{
                position: 'absolute',
                left: pct(m.offsetMs),
                top: 9,
                width: 8,
                height: 8,
                marginLeft: -4,
                borderRadius: m.kind === 'event' ? 2 : 999,
                background: m.kind === 'event' ? 'var(--brand-400)' : LEVEL_COLOR[m.level],
              }}
            />,
          )}
          <span style={{ ...mono, fontSize: 11.5, textAlign: 'right', color: m.offsetMs > t.durationMs ? 'var(--text-tertiary)' : 'var(--text-secondary)' }} title={m.offsetMs > t.durationMs ? 'after the response' : undefined}>
            {msLabel(m.offsetMs)}
          </span>
        </div>
      ))}
    </div>
  );
}

function Tag({ children, dashed }: { children: ReactNode; dashed?: boolean }) {
  return (
    <span style={{ ...mono, fontSize: 10.5, padding: '0 5px', borderRadius: 4, border: `1px ${dashed ? 'dashed' : 'solid'} var(--border-strong)`, color: 'var(--text-tertiary)', flexShrink: 0 }}>
      {children}
    </span>
  );
}

const STATE: Record<string, { mark: string; tone: string; word: string }> = {
  delivered: { mark: '✓', tone: 'var(--status-success-fg)', word: 'delivered' },
  retrying: { mark: '⟳', tone: 'var(--status-warning-fg)', word: 'retrying' },
  dead: { mark: '●', tone: 'var(--status-danger-fg)', word: 'gave up' },
};

function FollowUps({ events, followUps, error }: { events: Detail['events']; followUps: Part<FollowUp[]>; error: string | null }) {
  if (events.state === 'loading') return <Quiet>Reading what the call emitted…</Quiet>;
  if (events.state === 'error') return <Quiet tone="danger">What the call emitted could not be read ({events.message}).</Quiet>;
  if (events.value.length === 0) return <Quiet>The call emitted no events — a read, a refusal, or a change that recorded nothing.</Quiet>;
  const rows = followUps.state === 'ready' ? followUps.value : [];
  return (
    <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 8, overflow: 'hidden' }}>
      {events.value.map((e) => {
        const mine = rows.filter((f) => f.event === e.type);
        return (
          <div key={e.id} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '8px 12px' }}>
              <Tag dashed>event</Tag>
              <span style={{ ...mono, fontSize: 12.5 }}>{e.type}</span>
              <span style={{ flex: 1 }} />
              <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                {followUps.state === 'loading' ? 'reading consumers…' : mine.length === 0 ? 'no consumer ran yet' : `${mine.length} consumer${mine.length === 1 ? '' : 's'}`}
              </span>
            </div>
            {mine.map((f, i) => {
              const s = STATE[f.state] ?? { mark: '?', tone: 'var(--text-tertiary)', word: f.state };
              return (
                <div key={i} style={{ display: 'grid', gridTemplateColumns: '48px 1fr auto', gap: 8, alignItems: 'center', padding: '6px 12px 6px 28px', fontSize: 12.5 }} title={f.error ?? undefined}>
                  <Tag dashed>{f.consumer.startsWith('executor:') ? 'job' : 'event'}</Tag>
                  <span style={{ ...mono, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {f.consumer.replace(/^executor:/, '')}
                    {f.error && <span style={{ color: 'var(--text-tertiary)' }}> · {f.error}</span>}
                  </span>
                  <span style={{ ...mono, fontSize: 12, color: s.tone, whiteSpace: 'nowrap' }}>
                    {f.afterResponseMs !== null && <span style={{ color: 'var(--text-tertiary)' }}>{f.afterResponseMs >= 0 ? '+' : ''}{msLabel(f.afterResponseMs)} </span>}
                    {f.state === 'retrying' ? `retry ${f.attempts} ` : ''}
                    {s.mark} {s.word}
                  </span>
                </div>
              );
            })}
          </div>
        );
      })}
      {followUps.state === 'error' && <div style={{ padding: '8px 12px' }}><Quiet tone="danger">What its consumers did could not be read ({followUps.message}).</Quiet></div>}
      {error && <div style={{ padding: '8px 12px' }}><Quiet tone="danger">Some events’ consumers could not be read ({error}); the rest are shown.</Quiet></div>}
    </div>
  );
}
