---
'@substrat-run/kernel': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contracts': minor
'@substrat-run/oidc-rp': minor
'@substrat-run/vertical-auth': minor
'@substrat-run/contract-tests': patch
'@substrat-run/demo-ticket0': patch
---

- kernel: `checkedWithin(entity, permission)` narrows a live read to one root, gated by the subscriber's own check on that root rather than on each row. The check runs at the handshake (`403`, `x-substrat-live: forbidden`) and again on every pass that has something beneath the root to announce. A withdrawn grant, or a root moved out of the grant's reach, closes the socket before anything is sent. Frames are bare nudges, as for `vouchedWithin`. Use it whenever there is a grant to check; `vouchedWithin` stays for a subscriber with none.
- adapter-cloudflare: the scope's fan-out honours `checkedWithin`, asking each socket's gate at most once per pass and only when a row beneath its root is about to be announced.
- kernel: `subscribe` takes `expiresAt`, the instant the caller's credential ends. The scope refuses a handshake past it and closes the socket (`1008`) on its first pass past it, before sending anything, or at its own alarm on a scope nobody writes to. An expired socket never counts against a principal's socket limit. One principal may hold `LIVE_SOCKETS_PER_PRINCIPAL` (8) sockets on a scope; the next is closed `LIVE_CLOSE.tooMany` (`4429`), which a client should read as "poll". A `checkedWithin` gate is asked once per principal and root per pass, however many sockets share it.
- oidc-rp: `verifySessionEnvelope` returns a session's user and its expiry.
- vertical-auth: `AuthSubject.expiresAt` carries a session cookie's or a bearer's `exp`.
- contracts: `LiveRefusal` gains `'forbidden'`.
- ticket0: the portal's conversation view keeps itself current. A staff reply now shows up without a reload, pushed over `GET /api/conversations/:id/live` where the desk can push, and polled every 10s where it cannot. A live socket now closes when the session that opened it ends, and signing out ends every feed the page holds.
