import { SubIcons } from '@substrat-run/ui';
import {
  APIS_PATH,
  APPLICATIONS_PATH,
  CONNECTIONS_PATH,
  LOGS_PATH,
  OVERVIEW_PATH,
  SECURITY_PATH,
  SETTINGS_PATH,
  USERS_PATH,
  detailTarget,
  legacyTarget,
} from './paths';

// Re-exported so the console's routing is still one import for the screens that read it — the
// split in `paths.ts` is about what a test can reach, not about where a caller should look.
export * from './paths';

/**
 * Lucide `circle-user`. `@substrat-run/ui` has `users` (a group) but no single-person icon,
 * and "Your account" is emphatically not the directory — borrowing the group glyph would say
 * the wrong thing in the one place a non-administrator ever looks. Inlined rather than added
 * to the package: this app is the only caller so far, and a shared icon set earns an entry
 * from a second one.
 */
export const ICON_ACCOUNT =
  '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="10" r="3"/><path d="M7 20.7a8 8 0 0 1 10 0"/>';

/** Lucide `shield` — Security. Inlined for the same reason as the account glyph. */
const ICON_SHIELD =
  '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>';

/** Lucide `plug` — Connections: the sources of identities an application is plugged into. */
const ICON_PLUG =
  '<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/>';

/** Where the account menu's "Your account" goes — the one screen everyone who signs in has. */
export const ACCOUNT_PATH = '/account';

export interface Route {
  path: string;
  label: string;
  icon: string;
  /** Which nav group it sits in; absent for an ungrouped item. Order of first appearance is the order on screen. */
  group?: string;
  /** False for the one screen an ordinary person of this issuer reaches. */
  adminOnly: boolean;
  /**
   * Shown in the sidebar only to someone who is not an administrator. An administrator reaches
   * "Your account" from the account menu, as on the dashboard; for anyone else it is the whole
   * console, and a console with an empty sidebar would read as broken.
   */
  navForNonAdminOnly?: boolean;
}

/**
 * The route table, in Auth0's order (spec/console-redesign.md §3): what applications exist,
 * how people authenticate into them, who those people are, what happened, and the issuer's own
 * settings. Three placements are calls rather than inheritances:
 *
 * - **Connections** is one list over three stores that grew apart — the upstream providers,
 *   BankID, and the password database. "A source of identities an application is enabled for"
 *   is the one idea all three are, and Auth0's operators look for it under that name.
 * - **Security** holds what is about every connection at once (how accounts are linked). The
 *   sign-up switch moved onto the database connection, which is the thing it switches.
 * - **Logs** keeps its place beside the things it explains, under Monitoring.
 *
 * It lives in its own module, apart from the console that renders it, because the SIGNED-OUT
 * screens need it too: `returnTarget` below is the only thing that decides where signing in
 * lands, and the sign-in screen must not have to import the console to ask.
 */
export const ROUTES: Route[] = [
  { path: OVERVIEW_PATH, label: 'Overview', icon: SubIcons.grid, adminOnly: true },
  { path: APPLICATIONS_PATH, label: 'Applications', icon: SubIcons.layers, group: 'Applications', adminOnly: true },
  { path: APIS_PATH, label: 'APIs', icon: SubIcons.box, group: 'Applications', adminOnly: true },
  { path: CONNECTIONS_PATH, label: 'Connections', icon: ICON_PLUG, group: 'Authentication', adminOnly: true },
  { path: SECURITY_PATH, label: 'Security', icon: ICON_SHIELD, group: 'Authentication', adminOnly: true },
  { path: USERS_PATH, label: 'Users', icon: SubIcons.users, group: 'User management', adminOnly: true },
  { path: LOGS_PATH, label: 'Logs', icon: SubIcons.scroll, group: 'Monitoring', adminOnly: true },
  { path: SETTINGS_PATH, label: 'Settings', icon: SubIcons.cog, group: 'Issuer', adminOnly: true },
  { path: ACCOUNT_PATH, label: 'Your account', icon: ICON_ACCOUNT, group: 'You', adminOnly: false, navForNonAdminOnly: true },
];

/**
 * Where to come back to once this person is authenticated: the console screen they actually
 * asked for, or `/`.
 *
 * Kept as an **allowlist**, because this value is handed to an upstream provider as
 * `callbackURL` and comes back through a redirect, so "whatever was in the address bar" would be
 * an open-redirect parameter with a round trip through Google attached. Only a path this table
 * names, a detail URL `paths.ts` recognised by parsing it, or a pre-regroup URL `legacyTarget`
 * maps forward survives; the four OIDC hand-off paths (`/login`, `/signup`, `/consent`,
 * `/reset-password`) are none of those — they are where the browser already is, never where it
 * should be sent next.
 */
export function returnTarget(pathname: string): string {
  if (ROUTES.some((r) => r.path === pathname)) return pathname;
  return legacyTarget(pathname) ?? detailTarget(pathname) ?? OVERVIEW_PATH;
}
