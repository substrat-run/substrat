---
"@substrat-run/control-plane-api": patch
---

A per-PR preview of an app that signs in at one of its team's auth servers now has its MCP endpoint registered there too. An MCP client pointed at `https://<app>--<tag>.<base>/api/mcp` gets a login page instead of `invalid_target`.

`wirePreviewAuth` registers the preview's endpoints at the auth server that minted its client. It does so after that client is delivered and while the preview is still bound to this push's version. It uses the same `substrat:resources:<scope id>` delivery through the auth server's `/internal/configure` that the dashboard makes at install, keyed by the preview's scope id, so the app's own registration is never read or written. The set has one endpoint for each hostname the preview actively answers on, and always includes the one its login is set up for. Every push sends the same set again, which changes nothing. A failed registration does not fail the create. The `wired` answer's `note` names the registered endpoints, or says they could not be registered.

`retireAllPreviewClients`, and so `retireClientsOfReapedScope`, also clears that registration at every auth server of the tenant that implements preview clients. If clearing fails, it throws, so the reap keeps the preview for its retry. A push that finds its preview reaped mid-flight clears it too. External issuers, ambiguous or unreachable auth servers, and clean-room previews are unchanged: nothing is registered for them.
