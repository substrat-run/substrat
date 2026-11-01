import { forwardRef, useEffect, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent, ReactNode } from 'react';
import { useMediaQuery } from '../hooks/use-media-query';
import { IconButton } from './IconButton';
import { SubIcon, SubIcons } from './icons';

/**
 * The signed-in chrome the Substrat apps share: a card-surface sidebar of grouped links, a
 * 56px top bar of breadcrumbs and actions, and a scrolling main column. Lifted out of the
 * dashboard's `DashShell` once the auth-server console became its second caller — the
 * dashboard keeps what is its own (the team switcher, Observability's children, the
 * notifications tile) and hands it in through the slots.
 */

export interface AppShellNavItem {
  key: string;
  label: string;
  icon: ReactNode;
  /** A real URL, so the item can be copied, middle-clicked or opened in a new tab. */
  href: string;
}

export interface AppShellNavGroup {
  /** Absent for an ungrouped run at the top (the dashboard's Overview). */
  title?: string;
  items: AppShellNavItem[];
}

export interface AppShellCrumb {
  label: string;
  href?: string;
  onClick?: () => void;
}

export interface AppShellProps {
  /** Above the groups: the wordmark, and whatever context switcher the app has. */
  brand: ReactNode;
  groups: AppShellNavGroup[];
  /** The key drawn with the active fill. */
  active: string | null;
  /**
   * A key drawn as where you are (primary text, weight 500) WITHOUT the fill — the parent
   * of a child row that is open beneath it, which carries the fill instead.
   */
  parent?: string | null;
  onNav: (key: string) => void;
  /** Rendered directly under an item, e.g. the dashboard's Observability children. */
  beneath?: (key: string) => ReactNode;
  /** The bottom of the sidebar — normally an `AccountMenu`. */
  footer: ReactNode;
  crumbs: AppShellCrumb[];
  /** The right-hand end of the top bar. */
  actions?: ReactNode;
  /**
   * Below this width (px) the sidebar stops being a column and becomes an overlay drawer
   * behind a hamburger. Omitted, it is a column at every width.
   */
  drawerBelow?: number;
  /** Names the `<nav>` landmark. */
  navLabel?: string;
  /** Root-element extras: the console's `data-theme` and its scoping class. */
  className?: string;
  rootProps?: Record<`data-${string}`, string>;
  style?: CSSProperties;
  children: ReactNode;
}

/** Only the plain left click is ours — ⌘/Ctrl, Shift, middle-click belong to the browser. */
function plainClick(e: MouseEvent): boolean {
  return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}

