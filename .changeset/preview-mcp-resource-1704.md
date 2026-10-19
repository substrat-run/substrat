---
"@substrat-run/control-plane-api": patch
---

A per-PR preview of an app that signs in at one of its team's auth servers now has its MCP endpoint registered there as well. An MCP client pointed at `https://<app>--<tag>.<base>/api/mcp` gets a login page instead of `invalid_target`.

`wirePreviewAuth` registers the endpoint at the auth server that minted the preview's own client, once that client is delivered and the preview still serves this push's version. It uses the same `substrat:resources:<scope id>` delivery through the auth server's `/internal/configure` that the dashboard uses at install, keyed by the preview's scope id, so the app's own registration is never read or written. Every push sends the same set again, which writes nothing new. A failed registration does not fail the create: the `wired` answer's `note` names the endpoint and says it could not be registered. On success the note names the endpoint as registered.

`retireAllPreviewClients`, and so `retireClientsOfReapedScope`, also clears that registration at every auth server of the tenant that implements preview clients. A failure throws, so the reap keeps the preview for its retry. A push that finds its preview reaped mid-flight clears it too. External issuers, ambiguous or unreachable auth servers, and clean-room previews are unchanged: nothing is registered for them.
