---
"@substrat-run/control-plane-api": patch
---

A per-PR preview of an app that signs in at one of its team's auth servers now has its MCP endpoint registered there as well. An MCP client pointed at `https://<app>--<tag>.<base>/api/mcp` gets a login page instead of `invalid_target`.

**Registration.** `wirePreviewAuth` registers the preview's endpoints at the auth server that minted the preview's client:
- It does so once that client is delivered and the preview is still bound to this push's version.
- It uses the same `substrat:resources:<scope id>` delivery through the auth server's `/internal/configure` that the dashboard makes at install, keyed by the preview's scope id. The app's own registration is never read or written.
- The set is one endpoint per hostname the directory says the preview actively holds at that moment, and never a hostname it no longer holds. Every push sends the same set again, which changes nothing.
- A transient failure is retried like the delivery beside it. The new optional `PreviewAuthDeps.retry` carries the retry, and the API's preview routes pass their own.
- A registration that still fails does not fail the create. The `wired` answer's `note` names the registered endpoints, or says they could not be registered.

**Reap.** `retireClientsOfReapedScope` now archives the preview before it touches any auth server, and a push reads anything but `active` as gone. A reap that keeps the row until its last step can therefore no longer race a push into leaving a client or a registration behind. `PreviewAuthDeps.admin` now needs `archiveScope` and `resolveHostname`. A reap that fails after the archive leaves an archived preview, and the reap's retry finishes it.

Every door that reaps a preview fork now runs that step. That includes the generic `DELETE /tenants/:tenantId/scopes/:scopeId`, which backs the console's Prune and Retire and the dashboard's Retire, and the staff `POST …/reap`. Before, both deleted the fork without asking any auth server.

`retireAllPreviewClients` then clears the preview's registration and retires its clients, in that order, at every auth server of the tenant:
- A deployment that takes no delivery is skipped for the clear, and one that predates preview clients is skipped for the retire.
- Any other failure throws, so the reap keeps the preview for its retry.

**A push that finds its preview reaped mid-flight** removes what it wrote itself, registration first. That includes a push whose last attempt ran out. If that removal fails, it answers 502, which records an ops failure, instead of reporting `superseded`.

The auth server moves a row to whichever key delivered it last. If such a push had moved a newer same-tag preview's row onto its own key, its removal hands that row back: the preview of the same app that now holds the hostname gets its own set again, under its own key.

**Unchanged:** external issuers, ambiguous or unreachable auth servers, and clean-room previews. Nothing is registered for them.
