/**
 * The console's dynamic paths, and nothing else.
 *
 * Split out of `routes.ts` — which is the same routing — for one reason: what is here has a
 * server-shaped duty and no React in it. `returnTarget` hands a path to an upstream provider as
 * `callbackURL` and reads it back out of a redirect, so the parsers below are the whole of what
 * stops "whatever was in the address bar" from riding through Google and back. Keeping them
 * free of `@substrat-run/ui` is what lets the issuer's own vitest — a `nodenext` program that
 * cannot compile a bundler-resolved TSX package — import and test them directly.
 *
 * The sections follow Auth0's dashboard (spec/console-redesign.md §3). A detail screen is
 * `/<section>/<id>` with an optional `/<tab>` from a FIXED list per screen, so a tab is a place
 * that survives a reload and a sign-in, and an unknown tab is not a place at all.
 */

export const OVERVIEW_PATH = '/';
export const APPLICATIONS_PATH = '/applications';
export const APIS_PATH = '/apis';
export const CONNECTIONS_PATH = '/connections';
export const SECURITY_PATH = '/security';
export const USERS_PATH = '/users';
export const LOGS_PATH = '/logs';
export const SETTINGS_PATH = '/settings';

/** The tabs of each detail screen, first one the default (and then left out of the URL). */
export const USER_TABS = ['details', 'identities', 'sessions', 'logs', 'raw'] as const;
export const APPLICATION_TABS = ['settings', 'connections', 'branding', 'logs', 'raw'] as const;
export const CONNECTION_TABS = ['settings', 'applications', 'raw'] as const;

export type UserTab = (typeof USER_TABS)[number];
export type ApplicationTab = (typeof APPLICATION_TABS)[number];
export type ConnectionTab = (typeof CONNECTION_TABS)[number];

export interface Detail<Tab extends string> {
  id: string;
  tab: Tab;
}

/**
 * The tail after an id: nothing (the default tab) or exactly one segment naming a tab on the
 * list. The default tab spelled out is accepted and means the same place; anything else is not one.
 */
function tabOf<Tab extends string>(tail: string | undefined, tabs: readonly Tab[]): Tab | null {
  if (tail === undefined) return tabs[0]!;
  return (tabs as readonly string[]).includes(tail) ? (tail as Tab) : null;
}

/**
 * `/users/<id>[/<tab>]`. Deliberately strict about the id's shape rather than accepting any
 * tail: it is interpolated into an API path AND is an open-redirect parameter by way of
 * `returnTarget`, so "url-safe id characters only" is the property both callers need. Better
 * Auth mints 32-character ids from that alphabet.
 */
export function userDetail(pathname: string): Detail<UserTab> | null {
  const match = /^\/users\/([A-Za-z0-9_-]{1,64})(?:\/([a-z-]{1,20}))?$/.exec(pathname);
  if (!match) return null;
  const tab = tabOf(match[2], USER_TABS);
  return tab ? { id: match[1]!, tab } : null;
}

/**
 * `/applications/<client id>[/<tab>]`. A wider alphabet than a user id for a narrow reason: a
 * client id is not always minted from the same one. This issuer's own console row is the
 * literal `console` (`src/console-client.ts`), a self-registering relying party may be given a
 * UUID, and both have to be a place. Dots and hyphens are added for those; the characters that
 * would make this a redirect rather than a path — `/`, `:`, `\`, `%` — still cannot appear,
 * because the pattern is anchored and names the alphabet rather than excluding one. An id of
 * nothing but dots is `.` or `..`, which a browser resolves away rather than visits, so it is
 * refused.
 */
export function applicationDetail(pathname: string): Detail<ApplicationTab> | null {
  const match = /^\/applications\/([A-Za-z0-9_.-]{1,128})(?:\/([a-z-]{1,20}))?$/.exec(pathname);
  if (!match || !/[A-Za-z0-9_-]/.test(match[1]!)) return null;
  const tab = tabOf(match[2], APPLICATION_TABS);
  return tab ? { id: match[1]!, tab } : null;
}

/**
 * `/connections/<id>[/<tab>]`. The NARROWEST alphabet, because the server's is narrow: a
 * connection id is `password` (the database), `bankid`, a catalogue slug (`google`, `github`,
 * …) or one an operator named a generic OIDC upstream, and `src/providers.ts`'s
 * `GENERIC_ID_PATTERN` accepts only lowercase letters, digits and interior hyphens up to 40
 * characters. Restated here rather than imported: this file is browser code and that one is the
 * issuer's server half. Restating it can only ever be too strict, never too loose.
 */
export function connectionDetail(pathname: string): Detail<ConnectionTab> | null {
  const match = /^\/connections\/([a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?)(?:\/([a-z-]{1,20}))?$/.exec(pathname);
  if (!match) return null;
  const tab = tabOf(match[2], CONNECTION_TABS);
  return tab ? { id: match[1]!, tab } : null;
}

/** `/logs/<id>` — a log row's id is the table's integer key, so digits only. */
export function logEntryId(pathname: string): number | null {
  const match = /^\/logs\/([1-9][0-9]{0,15})$/.exec(pathname);
  return match ? Number(match[1]) : null;
}

/** The URL of a detail tab; the default tab is the bare detail URL. */
export function userPath(id: string, tab: UserTab = 'details'): string {
  return tab === USER_TABS[0] ? `${USERS_PATH}/${id}` : `${USERS_PATH}/${id}/${tab}`;
}
export function applicationPath(id: string, tab: ApplicationTab = 'settings'): string {
  return tab === APPLICATION_TABS[0] ? `${APPLICATIONS_PATH}/${id}` : `${APPLICATIONS_PATH}/${id}/${tab}`;
}
export function connectionPath(id: string, tab: ConnectionTab = 'settings'): string {
  return tab === CONNECTION_TABS[0] ? `${CONNECTIONS_PATH}/${id}` : `${CONNECTIONS_PATH}/${id}/${tab}`;
}
export function logEntryPath(id: number): string {
  return `${LOGS_PATH}/${id}`;
}

/**
 * The detail screen this path is, re-composed from what it parsed — or null if it is not one.
 *
 * Re-built rather than returned as given, deliberately: what leaves here is a string this file
 * assembled from an id it just checked, not the one the address bar handed over, so there is no
 * tail of the input left to smuggle anything through.
 */
export function detailTarget(pathname: string): string | null {
  const user = userDetail(pathname);
  if (user) return userPath(user.id, user.tab);
  const app = applicationDetail(pathname);
  if (app) return applicationPath(app.id, app.tab);
  const conn = connectionDetail(pathname);
  if (conn) return connectionPath(conn.id, conn.tab);
  const log = logEntryId(pathname);
  if (log !== null) return logEntryPath(log);
  return null;
}

/**
 * Where a URL from before the regroup lives now (#1278's sections → Auth0's). Bookmarks and
 * links pasted into support threads outlive a nav change, so each old place is redirected
 * rather than answered with "no such page". Re-composed from parsed parts like `detailTarget`.
 */
export function legacyTarget(pathname: string): string | null {
  switch (pathname) {
    case '/providers':
      return CONNECTIONS_PATH;
    case '/bankid':
    case '/bankid/settings':
      return connectionPath('bankid');
    case '/access':
      return SECURITY_PATH;
    case '/sign-in-log':
      return LOGS_PATH;
    case '/issuer':
      return SETTINGS_PATH;
  }
  const provider = /^\/providers\/([a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?)$/.exec(pathname);
  return provider ? connectionPath(provider[1]!) : null;
}
