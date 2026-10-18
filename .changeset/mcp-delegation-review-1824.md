---
"@substrat-run/vertical-auth": patch
"@substrat-run/vertical-host": patch
---

Every `405` the MCP endpoint answers carries `Allow: POST`, as RFC 9110 requires, so a client can learn which method is served there.

A delivered `audience` is checked on a delegated token too, so one that is not the MCP endpoint's resource admits no delegated token. That still fails closed. `selectAuthProvider` now logs a warning, once per isolate, when a host that opted in to delegation on a shared issuer is handed such an audience.

The MCP endpoint's mount-time check now judges earlier routes against the path the endpoint really answers at, including an `app.basePath()` prefix. A route on a `basePath` app that would answer there now throws at mount, and a root route at the unprefixed path no longer does, since it is not in the way. Not judged, and stated: a pattern with a `*` outside a parameter's regex (a catch-all, or a `*` inside a segment such as `/api/*cp`, which Hono's routers do not dispatch alike), and the routes of an app this one is later mounted into with `app.route()`. A route with a `*` inside a segment that the check used to refuse is no longer refused for it.
