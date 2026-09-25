import { useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { Ic, StrataGlyph, type IconName } from '../lib/icons';
import { obsPath, teamPath } from '../lib/router';
import { initials } from '../lib/format';
import type { Team } from '../lib/api';
import { OBS_SECTIONS, defaultView, type ObsSection } from '../lib/obs-sections';

export type NavKey =
  | 'overview'
  | 'apps'
  | 'verticals'
  | 'observability'
  | 'audit'
  | 'domains'
  | 'team'
  | 'integrations'
  | 'billing'
  | 'settings';

interface NavItem {
  key: NavKey;
  label: string;
  icon: IconName;
}
/**
 * The left menu, grouped by what a person is doing (#1447): what you build, what you
 * run, what you configure — the three audiences observability.md names, and the split
 * the app page's tab bar could not carry once Observability and Audit moved up here. A
 * left menu scales where a tab bar does not, which is the whole reason those two moved;
 * ten items under three headings is what that scaling looks like. Overview stands alone
 * above the groups because it is the one page that is about none of them in particular.
 */
interface NavGroup {
  /** Absent for the ungrouped items at the top. */
  title?: string;
  items: NavItem[];
}
const GROUPS: NavGroup[] = [
  { items: [{ key: 'overview', label: 'Overview', icon: 'grid' }] },
  {
    title: 'Build',
    items: [
      { key: 'apps', label: 'Apps', icon: 'box' },
      { key: 'verticals', label: 'Verticals', icon: 'layers' },
    ],
  },
  {
    title: 'Operate',
    items: [
      // Every app on the team on one chart with one time range, and an app filter that
      // narrows the page to one of them — the page that replaced the demo Analytics screen.
      { key: 'observability', label: 'Observability', icon: 'chart' },
      // The audit log is the TEAM's, not one app's — role changes and entitlements name no
      // scope at all — so it is a page here with an app filter rather than a tab on each app.
      { key: 'audit', label: 'Audit', icon: 'list' },
    ],
  },
  {
    title: 'Configure',
    items: [
      { key: 'domains', label: 'Domains', icon: 'globe' },
      { key: 'integrations', label: 'Integrations', icon: 'plug' },
      { key: 'team', label: 'Team', icon: 'users' },
      { key: 'billing', label: 'Billing', icon: 'card' },
      { key: 'settings', label: 'Settings', icon: 'settings' },
    ],
  },
];

function NavRow({ item, active, parent = false, onNav }: { item: NavItem; active: boolean; parent?: boolean; onNav: (k: NavKey) => void }) {
  const [hover, setHover] = useState(false);
  return (
    <a
      href={teamPath(`/${item.key}`)}
      onClick={(e) => {
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
      <span style={{ display: 'inline-flex', width: 16, color: active ? 'var(--text-brand)' : 'var(--text-tertiary)' }}>
        <Ic name={item.icon} />
      </span>
      <span style={{ flex: 1 }}>{item.label}</span>
    </a>
  );
}

/**
 * The Observability group's children (#1767): Pulse · Processes · Logs, shown while any
 * of them is open. The group row itself opens Pulse, so a reader who never expands it
 * still lands somewhere — the children are where they go next, not a gate in front.
 */
function ObsChildren({ active, onNav }: { active: ObsSection; onNav: (s: ObsSection) => void }) {
  return (
    <div
      role="group"
      aria-label="Observability"
      style={{ display: 'flex', flexDirection: 'column', gap: 1, margin: '1px 0 4px 17px', paddingLeft: 9, borderLeft: '1px solid var(--border-default)' }}
    >
      {OBS_SECTIONS.map((s) => (
        <ObsChildRow key={s.key} label={s.label} href={teamPath(obsPath({ view: defaultView(s.key) }))} active={active === s.key} onClick={() => onNav(s.key)} />
      ))}
    </div>
  );
}

function ObsChildRow({ label, href, active, onClick }: { label: string; href: string; active: boolean; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <a
      href={href}
      aria-current={active ? 'page' : undefined}
      onClick={(e) => {
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

export interface Crumb {
  label: string;
  onClick?: () => void;
}

export interface DashShellProps {
  active: NavKey;
  onNav: (k: NavKey) => void;
  /** Which Observability child is open; only read while `active` is `observability`. */
  obsSection: ObsSection;
  onObsNav: (s: ObsSection) => void;
  org: string;
  /** Every team the signed-in user belongs to — drives the sidebar switcher. */
  teams: Team[];
  currentTeamId: string;
  onSwitchTeam: (teamId: string) => void;
  onNewTeam: () => void;
  userEmail: string;
  userName: string;
  crumbs: Crumb[];
  unread: boolean;
  onToggleTheme: () => void;
  onOpenPalette: () => void;
  onOpenNotifications: () => void;
  onSignOut: () => void;
  children: ReactNode;
}

export function DashShell(props: DashShellProps) {
  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden', background: 'var(--surface-page)' }}>
      {/* Sidebar */}
      <nav
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
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '4px 10px 0' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <StrataGlyph size={18} />
            <span style={{ fontSize: 15, fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--text-primary)' }}>substrat</span>
          </div>
          <TeamSwitcher org={props.org} teams={props.teams} currentTeamId={props.currentTeamId} onSwitch={props.onSwitchTeam} onNewTeam={props.onNewTeam} />
        </div>
        {GROUPS.map((group, i) => {
          // A titled group is a labelled group, not a run of links under a caption: the
          // title is a heading and the group points at it, so assistive technology reads
          // "Operate, group" and lets a reader jump by heading — the structure sighted
          // readers get from the uppercase label. The untitled first group (Overview)
          // stays a plain container; a group with no name is no group to announce.
          const labelId = group.title ? `nav-group-${group.title.toLowerCase()}` : undefined;
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
                  {/* A parent whose child is open reads as where you are (primary text,
                      weight 500) without the active fill — the fill belongs to the child. */}
                  <NavRow item={it} active={props.active === it.key && it.key !== 'observability'} parent={props.active === 'observability' && it.key === 'observability'} onNav={props.onNav} />
                  {it.key === 'observability' && props.active === 'observability' && (
                    <ObsChildren active={props.obsSection} onNav={props.onObsNav} />
                  )}
                </div>
              ))}
            </div>
          );
        })}
        <div style={{ flex: 1 }} />
        <SidebarAccount
          userName={props.userName}
          userEmail={props.userEmail}
          onSettings={() => props.onNav('settings')}
          onToggleTheme={props.onToggleTheme}
          onSignOut={props.onSignOut}
        />
      </nav>

      {/* Main column */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <header
          style={{
            height: 56,
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            gap: 16,
            padding: '0 24px',
            borderBottom: '1px solid var(--border-default)',
            background: 'color-mix(in srgb, var(--surface-card) 80%, transparent)',
            backdropFilter: 'blur(8px)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, minWidth: 0 }}>
            {props.crumbs.map((c, i) => {
              const last = i === props.crumbs.length - 1;
              return (
                <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, whiteSpace: 'nowrap' }}>
                  {i > 0 && <span style={{ color: 'var(--text-placeholder)' }}>/</span>}
                  <a
                    href="#"
                    onClick={(e) => {
                      e.preventDefault();
                      c.onClick?.();
                    }}
                    style={{ color: last ? 'var(--text-primary)' : 'var(--text-tertiary)', fontWeight: last ? 500 : 400, textDecoration: 'none' }}
                  >
                    {c.label}
                  </a>
                </span>
              );
            })}
          </div>
          <div style={{ flex: 1 }} />
          <button
            type="button"
            onClick={props.onOpenPalette}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              height: 32,
              padding: '0 10px',
              width: 340,
              borderRadius: 6,
              border: '1px solid var(--border-default)',
              background: 'var(--surface-card)',
              color: 'var(--text-placeholder)',
              fontSize: 13,
              flexShrink: 0,
              cursor: 'pointer',
            }}
          >
            <Ic name="search" size={14} />
            <span style={{ flex: 1, textAlign: 'left' }}>Jump to app or action…</span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, border: '1px solid var(--border-default)', borderRadius: 4, padding: '1px 4px', color: 'var(--text-tertiary)' }}>⌘K</span>
          </button>
          <IconTile label="Notifications" onClick={props.onOpenNotifications} size={28} badge={props.unread}>
            <Ic name="bell" size={16} />
          </IconTile>
        </header>
        <main style={{ flex: 1, overflow: 'auto' }}>{props.children}</main>
      </div>
    </div>
  );
}