export function AppShell(props: AppShellProps) {
  const compact = useMediaQuery(props.drawerBelow ? `(max-width: ${props.drawerBelow}px)` : null);
  const [navOpen, setNavOpen] = useState(false);
  const navRef = useRef<HTMLElement>(null);
  const menuRef = useRef<HTMLButtonElement>(null);

  // Never leave the drawer latched open when the layout goes back to a column — it would
  // render on top of the content it is already beside.
  useEffect(() => {
    if (!compact) setNavOpen(false);
  }, [compact]);

  // An opened drawer takes focus, Escape closes it, and closing gives focus back to the
  // trigger. The drawer sits BEFORE the hamburger in DOM order, so without the first a Tab
  // from the hamburger walks into the page behind the scrim; without the last, focus is
  // left on an element closing has just made `visibility: hidden`.
  useEffect(() => {
    if (!compact || !navOpen) return;
    navRef.current?.querySelector<HTMLElement>('a[href]')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setNavOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      menuRef.current?.focus();
    };
  }, [compact, navOpen]);

  const nav = (key: string) => {
    props.onNav(key);
    setNavOpen(false);
  };

  return (
    <div
      className={props.className}
      {...props.rootProps}
      style={{ display: 'flex', height: '100vh', overflow: 'hidden', background: 'var(--surface-page)', position: 'relative', ...props.style }}
    >
      {compact && navOpen && (
        <div onClick={() => setNavOpen(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0, 0, 0, 0.4)', zIndex: 30 }} />
      )}
      <nav
        ref={navRef}
        aria-label={props.navLabel}
        style={{
          width: 232,
          flexShrink: 0,
          boxSizing: 'border-box',
          background: 'var(--surface-card)',
          borderRight: '1px solid var(--border-default)',
          padding: '12px 8px',
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
          overflowY: 'auto',
          ...(compact
            ? {
                position: 'fixed',
                insetBlock: 0,
                left: 0,
                zIndex: 31,
                transform: navOpen ? 'translateX(0)' : 'translateX(-100%)',
                // `visibility`, not the transform alone: a nav that is merely translated is
                // still in the tab order, so a keyboard user would tab into links they cannot see.
                visibility: navOpen ? 'visible' : 'hidden',
                // Visibility is transitioned on the way OUT only, so the drawer stays drawn
                // while it slides away. On the way in it must be visible at once: the effect
                // above focuses its first link in the same frame, and focus() on an element
                // that is still `visibility: hidden` does nothing at all.
                transition: navOpen
                  ? 'transform var(--duration-fast) var(--ease-out)'
                  : 'transform var(--duration-fast) var(--ease-out), visibility var(--duration-fast)',
                boxShadow: navOpen ? 'var(--shadow-lg)' : 'none',
              }
            : {}),
        }}
      >
        {props.brand}
        {props.groups.map((group, i) => {
          // A titled group is a labelled group, not a run of links under a caption: the
          // title is a heading and the group points at it, so assistive technology reads
          // "Operate, group" and lets a reader jump by heading. An untitled group stays a
          // plain container; a group with no name is no group to announce.
          const labelId = group.title ? `nav-group-${group.title.toLowerCase().replace(/\s+/g, '-')}` : undefined;
          return (
            <div
              key={group.title ?? i}
              style={{ display: 'flex', flexDirection: 'column', gap: 1 }}
              {...(labelId ? { role: 'group', 'aria-labelledby': labelId } : {})}
            >
              {group.title && (
                <h2
                  id={labelId}
                  style={{ margin: 0, fontSize: 11, fontWeight: 500, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-tertiary)', padding: '0 10px 6px' }}
                >
                  {group.title}
                </h2>
              )}
              {group.items.map((it) => (
                <div key={it.key} style={{ display: 'contents' }}>
                  <NavRow item={it} active={props.active === it.key} parent={props.parent === it.key} onNav={nav} />
                  {props.beneath?.(it.key)}
                </div>
              ))}
            </div>
          );
        })}
        <div style={{ flex: 1 }} />
        {props.footer}
      </nav>

      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <header
          style={{
            height: 56,
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            gap: 16,
            padding: compact ? '0 16px' : '0 24px',
            borderBottom: '1px solid var(--border-default)',
            background: 'color-mix(in srgb, var(--surface-card) 80%, transparent)',
            backdropFilter: 'blur(8px)',
          }}
        >
          {compact && (
            <IconButton ref={menuRef} label="Open navigation" onClick={() => setNavOpen(true)}>
              <SubIcon d={SubIcons.menu} />
            </IconButton>
          )}
          <Crumbs crumbs={props.crumbs} />
          <div style={{ flex: 1 }} />
          {props.actions}
        </header>
        <main style={{ flex: 1, overflow: 'auto' }}>{props.children}</main>
      </div>
    </div>
  );
}

function Crumbs({ crumbs }: { crumbs: AppShellCrumb[] }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, minWidth: 0, overflow: 'hidden' }}>
      {crumbs.map((c, i) => {
        const last = i === crumbs.length - 1;
        return (
          <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, whiteSpace: 'nowrap', minWidth: 0 }}>
            {i > 0 && <span style={{ color: 'var(--text-placeholder)' }}>/</span>}
            <a
              href={c.href ?? '#'}
              aria-current={last ? 'page' : undefined}
              onClick={(e) => {
                if (c.href && !plainClick(e)) return;
                e.preventDefault();
                c.onClick?.();
              }}
              style={{
                color: last ? 'var(--text-primary)' : 'var(--text-tertiary)',
                fontWeight: last ? 500 : 400,
                textDecoration: 'none',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {c.label}
            </a>
          </span>
        );
      })}
    </div>
  );
}

