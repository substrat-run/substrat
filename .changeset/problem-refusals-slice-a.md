---
'@substrat-run/vertical-host': minor
'@substrat-run/vertical-auth': patch
'create-substrat': patch
---

vertical-host exports `refuse` and `refuseStatus`, so a vertical answers a refusal it decides itself as the same RFC 9457 problem document the host does; the connector-attachment 404 answers one too. vertical-auth's unserved `/api/auth/*` 404 and the scaffold's dev-server 401 and unknown-`/api` 404 are problem documents, with `error` beside `detail`.
