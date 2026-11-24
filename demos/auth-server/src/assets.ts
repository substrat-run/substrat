import { ASSETS } from './assets.generated.js';

/**
 * Serve the SPA from the worker itself (scope-local-permissions.md Phase 3).
 *
 * A pushed, sandbox-clean vertical has no `ASSETS` binding — WfP static assets are a
 * separate upload path, so the built SPA is inlined into `assets.generated.ts` (by
 * scripts/gen-assets.mjs) and served straight from the worker. This is the catch-all
 * behind the /api/* routes: an exact file hit is served; any other path (a client
 * route like /apps/123) falls back to index.html so deep links resolve. A missing
 * file *with* an extension is a real 404, not an SPA fallback.
 */
const decodeBase64 = (b64: string): Uint8Array =>
  Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));

export function serveAsset(url: URL): Response {
  const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
  const exact = ASSETS[pathname];
  if (exact) {
    const body = exact.encoding === 'base64' ? decodeBase64(exact.body) : exact.body;
    return new Response(body, { headers: { 'content-type': exact.type } });
  }
  // A path that looks like a file (has an extension) and wasn't found is a 404;
  // everything else is a client route → the SPA shell decides what to render.
  const looksLikeFile = /\.[a-z0-9]+$/i.test(pathname);
  const index = ASSETS['/index.html'];
  if (looksLikeFile || !index) return new Response('not found', { status: 404 });
  return new Response(index.body, { headers: { 'content-type': index.type } });
}

/** The built SPA's `index.html`, which a page template's tags are cut from (`page-template.ts`). */
export function indexHtml(): string | undefined {
  return ASSETS['/index.html']?.body;
}
