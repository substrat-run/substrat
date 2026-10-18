---
"@substrat-run/vertical-auth": patch
"@substrat-run/vertical-host": patch
---

Every `405` the MCP endpoint answers carries `Allow: POST`, as RFC 9110 requires, so a client can learn which method is served there.

A delivered `audience` is checked on a delegated token too, so one that is not the MCP endpoint's resource admits no delegated token. That still fails closed. The bearer verifier now logs a warning when a host that opted in to delegation on a shared issuer has a delivered `audience` and the MCP endpoint's channel names another resource. It warns once per isolate for each issuer and audience, and names the field, not its value.

The MCP endpoint's mount-time check now judges earlier routes against the path the endpoint really answers at, including an `app.basePath()` prefix, and runs before `mountOperations` or `mountMcp` registers anything, so a refused mount leaves the app as it was. That includes a mount refused for one of its own operations, or for an operation no registered module provides. The error names the mount that raised it. A route on a `basePath` app that would answer there now throws at mount, and a root route at the unprefixed path no longer does, since it is not in the way. Not judged, and stated: a pattern with a segment that is exactly `*` (a catch-all), and the routes of an app this one is later mounted into with `app.route()`. Any other `*` is judged as Hono's `TrieRouter` reads it, so `/api/mc*` still refuses the mount. The default router also dispatches some mid-segment forms that `TrieRouter` does not match, such as `/api/*cp`; those are not refused.