function NavRow({ item, active, parent, onNav }: { item: AppShellNavItem; active: boolean; parent: boolean; onNav: (k: string) => void }) {
  const [hover, setHover] = useState(false);
  return (
    <a
      href={item.href}
      aria-current={active ? 'page' : undefined}
      onClick={(e) => {
        if (!plainClick(e)) return;
        e.preventDefault();
        onNav(item.key);
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        height: 32,
        padding: '0 10px',
        borderRadius: 6,
        textDecoration: 'none',
        background: active ? 'var(--surface-active)' : hover ? 'var(--surface-hover)' : 'transparent',
        color: active || parent ? 'var(--text-primary)' : 'var(--text-secondary)',
        fontSize: 14,
        fontWeight: active || parent ? 500 : 400,
      }}
    >
      <span style={{ display: 'inline-flex', width: 16, color: active ? 'var(--text-brand)' : 'var(--text-tertiary)' }}>{item.icon}</span>
      <span style={{ flex: 1 }}>{item.label}</span>
    </a>
  );
}

/** A secondary nav row under an item (the dashboard's Pulse · Processes · Logs). */
export function AppShellChildRow({ label, href, active, onClick }: { label: string; href: string; active: boolean; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <a
      href={href}
      aria-current={active ? 'page' : undefined}
      onClick={(e) => {
        if (!plainClick(e)) return;
        e.preventDefault();
        onClick();
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        height: 28,
        padding: '0 10px',
        borderRadius: 6,
        textDecoration: 'none',
        background: active ? 'var(--surface-active)' : hover ? 'var(--surface-hover)' : 'transparent',
        color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
        fontSize: 13,
        fontWeight: active ? 500 : 400,
      }}
    >
      {label}
    </a>
  );
}

/** First and last initial, upper-cased; `?` for an empty name. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase() || '?';
}

const TONES: Record<string, { bg: string; fg: string }> = {
  brand: { bg: 'var(--brand-100)', fg: 'var(--brand-700)' },
  cyan: { bg: 'var(--cyan-100)', fg: 'var(--cyan-700)' },
  amber: { bg: 'var(--amber-100)', fg: 'var(--amber-700)' },
  muted: { bg: 'var(--surface-active)', fg: 'var(--text-tertiary)' },
};

/** A circular initials avatar. */
export function Avatar({ seed, tone = 'brand', size = 26 }: { seed: string; tone?: 'brand' | 'cyan' | 'amber' | 'muted'; size?: number }) {
  const t = TONES[tone] ?? TONES['brand']!;
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: t.bg,
        color: t.fg,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: size <= 22 ? 10 : 11,
        fontWeight: 600,
        flexShrink: 0,
      }}
    >
      {initials(seed)}
    </span>
  );
}

export interface AccountMenuItem {
  label: string;
  icon: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  /** Draws a divider above this item. */
  separated?: boolean;
}

