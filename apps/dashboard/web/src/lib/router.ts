import { OBS_KEYS, type ObsQuery } from './observability-query';
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
 * A link into the team Observability page (#1447). Every narrowing is a query param
 * rather than a path segment because the page is team-level and they are filters on it:
 * the app narrows the whole page to one installation, `view` picks the sub-view, `type`
 * seeds the event explorer, and `from`/`to` are the time cursor — the ISO window a bar
 * or a marker click narrowed the logs to. Only what is set is written, so
 * `/observability` stays the page's own address.
 */
export function obsPath(
  q: ObsQuery = {},
): string {
  const p = new URLSearchParams();
  for (const k of OBS_KEYS) if (q[k]) p.set(k, q[k]!);
  const qs = p.toString();
  return `/observability${qs ? `?${qs}` : ''}`;
}

/**
 * Whether a click on a real-href anchor is one the SPA should take over: an unmodified
 * primary click. Cmd/Ctrl/Shift/Alt-click and the middle button belong to the browser
 * (new tab, new window, download), which is the whole reason the anchor has an href.
 */
export function isPlainClick(e: { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }): boolean {
  return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}

export function navigate(path: string): void {
  window.history.pushState(null, '', teamPath(path));
  window.dispatchEvent(new PopStateEvent('popstate'));
}
