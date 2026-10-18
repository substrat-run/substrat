---
"@substrat-run/vertical-auth": patch
"@substrat-run/vertical-host": patch
---

Every `405` the MCP endpoint answers carries `Allow: POST`, as RFC 9110 requires, so a client can learn which method is served there.

A delivered `audience` is checked on a delegated token too, so one that is not the MCP endpoint's resource admits no delegated token. That still fails closed. The bearer verifier now logs a warning when a host that opted in to delegation on a shared issuer has a delivered `audience` and the MCP endpoint's channel names another resource. It warns once per isolate for each issuer and audience, and names the field, not its value.

The MCP endpoint's mount-time check now judges earlier routes against the path the endpoint really answers at, including an `app.basePath()` prefix, and runs before `mountOperations` or `mountMcp` registers anything, so a refused mount leaves the app as it was. That includes a mount refused for one of its own operations, or for an operation no registered module provides. The error names the mount that raised it. A route on a `basePath` app that would answer there now throws at mount, and a root route at the unprefixed path no longer does, since it is not in the way. A `*` is now judged as Hono's `TrieRouter` reads it, wherever it is. So a route with a `*` segment that reaches the endpoint's path, registered before the mount with a method, now throws at mount as well. That covers `*`, `/*`, `/api/*`, `/api/mcp/*` and `/*/mcp`, and a `GET *` fallback among them. #2398 skipped these. Register such a route after the mount, or as middleware: `app.use` and `app.all` are still not judged. A `*` segment that misses the path, such as `/other/*`, is not refused, and `/api/mc*` still is. Not judged, and stated: the routes of an app this one is later mounted into with `app.route()`, and the mid-segment `*` forms that the default router dispatches there and `TrieRouter` does not match, such as `/api/*cp`.
