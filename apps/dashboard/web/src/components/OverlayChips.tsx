import type { CSSProperties } from 'react';
import { OVERLAY_KEYS, OVERLAY_LABELS, setOverlayVisible, useOverlayPrefs, type OverlayKey } from '../lib/overlay-prefs';

/** Each kind's swatch — a small drawing of the line or tick it puts on the chart. */
const SWATCH: Record<OverlayKey, CSSProperties> = {
  pushed: { width: 8, height: 8, borderRadius: '50%', border: '1.5px solid var(--text-secondary)', boxSizing: 'border-box' },
  live: { width: 2, height: 10, background: 'var(--text-secondary)' },
  mig: { width: 8, height: 8, background: 'var(--text-secondary)' },
  fail: { width: 8, height: 2, background: 'var(--status-danger-fg)', transform: 'rotate(45deg)' },
  rec: { width: 2, height: 10, background: 'var(--status-danger-fg)' },
  stale: {
    width: 12,
    height: 10,
    background:
      'repeating-linear-gradient(135deg, color-mix(in srgb, var(--status-warning-fg) 40%, transparent) 0 3px, transparent 3px 6px)',
  },
};

/**
 * The six overlay toggles (#1767). The state behind them is shared by every chart (see
 * `overlay-prefs`), so the chips above one chart are the chips above all of them. A kind
 * that is off stays on screen struck through rather than disappearing: a chip that
 * vanished could not be turned back on.
 */
export function OverlayChips({ label }: { label?: string }) {
  const prefs = useOverlayPrefs();
  return (
    <div role="group" aria-label="Chart overlays" style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      {label && <span style={{ fontSize: 12, color: 'var(--text-tertiary)', marginRight: 4 }}>{label}</span>}
      {OVERLAY_KEYS.map((k) => {
        const on = prefs[k];
        return (
          <button
            key={k}
            type="button"
            aria-pressed={on}
            onClick={() => setOverlayVisible(k, !on)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              height: 24,
              padding: '0 9px',
              borderRadius: 999,
              font: 'inherit',
              fontSize: 11.5,
              cursor: 'pointer',
              border: '1px solid var(--border-default)',
              background: on ? 'var(--surface-card)' : 'transparent',
              color: on ? 'var(--text-primary)' : 'var(--text-tertiary)',
              textDecoration: on ? 'none' : 'line-through',
            }}
          >
            <span aria-hidden style={{ ...SWATCH[k], display: 'inline-block', flexShrink: 0 }} />
            {OVERLAY_LABELS[k]}
          </button>
        );
      })}
    </div>
  );
}
