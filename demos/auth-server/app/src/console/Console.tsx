import { useEffect, useState } from 'react';
import { EmptyState, IconButton, SideNav, SubIcon, SubIcons, useMediaQuery } from '@substrat-run/ui';
import type { SideNavSection } from '@substrat-run/ui';
import { discovery, type Discovery, type Session } from '../api';
import { AccessPanel } from '../views/Access';
import { AccountView } from '../views/Account';
import { ClientsPanel } from '../views/Applications';
import { BankIdPanel } from '../views/BankId';
import { IssuerPanel } from '../views/Issuer';
import { ProvidersPanel } from '../views/Providers';
import { UsersView } from '../views/Users';
import { navigate, usePathname } from './router';
// (`console.css` is imported from main.tsx, not here: its load ORDER relative to tokens.css
//  decides which set wins the property they share, and only main.tsx can guarantee it.)

/**
 * Lucide `circle-user`. `@substrat-run/ui` has `users` (a group) but no single-person icon,
 * and "Your account" is emphatically not the directory — borrowing the group glyph would say
 * the wrong thing in the one place a non-administrator ever looks. Inlined rather than added
 * to the package: this app is the only caller so far, and a shared icon set earns an entry
 * from a second one.
 */
const ICON_ACCOUNT =
  '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="10" r="3"/><path d="M7 20.7a8 8 0 0 1 10 0"/>';

interface Route {
  path: string;
  label: string;
  icon: string;
  /** Which nav group it sits in — the order of first appearance is the order on screen. */
  group: string;
  /** False for the one screen an ordinary person of this issuer reaches. */
  adminOnly: boolean;
}

/**
 * The route table. Two groupings are deliberate rather than inherited from the order the
 * panels happened to grow in:
 *
 * - **BankID is a sign-in method, beside the OAuth providers** — not a section of its own
 *   because it is exotic. It is separate from "Sign-in providers" only because it is
 *   configured on completely different terms (an mTLS certificate and an environment, no
 *   client id and no redirect URI to register), so one editor could not serve both.
 * - **Access sits with them, not with the issuer's settings.** It reads as a lone toggle
 *   between two registries today; it is in fact the answer to "who may get in at all",
 *   which is the same question the providers list answers one upstream at a time.
 */
const ROUTES: Route[] = [
  { path: '/users', label: 'Users', icon: SubIcons.users, group: 'Directory', adminOnly: true },
  { path: '/applications', label: 'Applications', icon: SubIcons.layers, group: 'Directory', adminOnly: true },
  { path: '/providers', label: 'Sign-in providers', icon: SubIcons.globe, group: 'Sign-in', adminOnly: true },
  { path: '/bankid', label: 'BankID', icon: SubIcons.box, group: 'Sign-in', adminOnly: true },
  { path: '/access', label: 'Access', icon: SubIcons.sliders, group: 'Sign-in', adminOnly: true },
  { path: '/issuer', label: 'Issuer', icon: SubIcons.cog, group: 'Issuer', adminOnly: true },
  { path: '/account', label: 'Your account', icon: ICON_ACCOUNT, group: 'You', adminOnly: false },
];

function sectionsFor(admin: boolean): SideNavSection[] {
  const visible = ROUTES.filter((r) => admin || !r.adminOnly);
  const groups: SideNavSection[] = [];
  for (const route of visible) {
    let section = groups.find((g) => g.title === route.group);
    if (!section) groups.push((section = { title: route.group, items: [] }));
    section.items.push({ value: route.path, label: route.label, icon: <SubIcon d={route.icon} /> });
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

  const visible = ROUTES.filter((r) => admin || !r.adminOnly);
  // `/account` is `adminOnly: false`, so this list is never empty for either audience — the
  // fallback only exists because the type cannot say so.
  const home = visible[0] ?? ROUTES[ROUTES.length - 1]!;
  // `/` is where signing in leaves you, and it is not a screen. Resolved here rather than
  // only in the effect below, so the first frame is the section rather than a "no such page"
  // that corrects itself.
  const active = visible.find((r) => r.path === pathname) ?? (pathname === '/' ? home : null);

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
            <IconButton label="Open navigation" onClick={() => setNavOpen(true)}>
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
