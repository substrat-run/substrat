// The layout primitives every signed-in screen sits in — lifted from the dashboard's
// components/layout.tsx with AppShell, so the auth-server console lays out the same way.
import type { CSSProperties, KeyboardEvent, ReactNode } from 'react';

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
      // A clickable row is a control, so it is reachable and activatable without a
      // mouse: focusable, announced as a button, and Enter/Space do what the click does.
      // A row with no handler stays plain content and gets none of this.
      {...(onClick
        ? {
            role: 'button',
            tabIndex: 0,
            onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
              if (e.key !== 'Enter' && e.key !== ' ') return;
              e.preventDefault();
              onClick();
            },
          }
        : {})}
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

/**
 * A screen's heading row: title, one line of what the screen is for, and its primary actions
 * on the right — the dashboard's Overview heading, as a component the auth console shares.
 */
export function PageHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 16, flexWrap: 'wrap' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <h1 style={{ margin: 0, fontSize: 22, lineHeight: '29px', fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--text-primary)' }}>{title}</h1>
        {description && <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 2 }}>{description}</div>}
      </div>
      {actions && <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>{actions}</div>}
    </div>
  );
}

/**
 * The top of a detail screen: an icon tile, the record's name, a meta line (its kind, its id,
 * a status), and the actions that act on the whole record — Auth0's and AuthHero's detail
 * header. The tabs go directly under it.
 */
export function DetailHeader({
  icon,
  title,
  meta,
  actions,
}: {
  icon?: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
      {icon && (
        <span
          aria-hidden
          style={{
            width: 40,
            height: 40,
            borderRadius: 10,
            background: 'var(--surface-inset)',
            border: '1px solid var(--border-default)',
            color: 'var(--text-secondary)',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          {icon}
        </span>
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <h1 style={{ margin: 0, fontSize: 22, lineHeight: '29px', fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--text-primary)', overflowWrap: 'anywhere' }}>{title}</h1>
        {meta && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 13, color: 'var(--text-secondary)', marginTop: 2 }}>{meta}</div>
        )}
      </div>
      {actions && <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>{actions}</div>}
    </div>
  );
}

export interface LinkTab {
  value: string;
  label: string;
  href: string;
  count?: number;
}

/**
 * Tabs that are places: each one is a link with its own URL, so a tab survives a reload, can be
 * pasted into a support conversation and opened in a new tab. Only the plain left click is
 * handed to `onNavigate`; ⌘/Ctrl-click and middle-click stay the browser's. (`Tabs` is the
 * stateful variant, for a switch that is not worth a URL.)
 */
export function LinkTabs({ tabs, value, onNavigate, label }: { tabs: LinkTab[]; value: string; onNavigate: (href: string) => void; label?: string }) {
  return (
    <nav aria-label={label} style={{ display: 'flex', gap: 16, borderBottom: '1px solid var(--border-default)', overflowX: 'auto' }}>
      {tabs.map((t) => {
        const on = t.value === value;
        return (
          <a
            key={t.value}
            href={t.href}
            aria-current={on ? 'page' : undefined}
            onClick={(e) => {
              if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
              e.preventDefault();
              onNavigate(t.href);
            }}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              height: 38,
              padding: '0 2px',
              fontSize: 14,
              whiteSpace: 'nowrap',
              textDecoration: 'none',
              fontWeight: on ? 500 : 400,
              color: on ? 'var(--text-primary)' : 'var(--text-tertiary)',
              boxShadow: on ? 'inset 0 -2px 0 var(--brand-600)' : 'none',
            }}
          >
            {t.label}
            {t.count !== undefined && (
              <span style={{ fontSize: 11, padding: '0 6px', borderRadius: 999, background: 'var(--surface-inset)', color: 'var(--text-tertiary)' }}>{t.count}</span>
            )}
          </a>
        );
      })}
    </nav>
  );
}
