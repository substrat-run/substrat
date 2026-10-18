---
"@substrat-run/vertical-auth": minor
"@substrat-run/vertical-host": minor
---

Delegated calls at a vertical's MCP endpoint: another app of the team acting for a user, with a token the team auth server minted by RFC 8693 token exchange.

`@substrat-run/vertical-auth`: a bearer carrying `act` is now refused on every configuration unless the vertical opts in with `delegation: { actors }` (on `instanceAuthFor`, `selectAuthProvider`, `oidcRpAuthProvider` or `oidcAuthProvider`). On `instanceAuthFor`, `actors` may be a list or a function of the install's delivered wiring (`{ identity, config }`). A resolver that throws, or returns nothing usable, admits no delegated token.

An admitted token must:
- name a listed actor of this issuer;
- be issued to that actor;
- carry a non-empty `scope`;
- carry an `iat` no more than 30 seconds ahead of the verifier's clock;
- live no longer than five minutes (`exp − iat`; `maxLifetimeSeconds` can lower that, never raise it);
- have this app's MCP resource as its only `aud`.

It is admitted only on a request to that resource, so `resolve(headers)` with no URL, or with any other URL, refuses it. The resolved `AuthSubject` then carries `delegation: { actor, scope }`.

Two other refusals apply on every configuration:
- The exchange's intermediate assertion (`may_act`, or a `substrat_delegation` claim with no `act`) is never accepted as a bearer.
- On a shared issuer, a token whose `aud` is another app's MCP endpoint is refused even when it was issued to this app's own client. This includes this app's own endpoint on another of its hostnames, and any spelling of the endpoint (case, trailing slash, percent-encoding).

`@substrat-run/vertical-host`: `setMcpDelegation(c, subject.delegation)` hands a delegation to the MCP mount. Every `tools/call` is then refused, in-band and before the operation runs, unless the tool's leading permission key is in the delegated scope. A tool with no single leading key (`narrows`) is outside every scope. If a bearer carries `act` and no delegation was handed over, every tool call is refused.

Every route `mountOperations` mounts answers a bearer carrying `act` with a `401`, before resolving the caller.

The MCP endpoint is now the only route at its path:
- An operation, or a hand-written route registered before the endpoint, that would answer at that path (`/mcp`, `/:slug`) now throws at mount.
- The endpoint answers `PUT`, `PATCH` and `DELETE` with a `405`, as it already did `GET`, so a route registered after it never runs there.

`McpTool` gains `permission`, the leading key.
