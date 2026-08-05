/**
 * Client navigation for the History-API router. The dashboard runs on real paths
 * (`/verticals`, `/apps/<id>/overview`) rather than hash fragments — the worker's
 * `single-page-application` asset fallback serves index.html for any non-`/api` path,
 * so a deep link or refresh resolves server-side and the client router takes over here.
 *
 * `pushState` alone doesn't notify listeners, so we dispatch a synthetic `popstate` —
 * the same event the Back/Forward buttons fire — and `App` re-parses the location from
 * its single `popstate` handler. Anchors that call this should keep a real `href` (for
 * middle-click / open-in-new-tab) and `preventDefault()` the left-click.
 */
export function navigate(path: string): void {
  window.history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}
