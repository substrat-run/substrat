---
'@substrat-run/kernel': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contracts': minor
'@substrat-run/contract-tests': patch
'@substrat-run/demo-ticket0': patch
---

- kernel: `checkedWithin(entity, permission)` narrows a live read to one root, gated by the subscriber's own check on that root rather than on each row. The check runs at the handshake (`403`, `x-substrat-live: forbidden`) and again on every pass that has something beneath the root to announce. A withdrawn grant, or a root moved out of the grant's reach, closes the socket before anything is sent. Frames are bare nudges, as for `vouchedWithin`. Use it whenever there is a grant to check; `vouchedWithin` stays for a subscriber with none.
- adapter-cloudflare: the scope's fan-out honours `checkedWithin`, asking each socket's gate at most once per pass and only when a row beneath its root is about to be announced.
- contracts: `LiveRefusal` gains `'forbidden'`.
- ticket0: the portal's conversation view keeps itself current. A staff reply now shows up without a reload, pushed over `GET /api/conversations/:id/live` where the desk can push, and polled every 10s where it cannot.
