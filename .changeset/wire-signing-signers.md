---
'@substrat-run/contracts': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/control-plane': minor
'@substrat-run/router': minor
---

The router and the control plane can sign what they send a deployed vertical (RFC wire-signing, step 2, the signers). Each is off until its own `WIRE_SIGN` setting is exactly `on`, and off it sends exactly what it sent before. On, the router puts a `route` envelope beside the legacy headers on every request it dispatches to a deployment, and a router `call` envelope on every peer invocation; the control plane puts a `call` envelope on every call it makes to a deployment. Each attempt is signed afresh. A signer whose key is missing or will not import never fails a request: it goes with its legacy headers, and the signer's log line says why, never the key. A call whose body is streamed (the connector attachment upload's streamed route) is not signed in this version: it goes with its legacy header, its body unread, counted `skipped`. No deployment is given key lists yet, so an envelope is carried and ignored, and every deployed vertical is served as before.

`@substrat-run/contracts/wire-signing` gains `wireSignerOf` (a signer's whole decision: `null` while its flag is off; on, sign each request or hand it back whole with the reason it could not), `signWireRequest` (a fresh envelope on a request about to be sent, every other header kept, a call's exact body bound), `wireSigningOn` (the `sign` flag's one reading), `wireSigningKeyOf` (a signer's key, imported once per isolate), and `WIRE_UNSIGNED_HEADERS` with `wireUnsignedHeadersOf`: the field-coverage sample and a peer call's parent request id, listed by name as carrying no authority. When an envelope alone admits a request, the platform's entry now hands each of these on, on its own kind of request and only when its value passes its reader's own check, and still drops every other unsigned `x-substrat-*` header.

`@substrat-run/control-plane-api` gains `platformSignedFetch`: the `fetch` a `VerticalClient` for one deployment is given, which is the caller's own while the flag is off and signs every call for that deployment while it is on.

The key tool gains the wire's two issuers as `pnpm wire-keys`, with a standby key per issuer (runbook `secrets/wire-keys.md`).
