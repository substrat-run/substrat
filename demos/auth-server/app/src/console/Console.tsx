import { useEffect, useState } from 'react';
import { AccountMenu, AppShell, EmptyState, SubIcon, SubIcons } from '@substrat-run/ui';
import type { AppShellCrumb, AppShellNavGroup } from '@substrat-run/ui';
import { discovery, type Discovery, type Session } from '../api';
import { AccessPanel } from '../views/Access';
import { AccountView } from '../views/Account';
import { ApplicationDetailView } from '../views/ApplicationDetail';
import { ClientsPanel } from '../views/Applications';
import { BankIdDetailView } from '../views/BankIdDetail';
import { IssuerPanel } from '../views/Issuer';
import { ProviderDetailView } from '../views/ProviderDetail';
import { ProvidersPanel } from '../views/Providers';
import { SignInLogView } from '../views/SignInLog';
import { UserDetailView } from '../views/UserDetail';
import { UsersView } from '../views/Users';
import { navigate, usePathname } from './router';
import { useConsoleTheme } from './theme';
import {
  ACCOUNT_PATH,
  APPLICATIONS_PATH,
  BANKID_PATH,
  PROVIDERS_PATH,
  ICON_ACCOUNT,
  ROUTES,
  USERS_PATH,
  applicationDetailId,
  isBankIdSettingsPath,
  providerDetailId,
  userDetailId,
} from './routes';
// (`console.css` is imported from main.tsx, not here: its load ORDER relative to tokens.css
//  decides which set wins the property they share, and only main.tsx can guarantee it.)

function groupsFor(admin: boolean): AppShellNavGroup[] {
  const visible = ROUTES.filter((r) => admin || !r.adminOnly);
  const groups: AppShellNavGroup[] = [];
  for (const route of visible) {
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

  useEffect(() => {
    // The issuer's own metadata: `ProvidersPanel` shows the callback URL an upstream has to
    // be given, and `IssuerPanel` shows the document itself. One read, two screens.
    void discovery().then(setDisc);
  }, []);

  const visible = ROUTES.filter((r) => admin || !r.adminOnly);
  // `/account` is `adminOnly: false`, so this list is never empty for either audience — the
  // fallback only exists because the type cannot say so.
  const home = visible[0] ?? ROUTES[ROUTES.length - 1]!;
  // `/` is where signing in leaves you, and it is not a screen. Resolved here rather than
  // only in the effect below, so the first frame is the section rather than a "no such page"
  // that corrects itself.
  // `/users/<id>`, `/applications/<client id>`, `/providers/<provider id>` and
  // `/bankid/settings` are screens under their section rather than sections of their own: the
  // nav keeps the section lit, and only an administrator can be on any of them — every one is
  // read after the permission filter, so a non-administrator pasting one gets the "no such page"
  // answer the nav's own courtesy already implies.
  const userId = visible.some((r) => r.path === USERS_PATH) ? userDetailId(pathname) : null;
  const clientId = visible.some((r) => r.path === APPLICATIONS_PATH) ? applicationDetailId(pathname) : null;
  const providerId = visible.some((r) => r.path === PROVIDERS_PATH) ? providerDetailId(pathname) : null;
  // BankID's second screen carries no id — there is one configuration per issuer — so this is
  // the only one of the four that is a path rather than something parsed out of one.
  const bankIdSettings = visible.some((r) => r.path === PROVIDERS_PATH) && isBankIdSettingsPath(pathname);
  const bankIdRoute = bankIdSettings || pathname === BANKID_PATH
    ? visible.find((r) => r.path === PROVIDERS_PATH)
    : undefined;
  const active =
    visible.find((r) => r.path === pathname) ??
    (userId ? visible.find((r) => r.path === USERS_PATH)! : null) ??
    (clientId ? visible.find((r) => r.path === APPLICATIONS_PATH)! : null) ??
    (providerId ? visible.find((r) => r.path === PROVIDERS_PATH)! : null) ??
    bankIdRoute ??
    (pathname === '/' ? home : null);

  useEffect(() => {
    // Replace rather than push: the back button should not have to step through a redirect
    // that was never a place the person had been.
    if (pathname === '/') navigate(home.path, { replace: true });
    if (admin && pathname === BANKID_PATH) navigate(PROVIDERS_PATH, { replace: true });
  }, [pathname, home, admin]);

  // Issuer › Section › Item. The issuer is the root because it is what this console is OF —
  // the dashboard's crumbs start at the team for the same reason.
  const issuerHost = disc ? new URL(disc.issuer).host : window.location.host;
  const crumbs: AppShellCrumb[] = [{ label: issuerHost, href: home.path, onClick: () => navigate(home.path) }];
  if (active) crumbs.push({ label: active.label, href: active.path, onClick: () => navigate(active.path) });
  const detail = userId ?? clientId ?? providerId ?? (bankIdSettings ? 'Settings' : null);
  if (detail) crumbs.push({ label: detail });
  if (!active) crumbs.push({ label: 'Not found' });

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
        <div className="console-content">
          {active === null ? (
            // A URL that is not a screen. Saying so beats silently rewriting the address
            // bar: a link that has moved is worth knowing about, not covering up.
            <EmptyState
              title="No such page"
              description={`Nothing is served at ${pathname}. It may have been a link to a screen that has since moved.`}
              action={
                <button className="btn primary" style={{ width: 'auto' }} onClick={() => navigate(home.path, { replace: true })}>
                  Go to {home.label}
                </button>
              }
            />
          ) : userId ? (
            <UserDetailView userId={userId} me={session.sub} />
          ) : clientId ? (
            // Keyed by the id, so going from one application to another is a remount and not a
            // prop change. Everything that screen holds belongs to ONE client — the row itself,
            // a secret it just rotated, the form's unsaved fields — and a prop change would
            // leave all of it on screen above the next application's header while its read is
            // still in flight. A late answer from the previous one lands on an instance that no
            // longer exists, which is the point.
            <ApplicationDetailView key={clientId} clientId={clientId} />
          ) : providerId ? (
            // Keyed for the same reason: a provider's screen holds ONE upstream's client id,
            // secret field and three toggles, and a prop change would leave them on screen
            // above the next provider's header — with a Save button that would write them to
            // the wrong row.
            <ProviderDetailView key={providerId} providerId={providerId} issuer={disc?.issuer ?? null} />
          ) : bankIdSettings ? (
            // No key: there is exactly one BankID configuration, so there is no other one to
            // move to and nothing a prop change could carry across.
            <BankIdDetailView />
          ) : active.path === '/users' ? (
            <UsersView me={session.sub} />
          ) : active.path === '/applications' ? (
            <ClientsPanel />
          ) : active.path === '/providers' ? (
            <ProvidersPanel issuer={disc?.issuer ?? null} />
          ) : active.path === '/access' ? (
            <AccessPanel />
          ) : active.path === '/sign-in-log' ? (
            <SignInLogView />
          ) : active.path === '/issuer' ? (
            <IssuerPanel disc={disc} />
          ) : (
            <AccountView admin={admin} />
          )}
        </div>
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
            marginLeft: 26,
            padding: '2px 6px',
            alignSelf: 'flex-start',
            maxWidth: 'calc(100% - 26px)',
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
