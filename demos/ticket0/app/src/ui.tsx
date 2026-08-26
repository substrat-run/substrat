/**
 * The primitives the design repeats — state badges, avatars, the internal/public
 * distinction, the mono price treatment.
 *
 * They live together because the handoff treats them as one vocabulary: a state badge
 * looks the same in the inbox, in a conversation header and in the portal, and three
 * copies of it would be three chances to drift.
 */
import type { CSSProperties, ReactNode } from 'react';

/* ── State badges ───────────────────────────────────────────────────────── */

type State = 'new' | 'open' | 'snoozed' | 'resolved' | 'closed';

const STATE: Record<State, { fg: string; bg: string; border: string; dot?: string }> = {
  new: { fg: '#3663bd', bg: '#eef3fd', border: '#c9d8f5' },
  open: { fg: '#178a4c', bg: '#eaf6ef', border: '#bfe3cd' },
  snoozed: { fg: '#a06b0a', bg: '#fdf4e3', border: '#eed9a8', dot: '#c9962a' },
  resolved: { fg: '#6d4fd0', bg: '#f1edfc', border: '#d9cff4' },
  closed: { fg: '#6b6f76', bg: '#f1f1f0', border: '#dededa', dot: '#9a9da2' },
};

export function StateBadge({ state }: { state: string }) {
  const s = STATE[(state as State) in STATE ? (state as State) : 'closed'];
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        font: "500 11px 'Geist Mono', monospace",
        color: s.fg,
        background: s.bg,
        border: `1px solid ${s.border}`,
        borderRadius: 4,
        padding: '2px 7px',
        whiteSpace: 'nowrap',
      }}
    >
      <span
        style={{ width: 5, height: 5, borderRadius: 3, background: s.dot ?? s.fg, flex: '0 0 auto' }}
      />
      {state}
    </span>
  );
}

/* ── Avatars ────────────────────────────────────────────────────────────── */

/** The identity pastels. Picked by name so the same person is the same colour. */
const PASTELS = [
  { bg: '#e4ecf9', fg: '#3d6fd8' },
  { bg: '#f7e7d6', fg: '#a8500f' },
  { bg: '#efe9fb', fg: '#6d4fd0' },
  { bg: '#e9f5ee', fg: '#178a4c' },
  { bg: '#e8e8e4', fg: '#55585e' },
];

function pastelOf(seed: string) {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return PASTELS[h % PASTELS.length]!;
}

export function Avatar({
  name,
  size = 24,
  anonymous = false,
}: {
  name?: string | null;
  size?: number;
  anonymous?: boolean;
}) {
  const label = (name ?? '').trim();
  // Anonymous is a grey `?` — the design is explicit that a visitor with no name is
  // shown as one rather than as an empty circle or an invented initial.
  const initials = anonymous || !label ? '?' : label.slice(0, 1).toUpperCase();
  const c = anonymous || !label ? { bg: '#e8e8e4', fg: '#8a8d93' } : pastelOf(label);
  return (
    <span
      title={label || 'Anonymous visitor'}
      style={{
        width: size,
        height: size,
        borderRadius: size,
        background: c.bg,
        color: c.fg,
        font: `600 ${Math.round(size * 0.42)}px 'Geist', sans-serif`,
        display: 'inline-grid',
        placeItems: 'center',
        flex: '0 0 auto',
      }}
    >
      {initials}
    </span>
  );
}

/** A dashed circle means nobody owns this — not an empty slot, an explicit absence. */
export function Unassigned({ size = 24 }: { size?: number }) {
  return (
    <span
      title="Unassigned"
      style={{
        width: size,
        height: size,
        borderRadius: size,
        border: '1.5px dashed #cdcdc8',
        display: 'inline-block',
        flex: '0 0 auto',
      }}
    />
  );
}

/* ── Priority ───────────────────────────────────────────────────────────── */

const PRIORITY: Record<string, string> = {
  urgent: '#b3261e',
  high: '#c2410c',
  normal: '#6b6f76',
  low: '#9a9da2',
};

