import { useEffect, useState } from 'react';
import { AccountMenu, AppShell, EmptyState, Page, SearchPill, SubIcon, SubIcons } from '@substrat-run/ui';
import type { AppShellCrumb, AppShellNavGroup } from '@substrat-run/ui';
import { discovery, type Discovery, type Session } from '../api';
import { AccountView } from '../views/Account';
import { ApisView } from '../views/Apis';
import { ApplicationDetailView } from '../views/ApplicationDetail';
import { ClientsPanel } from '../views/Applications';
import { ConnectionDetailView } from '../views/ConnectionDetail';
import { ConnectionsView } from '../views/Connections';
import { LogEntryView } from '../views/LogEntry';
import { LogsView } from '../views/Logs';
import { OverviewView } from '../views/Overview';
import { SecurityView } from '../views/Security';
import { SettingsView } from '../views/Settings';
import { UserDetailView } from '../views/UserDetail';
import { UsersView } from '../views/Users';
import { CommandPalette } from './CommandPalette';
import { navigate, usePathname } from './router';
import { useConsoleTheme } from './theme';
import {
  ACCOUNT_PATH,
  APIS_PATH,
  APPLICATIONS_PATH,
  CONNECTIONS_PATH,
  ICON_ACCOUNT,
  LOGS_PATH,
  OVERVIEW_PATH,
  ROUTES,
  SECURITY_PATH,
  SETTINGS_PATH,
  USERS_PATH,
  applicationDetail,
  connectionDetail,
  legacyTarget,
  logEntryId,
  userDetail,
  type Route,
} from './routes';
// (`console.css` is imported from main.tsx, not here: its load ORDER relative to tokens.css
//  decides which set wins the property they share, and only main.tsx can guarantee it.)

function groupsFor(admin: boolean): AppShellNavGroup[] {
  const groups: AppShellNavGroup[] = [];
  for (const route of ROUTES) {
    if (route.adminOnly && !admin) continue;
    if (route.navForNonAdminOnly && admin) continue;
    let group = groups.find((g) => g.title === route.group);
    if (!group) groups.push((group = { title: route.group, items: [] }));
    // The key IS the path, and so is the href: the screen has a URL, so the nav item is a
    // link a browser can copy, open in a tab or middle-click. AppShell handles only the plain
    // click, so a normal navigation stays same-document.
    group.items.push({ key: route.path, href: route.path, label: route.label, icon: <SubIcon d={route.icon} /> });
  }
  return groups;
}

/**
 * The signed-in console: a left nav, one screen per URL, and Substrat's branding — which
 * stops here. Everything under `auth/` answers a relying party's authorize request and is
 * themed from that client's own `metadata.theme`; nothing in this subtree is reachable from
 * those screens, and `console.css` scopes its overrides to `.console-root` so it cannot
 * reach them by accident either.
 *
 * The nav is chrome, never the gate: every admin call is refused server-side by session +
 * the `admin` role, so hiding a section from a non-administrator is a courtesy and hiding
 * it wrong is a layout bug rather than a hole.
 */
