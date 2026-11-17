import type { CSSProperties, ReactNode } from 'react';

export interface SkeletonProps {
  /** Width of the block — sized like the text or control it stands in for. */
  w: number | string;
  h?: number;
  r?: number;
  style?: CSSProperties;
}

/**
 * One placeholder block. Static: the pulse lives on the group around it (`SkeletonRegion`,
 * or a `pulse` wrapper), so a card's blocks breathe together rather than each on its own.
 */
export function Skeleton({ w, h = 12, r = 6, style }: SkeletonProps) {
  return <span aria-hidden style={{ display: 'block', width: w, height: h, borderRadius: r, background: 'var(--surface-active)', ...style }} />;
}

/** The pulse a skeleton group carries; `delayMs` staggers neighbouring cards. */
export const skeletonPulse = (delayMs = 0): CSSProperties => ({
  animation: 'substrat-pulse 1.8s ease-in-out infinite',
  animationDelay: `${delayMs}ms`,
});

export interface SkeletonRegionProps {
  /** What is loading, as a screen reader announces it — "Loading members…". */
  label: string;
  children: ReactNode;
  /** Pulse the whole region. Off when the children pulse per card. Default true. */
  pulse?: boolean;
  style?: CSSProperties;
}

/**
 * The announced loading region (#3244): `role="status"` + `aria-busy` with a label, around
 * skeleton blocks laid out like the content they stand in for — same rows, same columns —
 * so nothing jumps when the answer lands.
 */
export function SkeletonRegion({ label, children, pulse = true, style }: SkeletonRegionProps) {
  return (
    <div role="status" aria-busy="true" aria-label={label} style={{ ...(pulse ? skeletonPulse() : {}), ...style }}>
      {children}
    </div>
  );
}
