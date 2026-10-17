---
'@substrat-run/contracts': patch
'@substrat-run/kernel': patch
'@substrat-run/adapter-sqlite': patch
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/contract-tests': patch
'@substrat-run/vertical-host': patch
'@substrat-run/docs': patch
---

An upload-link redemption whose reply was lost can be retried safely. The redeemer names the request with an `Idempotency-Key` header: 16 to 255 visible ASCII characters with no space, `"` or `\`, such as a UUID. The structured-field form `"…"` is read without its quotes. The spend records the key's SHA-256 beside the link in a new nullable column, `_substrat_upload_links.redeemed_key_hash`, which both adapters add to an existing scope on its next open.

A later request for the same link, with the same key and the same bytes (size and SHA-256) and within the link's lifetime plus 10 minutes (`UPLOAD_LINK_REPLAY_GRACE_SECONDS`), gets the stored record back with **200** instead of 201. It writes no bytes, no row and no event. The same key with other bytes is **422** (`upload_link_replay_mismatch`). Every other request for a spent link gets the same 410 as before, with the same headers and body: no key, another key, after the window, or after the file was removed or swept. A retry that races the first request has its own bytes removed and is answered as the replay.

`ScopeHost.inspectUploadLink` takes an optional `idempotencyKey`, `UploadLinkRedeemInput` gains `idempotencyKey`, and `redeemUploadLink` answers a `RedeemedUploadLink`, which carries `replayed: true` on a replay. A malformed key is `validation_failed`. `@substrat-run/contract-tests` adds `uploadLinkReplayContractSuite`, run by both adapters.
