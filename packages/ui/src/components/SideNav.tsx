import { forwardRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';

export interface SideNavItem {
  value: string;
  label: string;
  icon?: ReactNode;
  count?: number;
  /**
   * The item's real URL, when the consumer routes on paths. Given one, the item becomes a
   * link a browser can act on — Copy Link, Open in New Tab, middle-click and ⌘/Ctrl-click
   * all reach the screen rather than the page the person is already on. Left out (a consumer
   * whose views have no URL) the item stays an `onSelect`-only control, as before.
   */
  href?: string;
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

/**
 * The ref reaches the `<nav>` itself, which is what a consumer rendering this as an
 * off-canvas drawer needs: opening one has to move focus inside it, and closing it has to
 * put focus back — neither is possible from outside the element.
 */
export const SideNav = forwardRef<HTMLElement, SideNavProps>(function SideNav(
  { sections, activeValue, onSelect, header, footer, style },
  ref,
) {
  const [hover, setHover] = useState<string | null>(null);

  return (
    <nav
      ref={ref}
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
                href={it.href ?? '#'}
                aria-current={on ? 'page' : undefined}
                onClick={(e) => {
                  // A click asking for a SECOND destination is the browser's to answer, not
                  // ours: a modifier click opens a tab or a window, and swallowing it would
                  // make a real href pointless. Without an href there is nothing to hand
                  // over, so those clicks are still routed in-page.
                  if (it.href && (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0)) return;
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
});
