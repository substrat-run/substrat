import type { ScopeId, TenantId } from '@substrat-run/contracts';
import type { ViewKey } from '../ConsoleShell';

/**
 * Navigation lives in the URL path — `/scopes`, `/verticals`, and one drilled-in
 * identifier (`/scopes/<id>`, `/tenants/<id>`, `/verticals/<slug>`) — so a refresh or
 * a shared link lands where you were, not back on the start page. Clean paths, not
 * `?view=` query params (the control-plane worker serves the SPA with
 * `not_found_handling: single-page-application`, so a deep path resolves on refresh).
 * The `actor` search param is left untouched (App's `useDevActor` owns it). Per-view
 * state (a filter tab, a text query) is not encoded, yet.
 *
 * Detail identifier per view: id for tenant and scope, slug for vertical.
 *
 * Parsing and building are pure functions of the URL so they can be tested without a
 * DOM; App holds the two-line `window`/`history` wrappers around them.
 */
export const VIEWS: ViewKey[] = [
  'tenants',
  'scopes',
  'domains',
  'verticals',
  'observability',
  'meters',
  'admin-log',
  'permissions',
  'members',
  'failures',
  'settings',
];

export interface Nav {
  view: ViewKey;
  tenant?: TenantId;
  scope?: ScopeId;
  vertical?: string;
}

export function parseNav(pathname: string, search: string): Nav {
  const segments = pathname.split('/').filter(Boolean);
  const first = segments[0];
  // Back-compat: an old `?view=` link (or a bare `/`) still resolves; navPath
  // then normalizes it to the path form on the next reflect.
  const legacy = new URLSearchParams(search).get('view');
  const candidate = first ?? legacy ?? undefined;
  const view = candidate && (VIEWS as string[]).includes(candidate) ? (candidate as ViewKey) : 'tenants';
  // Everything after the view is the identifier, not just the next segment: a
  // tenant-owned vertical's slug is `<tenantSlug>/<name>` (#417), so it carries a slash
  // of its own. Reading only `segments[1]` resolved `/verticals/acme/crm` to the slug
  // `acme`, which matches no vertical — so the deep link silently fell back to the list.
  // Decoding per segment means an encoded link (`/verticals/acme%2Fcrm`) lands on the
  // same slug as the plain one.
  const detail = segments.slice(1).map(decodeURIComponent).join('/') || undefined;
  const nav: Nav = { view };
  if (detail) {
    if (view === 'tenants') nav.tenant = detail as TenantId;
    else if (view === 'scopes') nav.scope = detail as ScopeId;
    else if (view === 'verticals') nav.vertical = detail;
  }
  return nav;
}

/** The path+search a view/detail pair should occupy, given the current search string. */
export function navPath(view: ViewKey, detail: string | undefined, search: string): { path: string; url: string } {
  // Each segment encoded separately: a slug's own `/` stays a path separator (parseNav
  // rejoins it), while anything else in an id is escaped rather than reshaping the path.
  const path = `/${[view, ...(detail ? detail.split('/') : [])].map(encodeURIComponent).join('/')}`;
  // Preserve the search so the dev `?actor=` override survives — but drop a legacy
  // `?view=` once we've read it into the path, so a back-compat link normalizes fully
  // to `/scopes` rather than lingering as `/scopes?view=scopes`.
  const p = new URLSearchParams(search);
  p.delete('view');
  const q = p.toString();
  return { path, url: `${path}${q ? `?${q}` : ''}` };
}
