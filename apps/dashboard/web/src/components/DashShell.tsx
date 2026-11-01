import { useState } from 'react';
import type { ReactNode } from 'react';
import { AccountMenu, AppShell, AppShellChildRow, Avatar, IconTile, SearchPill, SubIcon, SubIcons } from '@substrat-run/ui';
import { Ic, StrataGlyph, type IconName } from '../lib/icons';
import { obsPath, teamPath } from '../lib/router';
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
        <AppShellChildRow key={s.key} label={s.label} href={teamPath(obsPath({ view: defaultView(s.key) }))} active={active === s.key} onClick={() => onNav(s.key)} />
      ))}
    </div>
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
  // Observability's group row opens Pulse, and while any of its children is open the
  // parent reads as where you are without the fill — the fill belongs to the child.
  const obsOpen = props.active === 'observability';
  return (
    <AppShell
      groups={GROUPS.map((g) => ({
        title: g.title,
        items: g.items.map((it) => ({ key: it.key, label: it.label, icon: <Ic name={it.icon} />, href: teamPath(`/${it.key}`) })),
      }))}
      active={obsOpen ? null : props.active}
      parent={obsOpen ? 'observability' : null}
      onNav={(k) => props.onNav(k as NavKey)}
      beneath={(k) => (k === 'observability' && obsOpen ? <ObsChildren active={props.obsSection} onNav={props.onObsNav} /> : null)}
      brand={
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '4px 10px 0' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <StrataGlyph size={18} />
            <span style={{ fontSize: 15, fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--text-primary)' }}>substrat</span>
          </div>
          <TeamSwitcher org={props.org} teams={props.teams} currentTeamId={props.currentTeamId} onSwitch={props.onSwitchTeam} onNewTeam={props.onNewTeam} />
        </div>
      }
      footer={
        <AccountMenu
          name={props.userName}
          email={props.userEmail}
          items={[
            { label: 'Account settings', icon: <Ic name="settings" size={15} />, onSelect: () => props.onNav('settings') },
            { label: 'Toggle theme', icon: <SubIcon d={SubIcons.moon} size={15} />, onSelect: props.onToggleTheme },
            { label: 'Sign out', icon: <Ic name="arrowLeft" size={15} />, onSelect: props.onSignOut, danger: true, separated: true },
          ]}
        />
      }
      crumbs={props.crumbs}
      actions={
        <>
          <SearchPill placeholder="Jump to… or write to support" onOpen={props.onOpenPalette} />
          <IconTile label="Notifications" onClick={props.onOpenNotifications} size={28} badge={props.unread}>
            <Ic name="bell" size={16} />
          </IconTile>
        </>
      }
    >
      {props.children}
    </AppShell>
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

/** Moved to `@substrat-run/ui` with the shell; re-exported for the views that read it here. */
export { Avatar };
