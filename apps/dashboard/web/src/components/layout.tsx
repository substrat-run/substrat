import type { CSSProperties, ReactNode } from 'react';

/** The padded, centred content column every screen sits in (content-max default 1200). */
export function Page({ children, maxWidth = 1200, style }: { children: ReactNode; maxWidth?: number; style?: CSSProperties }) {
  return (
    <div style={{ padding: '24px 32px' }}>
      <div style={{ maxWidth, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 20, ...style }}>{children}</div>
    </div>
  );
}

/** A caps table header row + rows, laid out on a shared grid template. */
export function GridTable({
  columns,
  header,
  children,
}: {
  columns: string;
  header: ReactNode[];
  children: ReactNode;
}) {
  return (
    <div style={{ background: 'var(--surface-card)', border: '1px solid var(--border-default)', borderRadius: 12, overflow: 'hidden' }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: columns,
          alignItems: 'center',
          height: 36,
          padding: '0 16px',
          fontSize: 11,
          fontWeight: 500,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          color: 'var(--text-tertiary)',
          borderBottom: '1px solid var(--border-subtle)',
        }}
      >
        {header.map((h, i) => (
          <span key={i} style={{ textAlign: typeof h === 'string' && h.startsWith('~') ? 'right' : 'left' }}>
            {typeof h === 'string' && h.startsWith('~') ? h.slice(1) : h}
          </span>
        ))}
      </div>
      {children}
    </div>
  );
}

/** One grid row inside a GridTable (last row drops its divider). */
export function Row({
  columns,
  last,
  children,
  style,
  onClick,
}: {
  columns: string;
  last?: boolean;
  children: ReactNode;
  style?: CSSProperties;
  onClick?: () => void;
}) {
  return (
    <div
      onClick={onClick}
      style={{
        display: 'grid',
        gridTemplateColumns: columns,
        alignItems: 'center',
        height: 40,
        padding: '0 16px',
        fontSize: 13,
        borderBottom: last ? 'none' : '1px solid var(--border-subtle)',
        ...(onClick ? { cursor: 'pointer' } : {}),
        ...style,
      }}
    >
      {children}
    </div>
  );
}
