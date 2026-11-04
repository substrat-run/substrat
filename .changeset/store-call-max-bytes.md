---
'@substrat-run/contracts': minor
'@substrat-run/control-plane-api': minor
---

A store call body is bounded by `STORE_CALL_MAX_BYTES` (4 MiB) in the verifier both store entries share. A larger one is refused with 413 before it is read when its `Content-Length` says so, and at the limit when it does not, so a body with no `Content-Length` is no longer refused with 411. The Python entry keeps the body in JavaScript instead of copying it to Python. The router and the control plane refuse to sign a call over the limit.
