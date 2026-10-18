---
"@substrat-run/vertical-auth": patch
"@substrat-run/vertical-host": patch
---

Every `405` the MCP endpoint answers carries `Allow: POST`, as RFC 9110 requires, so a client can learn which method is served there.

A delivered `audience` is checked on a delegated token too, so one that is not the MCP endpoint's resource admits no delegated token. That still fails closed. The bearer verifier now logs a warning when a host that opted in to delegation on a shared issuer has a delivered `audience` and the MCP endpoint's channel names another resource. It warns once per isolate for each issuer and audience, and names the field, not its value.

The MCP endpoint's mount-time check now judges earlier routes against the path the endpoint really answers at, including an `app.basePath()` prefix. A route on a `basePath` app that would answer there now throws at mount, and a root route at the unprefixed path no longer does, since it is not in the way.

Every refusal of a mount is now judged before `mountOperations` or `mountMcp` registers anything, so a refused mount leaves the app as it was. That covers a route already at the endpoint's path, one of the mount's own operations there, an operation no registered module provides, and two operations whose names render as one MCP tool name (such as `desk/a.b` and `desk/a/b`). The error names the mount that raised it.

**Behaviour change:** a `*` is now judged as Hono's `TrieRouter` reads it, wherever it is. #2398 skipped every pattern with a segment that is exactly `*`. Now a route with a `*` segment that `TrieRouter` dispatches to the endpoint's path throws at mount when it is registered before the mount with a method. That covers `*`, `/*`, `/api/*`, `/api/mcp/*`, `/*/mcp` and `/*/*`, so a `GET *` fallback is among them. A `*` segment that misses the path, such as `/other/*`, is not refused, and `/api/mc*` still is.

Remedy, one line: register the fallback after the mount (`mountOperations(app, …)` first, then `app.get('*', …)`), or make it middleware (`app.use('*', …)`, which is not judged) that answers only once `await next()` has found nothing.

Not judged, and stated:
- `app.use`, `app.all` and `app.mount`, and `OPTIONS` routes.
- The routes of an app this one is later mounted into with `app.route()`.
- The `*` forms that the default router dispatches there and `TrieRouter` does not match. Hono's routers do not all agree on `*`, so these are not refused: a `*` inside a segment, such as `/api/*cp`, and a pattern ending in two or more `*` segments that reaches the path only if its last `*` matches nothing, such as `/api/*/*` or `/*/*/*` (`/*/*` matches `/api/mcp` segment for segment, and is refused).
