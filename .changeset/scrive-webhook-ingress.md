---
'@substrat-run/connector-scrive': minor
---

Webhook ingress (#96) — the push half of the return path, beside the poll floor. A
dispatch now mints a 256-bit capability token, remembers it on the dispatch ledger
row, and registers `${base}/hooks/scrive/{connectionId}/{instanceId}/{token}` as the
document's callback URL (Scrive's callbacks are unauthenticated, so the minted token
in the URL is the entire authentication). New `handleScriveCallback` verifies a
presented token in constant time — uniform rejection, zero provider egress without a
match — and then runs the same idempotent `reconcileScriveDispatch` the sweep runs:
a callback is a cache invalidation, never a fact, so no body is ever read and replay
needs no seen-set. `ScriveMock` can now deliver callbacks (`onCallback`), so the
full sign → callback → record loop runs offline. Breaking for config only: the
`callbackUrl` option's argument changed from `instanceId: string` to a
`ScriveCallbackRef` (`{ connectionId, instanceId, token }`); compose it with the new
`scriveCallbackPath`, and mount `SCRIVE_CALLBACK_ROUTE` where the deployment serves
HTTP.
