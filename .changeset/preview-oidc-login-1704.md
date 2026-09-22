---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/vertical-host': minor
'@substrat-run/cli': minor
'@substrat-run/control-plane': patch
'@substrat-run/dashboard': patch
'@substrat-run/demo-auth-server': minor
---

A per-PR preview of an app that signs in at one of the team's auth servers now has a login
(#1704). A fork copies the app's data and none of its delivered config, and every push binds a
new version whose config store starts empty. The app's `substrat:auth` holds a client secret
the platform never stores or reads back, so it can't be copied. Instead, each `preview create`
(and each push to the preview) gives the preview **a client of its own** at that auth server
and delivers it as the preview's `substrat:auth`, along with the shared-issuer marker. The
app's own client is never changed and never learns a preview's callback. Reaping the preview,
by `preview delete`, `--refresh` or TTL expiry, deletes its client.

`@substrat-run/contracts` adds the protocol between the control plane and the auth server
(`preview-client.ts`): three platform-gated routes, `POST /internal/preview-client/check`,
`POST /internal/preview-client` and `DELETE /internal/preview-client`, with their request and
response schemas. Every redirect URI on that wire must be `https:`: loopback is refused, since
both ends are hosted and previews don't exist in local dev. It also adds `oidcCallbackUrl` / `OIDC_CALLBACK_PATH`, and `previewAuth`, the
`auth` field of `preview create`'s answer.

`@substrat-run/control-plane-api` adds `VerticalClient.checkPreviewClient` /
`mintPreviewClient` / `retirePreviewClients`. A deployment that predates the routes (a 404, the
auth server's JSON 501 fallback, or an SPA shell) reads as "redeploy the auth server", never as
"the app does not sign in there". It also adds `wirePreviewAuth`, `retireAllPreviewClients` and
`retireClientsOfReapedScope`. The previews routes answer `auth` and `notes` on create, and
`callbackUrl` on every listed row.

`@substrat-run/demo-auth-server` implements the three routes. An install claims an app only on
a binding **the platform** wrote there (a #1670 places row or a #1619 resource row), together
with a live client redirecting to the app's callback. Open DCR can forge a callback match on
its own, so a match alone is not enough. The route refuses a call for any tenant but its own.
The client is registered through the plugin's own dynamic registration and recorded in a new
`preview_client` table. Deletes select from that table only, so no delete can reach a client
it did not mint for that preview.

`@substrat-run/cli`'s `preview create` prints what happened to the login. For an app on an
external issuer it prints the preview's callback, and it says that no login config was
delivered. It also says that per-install Env settings are not carried over.
