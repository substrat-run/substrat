---
"@substrat-run/vertical-auth": minor
"@substrat-run/vertical-host": minor
---

Delegated calls at a vertical's MCP endpoint: another app of the team acting for a user, with a token the team auth server minted by RFC 8693 token exchange.

`@substrat-run/vertical-auth`: a bearer carrying `act` is now refused on every configuration unless the vertical opts in with `delegation: { actors }` (on `instanceAuthFor`, `selectAuthProvider`, `oidcRpAuthProvider` or `oidcAuthProvider`). On `instanceAuthFor`, `actors` may be a list or a function of the install's delivered wiring (`{ identity, config }`). A resolver that throws, or returns nothing usable, admits no delegated token.

`AuthProvider.resolve` takes an optional third argument, `{ delegated }`: the MCP endpoint's channel, `mcpChannelOf(c)` from `@substrat-run/vertical-host`. A delegated token is admitted only through it. An admitted token must:
- name a listed actor of this issuer;
- be issued to that actor;
- carry a non-empty `scope`;
- carry an `iat` no more than 30 seconds ahead of the verifier's clock;
- live no longer than five minutes (`exp − iat`; `maxLifetimeSeconds` can lower that, never raise it);
- have exactly the channel's resource as its only `aud`, on the request's own origin.

A call without the channel refuses it. That covers a REST route, a stray handler, and `resolve(headers)` alone. The resolved `AuthSubject` then carries `delegation: { actor, scope }`.

Two other refusals apply on every configuration:
- A token carrying a `substrat_delegation` claim but no `act` (the token exchange's intermediate assertion) is never accepted as a bearer.
- On a shared issuer, a token whose `aud` is another app's MCP endpoint is refused even when it was issued to this app's own client. This includes this app's own endpoint on another of its hostnames, and any spelling of the endpoint (case, trailing slash, percent-encoding).

`@substrat-run/vertical-host`: `mountMcp` sets a channel for the span of its own `resolveStub` call, and `mcpChannelOf(c)` reads it (`null` everywhere else, and nothing a request sends can set it). `setMcpDelegation(c, subject.delegation)` hands the admitted delegation back. Every `tools/call` is then refused, in-band and before the operation runs, unless the tool's leading permission key is in the delegated scope. A tool with no single leading key (`narrows`) is outside every scope. If a bearer carries `act` and no delegation was handed over, every tool call is refused.

Every route `mountOperations` mounts answers a bearer carrying `act` with a `401`, before resolving the caller.

The MCP endpoint is now the only route at its path:
- A route registered before it that Hono would dispatch there, by any method but `OPTIONS` (`/mcp`, `/:slug`, `/:slug?`, a regex parameter), now throws at mount.
- A second `mountOperations` on the same base path now throws at mount too, because the first endpoint is already there.
- The endpoint answers every method but `OPTIONS` itself: `POST` is MCP, and anything else is a `405`. A route registered after it never runs there.
- Not judged: `app.use`, `app.all` and `app.mount`, `OPTIONS` routes, and `*` catch-alls.

`McpTool` gains `permission`, the leading key.
