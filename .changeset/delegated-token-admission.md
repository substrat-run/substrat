---
"@substrat-run/vertical-auth": minor
"@substrat-run/vertical-host": minor
---

Delegated calls at a vertical's MCP endpoint: another app of the team acting for a user, with a token the team auth server minted by RFC 8693 token exchange.

`@substrat-run/vertical-auth`: a bearer carrying `act` is now refused on every configuration unless the vertical opts in with `delegation: { actors }` (on `instanceAuthFor`, `selectAuthProvider`, `oidcRpAuthProvider` or `oidcAuthProvider`). An admitted one must name a listed actor of this issuer, be issued to that actor, carry a non-empty `scope` and an `exp`, and have this app's MCP resource as its only `aud`. It is admitted only on a request to that resource, so `resolve(headers)` without a URL, or with any other URL, refuses it. The resolved `AuthSubject` then carries `delegation: { actor, scope }`. Separately, on a shared issuer a token whose `aud` names another app's MCP endpoint is now refused even when it was issued to this app's own client.

`@substrat-run/vertical-host`: `setMcpDelegation(c, subject.delegation)` hands a delegation to the MCP mount, and every `tools/call` is then refused, in-band and before the operation runs, unless the tool's leading permission key is in the delegated scope. A tool with no single leading key (`narrows`) is outside every scope. A bearer carrying `act` with no delegation handed over has every tool call refused. Every route `mountOperations` mounts answers a bearer carrying `act` with a `401`, before resolving the caller. The MCP endpoint is the only route at its path: an operation or a hand-written route registered before it that would answer there (`/mcp`, `/:slug`) now throws at mount, and the endpoint answers `PUT`, `PATCH` and `DELETE` with a `405` as well as `GET`, so a route registered after it never runs there. `McpTool` gains `permission`, the leading key.
