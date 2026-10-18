---
"@substrat-run/vertical-auth": patch
"@substrat-run/vertical-host": patch
---

Every `405` the MCP endpoint answers carries `Allow: POST`, as RFC 9110 requires, so a client can learn which method is served there.

A delivered `audience` is checked on a delegated token too, so one that is not the MCP endpoint's resource admits no delegated token. That still fails closed. `selectAuthProvider` now logs a warning, once per isolate, when a host that opted in to delegation on a shared issuer is handed such an audience.