/**
 * The team switcher under the wordmark. Shows the current team; the dropdown lists
 * every team the user belongs to (one login can span several) and switches on click.
 * A single-team user still gets the control — it is where "New team" will live.
 */
function TeamSwitcher({
  org,
  teams,
  currentTeamId,
  onSwitch,
  onNewTeam,
}: {
  org: string;
  teams: Team[];
  currentTeamId: string;
  onSwitch: (teamId: string) => void;
  onNewTeam: () => void;
}) {
  // `?teams=1` opens it on load (a demo/screenshot aid, like `?menu=1`).
  const [open, setOpen] = useState(() => new URLSearchParams(window.location.search).get('teams') === '1');
  return (
    <div style={{ position: 'relative', marginLeft: 26 }}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Switch team"
        onClick={() => setOpen((o) => !o)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          maxWidth: '100%',
          padding: '2px 6px',
          margin: '0 -6px',
          borderRadius: 6,
          border: 0,
          background: open ? 'var(--surface-hover)' : 'transparent',
          color: 'var(--text-secondary)',
          fontSize: 12.5,
          cursor: 'pointer',
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{org}</span>
        <span style={{ display: 'inline-flex', transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 120ms' }}>
          <Ic name="chevronDown" size={11} color="var(--text-tertiary)" />
        </span>
      </button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
          <div
            role="menu"
            style={{
              position: 'absolute',
              top: 28,
              left: -6,
              zIndex: 41,
              width: 224,
              background: 'var(--surface-card)',
              border: '1px solid var(--border-default)',
              borderRadius: 10,
              boxShadow: 'var(--shadow-popover)',
              overflow: 'hidden',
            }}
          >
            <div style={{ padding: '8px 12px 4px', fontSize: 11, fontWeight: 500, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-tertiary)' }}>
              Teams
            </div>
            {teams.map((t) => (
              <TeamRow key={t.id} team={t} active={t.id === currentTeamId} onClick={() => { setOpen(false); onSwitch(t.id); }} />
            ))}
            <div style={{ height: 1, background: 'var(--border-subtle)', margin: '4px 0' }} />
            <button
              type="button"
              role="menuitem"
              onClick={() => { setOpen(false); onNewTeam(); }}
              style={{ display: 'flex', alignItems: 'center', gap: 9, width: '100%', height: 36, padding: '0 12px', border: 0, background: 'transparent', color: 'var(--text-secondary)', fontSize: 13, cursor: 'pointer', textAlign: 'left' }}
            >
              <span style={{ display: 'inline-flex', width: 22, justifyContent: 'center', color: 'var(--text-tertiary)' }}>
                <Ic name="plus" size={15} />
              </span>
              New team
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function TeamRow({ team, active, onClick }: { team: Team; active: boolean; onClick: () => void }) {
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
        gap: 9,
        width: '100%',
        height: 38,
        padding: '0 12px',
        border: 0,
        background: hover ? 'var(--surface-hover)' : 'transparent',
        color: 'var(--text-primary)',
        fontSize: 13,
        cursor: 'pointer',
        textAlign: 'left',
      }}
    >
      <Avatar seed={team.name} tone="brand" size={22} />
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{team.name}</span>
      {active && <Ic name="check" size={15} color="var(--text-brand)" />}
    </button>
  );
}

const TONES: Record<string, { bg: string; fg: string }> = {
  brand: { bg: 'var(--brand-100)', fg: 'var(--brand-700)' },
  cyan: { bg: 'var(--cyan-100)', fg: 'var(--cyan-700)' },
  amber: { bg: 'var(--amber-100)', fg: 'var(--amber-700)' },
  muted: { bg: 'var(--surface-active)', fg: 'var(--text-tertiary)' },
};

/** A circular initials avatar. */
export function Avatar({ seed, tone = 'brand', size = 26 }: { seed: string; tone?: keyof typeof TONES; size?: number }) {
  const t = TONES[tone] ?? TONES.brand!;
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

/** The sidebar-footer account row + its upward dropdown menu (settings / theme / sign out). */
function SidebarAccount({
  userName,
  userEmail,
  onSettings,
  onToggleTheme,
  onSignOut,
}: {
  userName: string;
  userEmail: string;
  onSettings: () => void;
  onToggleTheme: () => void;
  onSignOut: () => void;
}) {
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
        <Avatar seed={userName || userEmail} tone="brand" size={24} />
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: 'block', fontSize: 12.5, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {userName || 'Account'}
          </span>
          <span title={userEmail} style={{ display: 'block', fontSize: 11.5, color: 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {userEmail}
          </span>
        </span>
        <span style={{ display: 'inline-flex', transform: open ? 'none' : 'rotate(180deg)', transition: 'transform 120ms' }}>
          <Ic name="chevronDown" size={12} color="var(--text-tertiary)" />
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
            <MenuItem icon="settings" label="Account settings" onClick={() => { setOpen(false); onSettings(); }} />
            <MenuItem icon="settings" label="Toggle theme" onClick={() => { setOpen(false); onToggleTheme(); }} moon />
            <div style={{ height: 1, background: 'var(--border-subtle)' }} />
            <MenuItem icon="arrowLeft" label="Sign out" onClick={() => { setOpen(false); onSignOut(); }} danger />
          </div>
        </>
      )}
    </div>
  );
}

function MenuItem({ icon, label, onClick, danger, moon }: { icon: IconName; label: string; onClick: () => void; danger?: boolean; moon?: boolean }) {
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
        color: danger ? 'var(--status-danger-fg)' : 'var(--text-secondary)',
        fontSize: 13,
        cursor: 'pointer',
        textAlign: 'left',
      }}
    >
      {moon ? (
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" /></svg>
      ) : (
        <Ic name={icon} size={15} />
      )}
      {label}
    </button>
  );
}

function IconTile({
  label,
  onClick,
  children,
  size = 24,
  badge,
}: {
  label: string;
  onClick?: () => void;
  children: ReactNode;
  size?: number;
  badge?: boolean;
}) {
  const [hover, setHover] = useState(false);
  const style: CSSProperties = {
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
  };
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} style={style}>
      {children}
      {badge && (
        <span style={{ position: 'absolute', top: 4, right: 5, width: 6, height: 6, borderRadius: '50%', background: 'var(--brand-500)', border: '1px solid var(--surface-card)' }} />
      )}
    </button>
  );
}