export function Console({ session, admin, onSignOut }: { session: Session; admin: boolean; onSignOut: () => void }) {
  const pathname = usePathname();
  const [disc, setDisc] = useState<Discovery | null>(null);
  const [theme, toggleTheme] = useConsoleTheme();
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    // The issuer's own metadata: Connections shows the callback URL an upstream has to be
    // given, and Settings shows the document itself. One read, several screens.
    void discovery().then(setDisc);
  }, []);

  useEffect(() => {
    if (!admin) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [admin]);

  const visible = ROUTES.filter((r) => admin || !r.adminOnly);
  // `/account` is `adminOnly: false`, so this list is never empty for either audience — the
  // fallback only exists because the type cannot say so.
  const home = visible[0] ?? ROUTES[ROUTES.length - 1]!;
  const section = (path: string): Route | null => visible.find((r) => r.path === path) ?? null;

  // A detail screen is a screen under its section rather than a section of its own: the nav
  // keeps the section lit, and every one is read after the permission filter — so a
  // non-administrator pasting one gets the "no such page" answer the nav's own courtesy
  // already implies.
  const user = section(USERS_PATH) ? userDetail(pathname) : null;
  const app = section(APPLICATIONS_PATH) ? applicationDetail(pathname) : null;
  const conn = section(CONNECTIONS_PATH) ? connectionDetail(pathname) : null;
  const logId = section(LOGS_PATH) ? logEntryId(pathname) : null;
  const active =
    section(pathname) ??
    (user ? section(USERS_PATH) : null) ??
    (app ? section(APPLICATIONS_PATH) : null) ??
    (conn ? section(CONNECTIONS_PATH) : null) ??
    (logId !== null ? section(LOGS_PATH) : null);
  // A URL from before the regroup (`/providers/google`, `/sign-in-log`) is a place that moved.
  const moved = admin ? legacyTarget(pathname) : null;

  useEffect(() => {
    // Replace rather than push: the back button should not have to step through a redirect
    // that was never a place the person had been.
    if (moved) navigate(moved, { replace: true });
    else if (pathname === OVERVIEW_PATH && !admin) navigate(home.path, { replace: true });
  }, [pathname, moved, home, admin]);

  // Issuer › Section › Item. The issuer is the root because it is what this console is OF —
  // the dashboard's crumbs start at the team for the same reason.
  const issuerHost = disc ? new URL(disc.issuer).host : window.location.host;
  const crumbs: AppShellCrumb[] = [{ label: issuerHost, href: home.path, onClick: () => navigate(home.path) }];
  if (active && active.path !== OVERVIEW_PATH) crumbs.push({ label: active.label, href: active.path, onClick: () => navigate(active.path) });
  const detail = user?.id ?? app?.id ?? conn?.id ?? (logId !== null ? `#${logId}` : null);
  if (detail) crumbs.push({ label: detail });
  if (!active && !moved) crumbs.push({ label: 'Not found' });

  return (
    // `data-theme` on the console root rather than on <html>: the hand-off screens share the
    // document and are themed by the relying party, never by this toggle. `color-scheme`
    // follows, or the browser draws light scrollbars and native controls inside a dark page.
    <AppShell
      className="console-root"
      rootProps={{ 'data-theme': theme }}
      style={{ colorScheme: theme }}
      navLabel="Console"
      drawerBelow={900}
      groups={groupsFor(admin)}
      active={active?.path ?? null}
      onNav={(path) => navigate(path)}
      crumbs={crumbs}
      brand={<IssuerCard issuer={disc?.issuer ?? null} />}
      actions={admin ? <SearchPill placeholder="Jump to…" width={280} onOpen={() => setPaletteOpen(true)} /> : undefined}
      footer={
        <AccountMenu
          name={session.name ?? ''}
          email={session.email ?? session.sub}
          items={[
            { label: 'Your account', icon: <SubIcon d={ICON_ACCOUNT} size={15} />, onSelect: () => navigate(ACCOUNT_PATH) },
            { label: theme === 'dark' ? 'Light theme' : 'Dark theme', icon: <SubIcon d={SubIcons.moon} size={15} />, onSelect: toggleTheme },
            { label: 'Sign out', icon: <SubIcon d={SubIcons.close} size={15} />, onSelect: onSignOut, danger: true, separated: true },
          ]}
        />
      }
    >
      {admin && <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />}
      <Page>
        {moved ? null : active === null ? (
          // A URL that is not a screen. Saying so beats silently rewriting the address bar: a
          // link that has moved is worth knowing about, not covering up.
          <EmptyState
            title="No such page"
            description={`Nothing is served at ${pathname}. It may have been a link to a screen that has since moved.`}
            action={
              <button className="btn primary" style={{ width: 'auto' }} onClick={() => navigate(home.path, { replace: true })}>
                Go to {home.label}
              </button>
            }
          />
        ) : user ? (
          // Keyed by the id, so going from one record to another is a remount and not a prop
          // change: everything a detail screen holds — the row, a secret it just rotated, a
          // form's unsaved fields — belongs to ONE record, and a late answer from the previous
          // one lands on an instance that no longer exists, which is the point. The tab is a
          // prop, not part of the key: moving between tabs of one record keeps its read.
          <UserDetailView key={user.id} userId={user.id} tab={user.tab} me={session.sub} />
        ) : app ? (
          <ApplicationDetailView key={app.id} clientId={app.id} tab={app.tab} />
        ) : conn ? (
          <ConnectionDetailView key={conn.id} id={conn.id} tab={conn.tab} issuer={disc?.issuer ?? null} />
        ) : logId !== null ? (
          <LogEntryView key={logId} id={logId} />
        ) : active.path === OVERVIEW_PATH ? (
          <OverviewView />
        ) : active.path === APPLICATIONS_PATH ? (
          <ClientsPanel />
        ) : active.path === APIS_PATH ? (
          <ApisView />
        ) : active.path === CONNECTIONS_PATH ? (
          <ConnectionsView issuer={disc?.issuer ?? null} />
        ) : active.path === SECURITY_PATH ? (
          <SecurityView />
        ) : active.path === USERS_PATH ? (
          <UsersView me={session.sub} />
        ) : active.path === LOGS_PATH ? (
          <LogsView />
        ) : active.path === SETTINGS_PATH ? (
          <SettingsView disc={disc} />
        ) : (
          <AccountView admin={admin} />
        )}
      </Page>
    </AppShell>
  );
}

/**
 * The top of the sidebar: what this is, and the one value every relying party is configured
 * with. One issuer per install, so where the dashboard has a team switcher this has a copy
 * button instead.
 */
function IssuerCard({ issuer }: { issuer: string | null }) {
  const [copied, setCopied] = useState(false);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '4px 10px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden>
          <rect x="3" y="4.5" width="18" height="4.5" rx="2.25" fill="var(--brand-400)" />
          <rect x="3" y="9.75" width="18" height="4.5" rx="2.25" fill="var(--brand-500)" />
          <rect x="3" y="15" width="18" height="4.5" rx="2.25" fill="var(--brand-700)" />
        </svg>
        <span style={{ fontSize: 15, fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--text-primary)' }}>Substrat Auth</span>
      </div>
      {issuer && (
        <button
          type="button"
          title="Copy the issuer URL"
          onClick={() => {
            void navigator.clipboard?.writeText(issuer).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
          style={{
            marginLeft: 20,
            padding: '2px 6px',
            alignSelf: 'flex-start',
            maxWidth: 'calc(100% - 20px)',
            border: 0,
            borderRadius: 6,
            background: 'transparent',
            color: 'var(--text-secondary)',
            fontSize: 12.5,
            cursor: 'pointer',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            textAlign: 'left',
          }}
        >
          {copied ? 'Copied' : new URL(issuer).host}
        </button>
      )}
    </div>
  );
}
