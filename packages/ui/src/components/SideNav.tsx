import { useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';

export interface SideNavItem {
  value: string;
  label: string;
  icon?: ReactNode;
  count?: number;
}

export interface SideNavSection {
  title?: string;
  items: SideNavItem[];
}

export interface SideNavProps {
  sections: SideNavSection[];
  activeValue?: string;
  onSelect?: (value: string) => void;
  header?: ReactNode;
  footer?: ReactNode;
  style?: CSSProperties;
}

export function SideNav({
  sections,
  activeValue,
  onSelect,
  header,
  footer,
  style,
}: SideNavProps) {
  const [hover, setHover] = useState<string | null>(null);

  return (
    <nav
      style={{
        width: 'var(--sidebar-w)',
        // Never squeezed: as a flex child it would otherwise give up width to a wide
        // sibling, and a nav rendered at a partial width is broken chrome that also
        // steals the room the content needed.
        flexShrink: 0,
        minHeight: '100%',
        overflowY: 'auto',
        boxSizing: 'border-box',
        background: 'var(--surface-page)',
        borderRight: '1px solid var(--border-default)',
        padding: '12px 8px',
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        fontFamily: 'var(--font-sans)',
        ...style,
      }}
    >
      {header}
      {sections.map((sec, si) => (
        <div key={si} style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          {sec.title && (
            <div
              style={{
                fontSize: 'var(--text-xs)',
                fontWeight: 'var(--weight-medium)',
                letterSpacing: 'var(--tracking-caps)',
                textTransform: 'uppercase',
                color: 'var(--text-tertiary)',
                padding: '0 10px 6px',
              }}
            >
              {sec.title}
            </div>
          )}
          {sec.items.map((it) => {
            const on = activeValue === it.value;
            const hv = hover === it.value;
            return (
              <a
                key={it.value}
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  onSelect?.(it.value);
                }}
                onMouseEnter={() => setHover(it.value)}
                onMouseLeave={() => setHover(null)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  height: 32,
                  padding: '0 10px',
                  borderRadius: 'var(--radius-sm)',
                  textDecoration: 'none',
                  background: on
                    ? 'var(--surface-active)'
                    : hv
                      ? 'var(--surface-hover)'
                      : 'transparent',
                  color: on ? 'var(--text-primary)' : 'var(--text-secondary)',
                  fontSize: 'var(--text-base)',
                  fontWeight: on ? 'var(--weight-medium)' : 'var(--weight-regular)',
                  transition: 'background var(--duration-fast) var(--ease-out)',
                }}
              >
                {it.icon && (
                  <span
                    style={{
                      display: 'inline-flex',
                      width: 16,
                      color: on ? 'var(--text-brand)' : 'var(--text-tertiary)',
                    }}
                  >
                    {it.icon}
                  </span>
                )}
                <span style={{ flex: 1 }}>{it.label}</span>
                {it.count !== undefined && (
                  <span
                    style={{
                      fontSize: 'var(--text-xs)',
                      fontFamily: 'var(--font-mono)',
                      color: 'var(--text-tertiary)',
                    }}
                  >
                    {it.count}
                  </span>
                )}
              </a>
            );
          })}
        </div>
      ))}
      <div style={{ flex: 1 }} />
      {footer}
    </nav>
  );
}
