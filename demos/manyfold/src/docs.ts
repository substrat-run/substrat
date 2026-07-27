/**
 * The /api/docs page (design/api-surface.md §2.3): Scalar's API Reference over
 * this vertical's own /openapi.json, served from this vertical's own origin.
 *
 * Three deliberate absences:
 *   - no CDN — the renderer is the pinned @scalar/api-reference bundle, inlined
 *     by scripts/gen-assets.mjs and served as /assets/scalar-api-reference.js;
 *   - no proxy — same-origin requests need none, and tenant traffic (with its
 *     session cookie) must never transit Scalar's infrastructure;
 *   - no auth UI for the session path — try-it requests are same-origin, so the
 *     browser attaches the caller's own session cookie and every request
 *     executes as the logged-in principal. A 403 in the playground is the
 *     permission system working.
 */
export const DOCS_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Manyfold — API reference</title>
  <style>body { margin: 0 }</style>
</head>
<body>
  <div id="app"></div>
  <script src="/assets/scalar-api-reference.js"></script>
  <script>
    Scalar.createApiReference('#app', {
      url: '/openapi.json',
      hideClientButton: true,
    });
  </script>
</body>
</html>
`;
