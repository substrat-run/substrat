/**
 * Client navigation for the History-API router. The dashboard runs on real paths
 * (`/verticals`, `/apps/<id>/overview`) rather than hash fragments — the worker's
 * `single-page-application` asset fallback serves index.html for any non-`/api` path,
 * so a deep link or refresh resolves server-side and the client router takes over here.
 *
 * Every route is scoped to a team by its first path segment (`/<team-slug>/apps`).
 * `App` pins the active slug here once the session resolves, and `navigate()` (plus
 * `teamPath()` for anchors' real hrefs) prefixes it onto app-relative paths — call
 * sites keep writing `/apps/<id>` and never carry the team themselves. `/invite/…`
 * links are team-less by design (the token itself says where to accept).
 *
 * `pushState` alone doesn't notify listeners, so we dispatch a synthetic `popstate` —
 * the same event the Back/Forward buttons fire — and `App` re-parses the location from
 * its single `popstate` handler. Anchors that call this should keep a real `href` (for
 * middle-click / open-in-new-tab) and `preventDefault()` the left-click.
 */

let teamSlug: string | null = null;

/** Pin the active team's slug; `navigate()`/`teamPath()` prefix it from here on. */
export function setTeamSlug(slug: string | null): void {
  teamSlug = slug;
}

/** `/apps/x` → `/<team>/apps/x`. Team-less until the session resolves; `/invite/…` stays bare. */
export function teamPath(path: string): string {
  if (!teamSlug || path.startsWith('/invite/') || path === `/${teamSlug}` || path.startsWith(`/${teamSlug}/`)) return path;
  return `/${teamSlug}${path === '/' ? '' : path}`;
}

/**
 * A link into the team Observability page (#1447). All three narrowings are query
 * params rather than path segments because the page is team-level and they are filters
 * on it: the app narrows the whole page to one installation, `view` picks the sub-view,
 * and `type` seeds the event explorer. Only what is set is written, so `/observability`
 * stays the page's own address.
 */
export function obsPath(q: { app?: string; view?: string; type?: string } = {}): string {
  const p = new URLSearchParams();
  if (q.app) p.set('app', q.app);
  if (q.view) p.set('view', q.view);
  if (q.type) p.set('type', q.type);
  const qs = p.toString();
  return `/observability${qs ? `?${qs}` : ''}`;
}

export function navigate(path: string): void {
  window.history.pushState(null, '', teamPath(path));
  window.dispatchEvent(new PopStateEvent('popstate'));
}
