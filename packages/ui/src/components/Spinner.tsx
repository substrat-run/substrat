import type { CSSProperties } from 'react';

export interface SpinnerProps {
  /** Diameter in px. Default 14 — the size that sits beside a `md` Button's label. */
  size?: number;
  /** Ring colour. Default `currentColor`, so it inherits whatever it spins inside. */
  color?: string;
  style?: CSSProperties;
}

/**
 * An indeterminate progress ring — the "this is in flight" mark. Decorative by itself
 * (`aria-hidden`): the state it reports belongs on the control that owns the work, as
 * `aria-busy` plus a disabled attribute, which is what `Button loading` sets.
 *
 * The rotation comes from the `substrat-spin` keyframe in the motion tokens; the
 * primitives carry inline styles only, and a keyframe cannot be written inline.
 */
export function Spinner({ size = 14, color = 'currentColor', style }: SpinnerProps) {
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        flex: 'none',
        borderRadius: '50%',
        border: `${Math.max(1.5, size / 8)}px solid ${color}`,
        // The gap in the ring is what makes the rotation readable.
        borderTopColor: 'transparent',
        opacity: 0.9,
        animation: 'substrat-spin 600ms linear infinite',
        ...style,
      }}
    />
  );
}
