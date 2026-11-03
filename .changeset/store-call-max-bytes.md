---
'@substrat-run/contracts': minor
'@substrat-run/control-plane-api': minor
---

A store call body is bounded by `STORE_CALL_MAX_BYTES` (5 000 000 bytes). Both store entries refuse a larger one with 413 in the store envelope, before reading it when its `Content-Length` says so, and the Python entry keeps the body in JavaScript instead of copying it to Python twice. The control plane refuses to sign an outgoing call over the limit. A body with no `Content-Length` is no longer refused with 411: it is read to the limit and refused there.
