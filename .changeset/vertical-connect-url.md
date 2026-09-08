---
'@substrat-run/kernel': minor
'@substrat-run/contracts': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/vertical-host': minor
---

A vertical can start a provider consent round for its own user (connections.md §3.5.3). The credential relay only serves a provider whose credential the tenant admin already holds; one that mints a credential at the end of a browser consent round could be connected from the dashboard alone, which is no use to a bookkeeping bureau whose staff work in the vertical, connect a client company most weeks, and have no dashboard account.

`requestConnectUrl` (vertical-host) POSTs the new `/internal/connections/connect-url` relay behind the vertical's own `ctx.check`, and gets back a URL to redirect its user to. Consent, exchange, sealing and the upsert all stay on the platform origin that owns the provider's one registered `redirect_uri` — the vertical never sees the client credentials, the code, or the token. The connection is stamped `createdBy` the authorizing tenant principal, the vertical is re-derived from the directory rather than taken from the caller, and a `returnUrl` must be a hostname the calling scope is bound to. `signConnectState` / `verifyConnectState` (kernel) are the signed state the minting and verifying workers share.
