import { useEffect, useRef, useState } from 'react';
import { EmptyState, IconButton, SideNav, SubIcon, SubIcons, useMediaQuery } from '@substrat-run/ui';
import type { SideNavSection } from '@substrat-run/ui';
import { discovery, type Discovery, type Session } from '../api';
import { AccessPanel } from '../views/Access';
import { AccountView } from '../views/Account';
import { ApplicationDetailView } from '../views/ApplicationDetail';
import { ClientsPanel } from '../views/Applications';
import { BankIdPanel } from '../views/BankId';
import { BankIdDetailView } from '../views/BankIdDetail';
import { IssuerPanel } from '../views/Issuer';
import { ProviderDetailView } from '../views/ProviderDetail';
import { ProvidersPanel } from '../views/Providers';
import { UserDetailView } from '../views/UserDetail';
import { UsersView } from '../views/Users';
import { navigate, usePathname } from './router';
import {
  APPLICATIONS_PATH,
  BANKID_PATH,
  PROVIDERS_PATH,
  ROUTES,
  USERS_PATH,
  applicationDetailId,
  isBankIdSettingsPath,
  providerDetailId,
  userDetailId,
} from './routes';
// (`console.css` is imported from main.tsx, not here: its load ORDER relative to tokens.css
//  decides which set wins the property they share, and only main.tsx can guarantee it.)

function sectionsFor(admin: boolean): SideNavSection[] {
  const visible = ROUTES.filter((r) => admin || !r.adminOnly);
  const groups: SideNavSection[] = [];
  for (const route of visible) {
    let section = groups.find((g) => g.title === route.group);
    if (!section) groups.push((section = { title: route.group, items: [] }));
    // `href` as well as `value`: the screen HAS a URL, so the nav item should be a link a
    // browser can copy, open in a tab, or middle-click. `onSelect` still handles the plain
    // click, so a normal navigation stays same-document.
    section.items.push({ value: route.path, href: route.path, label: route.label, icon: <SubIcon d={route.icon} /> });
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
  // Below this the sidebar becomes an overlay rather than a column — see console.css.
  const compact = useMediaQuery('(max-width: 900px)');
  const [navOpen, setNavOpen] = useState(false);
  const navRef = useRef<HTMLElement>(null);
  const menuRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // The issuer's own metadata: `ProvidersPanel` shows the callback URL an upstream has to
    // be given, and `IssuerPanel` shows the document itself. One read, two screens.
    void discovery().then(setDisc);
  }, []);

  // Never leave the drawer latched open when the layout goes back to a column — it would
  // render on top of the content it is already beside.
  useEffect(() => {
    if (!compact) setNavOpen(false);
  }, [compact]);

  // An opened drawer takes focus, Escape closes it, and closing gives focus back to the
  // trigger. Without the first of those the nav is visible but unreachable: it sits BEFORE
  // the trigger in DOM order, so Tab from the hamburger walks into the page behind the scrim
  // instead of into the navigation that just appeared. Without the last, focus is left on an
  // element that closing has just made `visibility: hidden`, and the next Tab starts over at
  // the top of the document.
  useEffect(() => {
    if (!compact || !navOpen) return;
    navRef.current?.querySelector<HTMLElement>('a[href], button')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setNavOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      // All three ways out — Escape, the scrim, picking a section — end with the drawer gone
      // and the hamburger the thing on screen that opened it. `menuRef` is null once the
      // layout is wide again, and then there is nothing to return to.
      menuRef.current?.focus();
    };
  }, [compact, navOpen]);

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
  const bankIdSettings = visible.some((r) => r.path === BANKID_PATH) && isBankIdSettingsPath(pathname);
  const active =
    visible.find((r) => r.path === pathname) ??
    (userId ? visible.find((r) => r.path === USERS_PATH)! : null) ??
    (clientId ? visible.find((r) => r.path === APPLICATIONS_PATH)! : null) ??
    (providerId ? visible.find((r) => r.path === PROVIDERS_PATH)! : null) ??
    (bankIdSettings ? visible.find((r) => r.path === BANKID_PATH)! : null) ??
    (pathname === '/' ? home : null);

  useEffect(() => {
    // Replace rather than push: the back button should not have to step through a redirect
    // that was never a place the person had been.
    if (pathname === '/') navigate(home.path, { replace: true });
  }, [pathname, home]);

  return (
    // The dark stratum: the panels underneath are dark, so the branded tokens are asked for
    // their dark values rather than being fought. `color-scheme` follows, or the browser
    // draws light scrollbars and light native controls inside a dark page.
    <div className="console-root" data-theme="dark" style={{ colorScheme: 'dark' }}>
      {compact && navOpen && <div className="console-scrim" onClick={() => setNavOpen(false)} />}
      <SideNav
        ref={navRef}
        sections={sectionsFor(admin)}
        activeValue={active?.path}
        onSelect={(path) => {
          navigate(path);
          setNavOpen(false);
        }}
        style={
          compact
            ? {
                position: 'fixed',
                insetBlock: 0,
                left: 0,
                zIndex: 31,
                transform: navOpen ? 'translateX(0)' : 'translateX(-100%)',
                // `visibility`, not the transform alone: an off-canvas nav that is merely
                // translated is still in the tab order, so a keyboard user would tab into
                // links they cannot see.
                visibility: navOpen ? 'visible' : 'hidden',
                transition: 'transform var(--duration-fast) var(--ease-out), visibility var(--duration-fast)',
                boxShadow: navOpen ? 'var(--shadow-lg)' : 'none',
              }
            : undefined
        }
        header={
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 10px 12px' }}>
            <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden>
              <rect x="3" y="4.5" width="18" height="4.5" rx="2.25" fill="var(--brand-400)" />
              <rect x="3" y="9.75" width="18" height="4.5" rx="2.25" fill="var(--brand-500)" />
              <rect x="3" y="15" width="18" height="4.5" rx="2.25" fill="var(--brand-700)" />
            </svg>
            <span style={{ fontWeight: 'var(--weight-semibold)', letterSpacing: 'var(--tracking-tight)' }}>
              Substrat Auth
            </span>
          </div>
        }
        footer={
          <div style={{ marginTop: 'auto', padding: '10px', borderTop: '1px solid var(--border-subtle)' }}>
            <div style={{ color: 'var(--text-tertiary)', fontSize: 'var(--text-xs)', overflowWrap: 'anywhere' }}>
              {session.email}
            </div>
            <button className="btn link" style={{ padding: '6px 0 0', textAlign: 'left' }} onClick={onSignOut}>
              Sign out
            </button>
          </div>
        }
      />
      <div className="console-main">
        <header className="console-topbar">
          {compact && (
            <IconButton ref={menuRef} label="Open navigation" onClick={() => setNavOpen(true)}>
              <SubIcon d={SubIcons.menu} />
            </IconButton>
          )}
          <h1>{active?.label ?? 'Not found'}</h1>
          <div className="spacer" />
          {/* Who you are signed in as lives in the nav footer — which is off-canvas below
              900px, so on a narrow screen the topbar carries it instead of nowhere. */}
          {compact && <span className="who">{session.email}</span>}
        </header>
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
          ) : active.path === '/bankid' ? (
            <BankIdPanel />
          ) : active.path === '/access' ? (
            <AccessPanel />
          ) : active.path === '/issuer' ? (
            <IssuerPanel disc={disc} />
          ) : (
            <AccountView admin={admin} />
          )}
        </div>
      </div>
    </div>
  );
}