/** The sidebar-footer account row and its upward menu. */
export function AccountMenu({ name, email, items }: { name: string; email: string; items: AccountMenuItem[] }) {
  // `?menu=1` opens it on load (a demo/screenshot aid, like `?theme=`).
  const [open, setOpen] = useState(() => new URLSearchParams(window.location.search).get('menu') === '1');
  const [hover, setHover] = useState(false);
  return (
    <div style={{ position: 'relative', borderTop: '1px solid var(--border-subtle)', paddingTop: 8 }}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Account"
        onClick={() => setOpen((o) => !o)}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          padding: '6px 10px',
          borderRadius: 6,
          border: 0,
          background: open || hover ? 'var(--surface-hover)' : 'transparent',
          cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        <Avatar seed={name || email} tone="brand" size={24} />
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: 'block', fontSize: 12.5, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {name || 'Account'}
          </span>
          <span title={email} style={{ display: 'block', fontSize: 11.5, color: 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {email}
          </span>
        </span>
        <span style={{ display: 'inline-flex', transform: open ? 'none' : 'rotate(180deg)', transition: 'transform 120ms', color: 'var(--text-tertiary)' }}>
          <Chevron />
        </span>
      </button>
      {open && (
        <>
          {/* click-away scrim */}
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
          <div
            role="menu"
            style={{
              position: 'absolute',
              bottom: 'calc(100% + 6px)',
              left: 0,
              right: 0,
              zIndex: 41,
              background: 'var(--surface-card)',
              border: '1px solid var(--border-default)',
              borderRadius: 10,
              boxShadow: 'var(--shadow-popover)',
              overflow: 'hidden',
            }}
          >
            {items.map((it) => (
              <div key={it.label} style={{ display: 'contents' }}>
                {it.separated && <div style={{ height: 1, background: 'var(--border-subtle)' }} />}
                <MenuRow
                  item={it}
                  onClick={() => {
                    setOpen(false);
                    it.onSelect();
                  }}
                />
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function MenuRow({ item, onClick }: { item: AccountMenuItem; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        width: '100%',
        height: 34,
        padding: '0 12px',
        border: 0,
        background: hover ? 'var(--surface-hover)' : 'transparent',
        color: item.danger ? 'var(--status-danger-fg)' : 'var(--text-secondary)',
        fontSize: 13,
        cursor: 'pointer',
        textAlign: 'left',
      }}
    >
      {item.icon}
      {item.label}
    </button>
  );
}

function Chevron() {
  return (
    <svg viewBox="0 0 24 24" width={12} height={12} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

/** A small square icon button for the top bar, with an optional unread dot. */
export const IconTile = forwardRef<HTMLButtonElement, { label: string; onClick?: () => void; children: ReactNode; size?: number; badge?: boolean }>(
  function IconTile({ label, onClick, children, size = 24, badge }, ref) {
    const [hover, setHover] = useState(false);
    return (
      <button
        ref={ref}
        type="button"
        aria-label={label}
        title={label}
        onClick={onClick}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          position: 'relative',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: size,
          height: size,
          borderRadius: 6,
          border: 0,
          background: hover ? 'var(--surface-hover)' : 'transparent',
          color: 'var(--text-secondary)',
          cursor: 'pointer',
          flexShrink: 0,
        }}
      >
        {children}
        {badge && (
          <span style={{ position: 'absolute', top: 4, right: 5, width: 6, height: 6, borderRadius: '50%', background: 'var(--brand-500)', border: '1px solid var(--surface-card)' }} />
        )}
      </button>
    );
  },
);

/** The top bar's search affordance: a field-shaped button that opens a palette. */
export function SearchPill({ placeholder, onOpen, width = 340 }: { placeholder: string; onOpen: () => void; width?: number }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        height: 32,
        padding: '0 10px',
        width,
        maxWidth: '100%',
        borderRadius: 6,
        border: '1px solid var(--border-default)',
        background: 'var(--surface-card)',
        color: 'var(--text-placeholder)',
        fontSize: 13,
        flexShrink: 0,
        cursor: 'pointer',
      }}
    >
      <SubIcon d={SubIcons.search} size={14} />
      <span style={{ flex: 1, textAlign: 'left' }}>{placeholder}</span>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, border: '1px solid var(--border-default)', borderRadius: 4, padding: '1px 4px', color: 'var(--text-tertiary)' }}>⌘K</span>
    </button>
  );
}
