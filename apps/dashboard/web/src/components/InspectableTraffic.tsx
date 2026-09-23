import { useEffect, useRef, useState, type ComponentProps, type PointerEvent } from 'react';
import { TrafficChart } from './TrafficChart';
import { dragWindow, exactTime } from '../lib/observability-query';
import type { OverlayMarker } from '../lib/api';

type Props = ComponentProps<typeof TrafficChart> & {
  window: { since: string; until: string };
  onRange: (w: { from: string; to: string }) => void;
};
export function InspectableTraffic({ window, onRange, ...props }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; left: number; width: number; pointer: number } | null>(null);
  const suppressClick = useRef(false);
  const [selection, setSelection] = useState<{ a: number; b: number } | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [focused, setFocused] = useState(false);
  const [pinned, setPinned] = useState<number | null>(null);
  const [hidden, setHidden] = useState<string[]>([]);
  const [change, setChange] = useState<string | null>(null);
  const dismiss = () => {
    setPinned(null);
    setHover(null);
    setChange(null);
  };
  useEffect(() => {
    dismiss();
    setSelection(null);
    drag.current = null;
  }, [window.since, window.until]);
  const plot = () => root.current?.querySelector<SVGSVGElement>('[data-traffic-plot]');
  const isPlot = (target: EventTarget | null) =>
    target instanceof Element && target.closest('[data-traffic-plot]') !== null;
  const cancel = () => {
    const current = drag.current;
    drag.current = null;
    setSelection(null);
    if (current && root.current?.hasPointerCapture(current.pointer))
      root.current.releasePointerCapture(current.pointer);
  };
  useEffect(() => {
    const escape = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        cancel();
        dismiss();
      }
    };
    globalThis.window.addEventListener('keydown', escape);
    globalThis.window.addEventListener('resize', cancel);
    globalThis.window.addEventListener('blur', cancel);
    return () => {
      globalThis.window.removeEventListener('keydown', escape);
      globalThis.window.removeEventListener('resize', cancel);
      globalThis.window.removeEventListener('blur', cancel);
    };
  }, []);
  const pointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (!isPlot(e.target) || e.button !== 0) return;
    const rect = plot()?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    suppressClick.current = false;
    drag.current = { x: e.clientX - rect.left, left: rect.left, width: rect.width, pointer: e.pointerId };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const pointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    const rect = plot()?.getBoundingClientRect();
    if (!rect) return;
    if (d) {
      const x = Math.max(0, Math.min(d.width, e.clientX - d.left));
      if (Math.abs(x - d.x) >= 5) suppressClick.current = true;
      setSelection({ a: d.x / d.width, b: x / d.width });
    } else if (isPlot(e.target) && pinned === null) {
      const at =
        Date.parse(window.since) +
        Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) *
          (Date.parse(window.until) - Date.parse(window.since));
      const i = props.buckets.findIndex(
        (b) => at >= Date.parse(b.start) && at < Date.parse(b.start) + props.bucketMinutes * 60_000,
      );
      setHover(i < 0 ? null : i);
    }
  };
  const pointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId) return;
    const selected = dragWindow(d.x, e.clientX - d.left, d.width, window);
    cancel();
    if (selected) {
      suppressClick.current = true;
      onRange(selected);
    } else {
      // Capture retargets click to the wrapper; derive the touched bucket here too.
      const at =
        Date.parse(window.since) +
        Math.max(0, Math.min(1, d.x / d.width)) * (Date.parse(window.until) - Date.parse(window.since));
      const index = props.buckets.findIndex(
        (b) => at >= Date.parse(b.start) && at < Date.parse(b.start) + props.bucketMinutes * 60_000,
      );
      if (index >= 0) setPinned(index);
    }
  };
  const active = pinned ?? hover;
  const bucket = active === null ? undefined : props.buckets[active];
  const enabled = (kind: string) => !hidden.includes(kind);
  const overlayMarkers = (props.overlays?.markers ?? []).filter((m) => enabled(m.kind));
  const releases = props.markers.filter(() => enabled('releases'));
  const changes = [
    ...releases.map((m) => ({
      key: `${m.kind}:${m.at}:${m.versionId}`,
      at: m.at,
      label: `${m.version} · ${m.kind === 'pushed' ? 'Version registered' : 'Promoted to prod'}`,
      detail: `Version ${m.versionId}. Registry/channel fact; this does not establish when this installation started serving it.`,
      marker: null as OverlayMarker | null,
    })),
    ...overlayMarkers.map((m, i) => ({
      key: `${m.kind}:${m.at}:${i}`,
      at: m.at,
      label: m.label,
      detail: `${m.kind}: ${m.detail ?? 'Recorded change'}`,
      marker: m,
    })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  const currentChange = changes.find((c) => c.key === change);
  return (
    <div
      className="obs-controls"
      ref={root}
      onPointerDown={pointerDown}
      onPointerMove={pointerMove}
      onPointerUp={pointerUp}
      onPointerCancel={cancel}
      onLostPointerCapture={cancel}
      onPointerLeave={() => {
        if (!drag.current) setHover(null);
      }}
      onKeyDownCapture={(e) => {
        if (e.key === 'Enter' || e.key === ' ') suppressClick.current = false;
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          cancel();
          dismiss();
        }
      }}
    >
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 12, marginBottom: 10 }}>
        <span>Drag to zoom · click or focus a bucket to inspect</span>
        <details>
          <summary>About this chart</summary>
          <p>
            Requests are sampled estimates. Error counts are 5xx responses; 4xx is shown separately. Buckets are{' '}
            {props.bucketMinutes} minutes. Edge buckets contain only traffic inside the selected interval. Zoom
            re-queries that interval without inventing finer precision. Use Edit time for keyboard zoom. Release markers
            record registration and prod promotion, not serving completion.
          </p>
        </details>
      </div>
      <div style={{ position: 'relative' }}>
        <TrafficChart
          {...props}
          plotWindow={window}
          markers={releases}
          overlays={
            props.overlays
              ? { ...props.overlays, markers: overlayMarkers, spans: enabled('stale') ? props.overlays.spans : [] }
              : undefined
          }
          onInspect={(index) => {
            setHover(index);
            setFocused(index !== null);
          }}
          onBucket={(start) => {
            if (!suppressClick.current) setPinned(props.buckets.findIndex((b) => b.start === start));
          }}
          onMarker={(m) => setChange(changes.find((c) => c.marker === m)?.key ?? null)}
        />
        {selection && (
          <div
            aria-hidden
            style={{
              pointerEvents: 'none',
              position: 'absolute',
              top: 0,
              height: props.height ?? 96,
              left: `${Math.min(selection.a, selection.b) * 100}%`,
              width: `${Math.abs(selection.b - selection.a) * 100}%`,
              background: 'var(--brand-500)',
              opacity: 0.2,
            }}
          />
        )}
      </div>
      <div
        style={{ minHeight: 60, padding: '10px 0', fontSize: 12 }}
        aria-live={pinned !== null || focused ? 'polite' : 'off'}
      >
        {bucket ? (
          <>
            <strong>
              {pinned !== null ? 'Pinned · ' : ''}
              {exactTime(new Date(Math.max(Date.parse(bucket.start), Date.parse(window.since))).toISOString())} –{' '}
              {exactTime(
                new Date(
                  Math.min(Date.parse(bucket.start) + props.bucketMinutes * 60_000, Date.parse(window.until)),
                ).toISOString(),
              )}
            </strong>
            {props.lines ? (
              props.lines.map((line) => (
                <div key={line.label}>
                  {line.label}: {line.buckets[active!]?.requests.toLocaleString() ?? '—'} requests ·{' '}
                  {line.buckets[active!]?.errors.toLocaleString() ?? '—'} errors
                </div>
              ))
            ) : (
              <div>
                {bucket.requests.toLocaleString()} requests · {bucket.errors.toLocaleString()} errors
                {bucket.green !== undefined ? ` · ${bucket.green} 2xx/3xx · ${bucket.yellow} 4xx` : ''}
              </div>
            )}
            {pinned === null && <button onClick={() => setPinned(active)}>Pin details</button>}
            {props.onBucket && (
              <button
                onClick={() =>
                  props.onBucket!(
                    new Date(Math.max(Date.parse(bucket.start), Date.parse(window.since))).toISOString(),
                    (Math.min(Date.parse(bucket.start) + props.bucketMinutes * 60_000, Date.parse(window.until)) -
                      Math.max(Date.parse(bucket.start), Date.parse(window.since))) /
                      60_000,
                  )
                }
              >
                Open this interval
              </button>
            )}
            <button onClick={dismiss}>Dismiss details</button>
          </>
        ) : (
          <span>Hover or focus a bucket for counts. Click to keep its details open.</span>
        )}
      </div>
      {props.overlays || props.markers.length > 0 ? (
        <>
          <fieldset style={{ border: 0, padding: 0, display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 12 }}>
            <legend>Change overlays</legend>
            {(['releases', 'migration', 'run-failed', 'failure', 'stale'] as const).map((kind) => (
              <label key={kind}>
                <input
                  type="checkbox"
                  checked={enabled(kind)}
                  onChange={() => setHidden((h) => (h.includes(kind) ? h.filter((k) => k !== kind) : [...h, kind]))}
                />
                {
                  {
                    releases: 'Versions / promotions',
                    migration: 'Migrations',
                    'run-failed': 'Failed schedules',
                    failure: 'Failures',
                    stale: 'Stale spans',
                  }[kind]
                }
              </label>
            ))}
          </fieldset>
          <details>
            <summary style={{ cursor: 'pointer', marginTop: 10 }}>
              Change timeline · {changes.length} records (including chart clusters)
            </summary>
            <ul style={{ maxHeight: 240, overflow: 'auto', fontSize: 12 }}>
              {changes.map((c) => (
                <li key={c.key}>
                  <button onClick={() => setChange(c.key)}>
                    {exactTime(c.at)} · {c.label}
                  </button>
                </li>
              ))}
            </ul>
            {props.overlays?.truncated && <p>Additional records were omitted by source or display limits.</p>}
            {changes.length === 0 && (
              <p>No records returned for the enabled overlays. Unavailable sources are reported separately.</p>
            )}
          </details>
          {currentChange && (
            <section
              aria-label="Change details"
              style={{ padding: 12, background: 'var(--surface-inset)', fontSize: 12 }}
            >
              <strong>{currentChange.label}</strong>
              <p>
                {exactTime(currentChange.at)} · {currentChange.detail}
              </p>
              {currentChange.marker && props.onMarker && (
                <button onClick={() => props.onMarker!(currentChange.marker!)}>Open related evidence</button>
              )}
              <button onClick={dismiss}>Dismiss change</button>
            </section>
          )}
        </>
      ) : null}
    </div>
  );
}