export function Priority({ value }: { value: string }) {
  if (!value || value === 'normal')
    return <span style={{ font: "400 11px 'Geist Mono', monospace", color: '#9a9da2' }}>—</span>;
  return (
    <span style={{ font: "500 11px 'Geist Mono', monospace", color: PRIORITY[value] ?? '#6b6f76' }}>
      {value}
    </span>
  );
}

/* ── The money treatment ────────────────────────────────────────────────── */

/**
 * A per-token unit price with its leading zeros dimmed.
 *
 * `$0.000003` is unreadable as a single run of digits and rounding it would be a lie,
 * so the design dims everything up to the first significant digit instead. It is the
 * one place in this app where a number is styled rather than merely formatted.
 */
export function UnitPrice({ amount, suffix = '/ token' }: { amount: string; suffix?: string }) {
  const m = /^(0?\.?0*)(\d.*)$/.exec(amount) ?? [, '', amount];
  return (
    <span style={{ font: "400 12px 'Geist Mono', monospace", whiteSpace: 'nowrap' }}>
      <span style={{ color: '#c2c4c0' }}>${m[1]}</span>
      <span style={{ color: '#17181a' }}>{m[2]}</span>
      {suffix ? <span style={{ font: "400 10px 'Geist', sans-serif", color: '#8a8d93', marginLeft: 4 }}>{suffix}</span> : null}
    </span>
  );
}

/** Money for a total: never dimmed, because a total is meant to be read at a glance. */
export const money = (n: number | string, digits = 4) =>
  `$${Number(n).toFixed(digits).replace(/0+$/, '').replace(/\.$/, '')}`;

/* ── Small pieces ───────────────────────────────────────────────────────── */

export function Dot({ color, spin = false }: { color: string; spin?: boolean }) {
  if (spin)
    return (
      <span
        style={{
          width: 9,
          height: 9,
          borderRadius: 5,
          border: `1.5px solid ${color}`,
          borderTopColor: 'transparent',
          display: 'inline-block',
          animation: 't0spin .9s linear infinite',
        }}
      />
    );
  return (
    <span style={{ width: 6, height: 6, borderRadius: 3, background: color, display: 'inline-block' }} />
  );
}

export function Hairline({ style }: { style?: CSSProperties }) {
  return <div style={{ height: 1, background: '#efefec', ...style }} />;
}

/** An event in a conversation timeline: a coloured badge between two hairlines. */
export function EventDivider({
  tone,
  label,
  meta,
}: {
  tone: 'resolved' | 'reopened' | 'neutral';
  label: string;
  meta?: string;
}) {
  const c =
    tone === 'resolved'
      ? { fg: '#6d4fd0', bg: '#f1edfc', border: '#d9cff4', line: '#ddd0ee' }
      : tone === 'reopened'
        ? { fg: '#178a4c', bg: '#eaf6ef', border: '#bfe3cd', line: '#c9e4d4' }
        : { fg: '#6b6f76', bg: '#f1f1f0', border: '#dededa', line: '#e7e7e3' };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '6px 0' }}>
      <div style={{ flex: 1, height: 1, background: c.line }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          style={{
            font: "500 11px 'Geist Mono', monospace",
            color: c.fg,
            background: c.bg,
            border: `1px solid ${c.border}`,
            borderRadius: 4,
            padding: '2px 7px',
          }}
        >
          {label}
        </span>
        {meta ? <span style={{ font: "400 11px 'Geist', sans-serif", color: '#8a8d93' }}>{meta}</span> : null}
      </div>
      <div style={{ flex: 1, height: 1, background: c.line }} />
    </div>
  );
}

export function Empty({ title, note }: { title: string; note?: ReactNode }) {
  return (
    <div style={{ padding: '56px 24px', textAlign: 'center' }}>
      <div className="t-title" style={{ marginBottom: 6 }}>
        {title}
      </div>
      {note ? <div className="t-meta">{note}</div> : null}
    </div>
  );
}

/** Relative time, the way an inbox shows it. */
export function ago(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 604800) return `${Math.floor(s / 86400)}d`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
