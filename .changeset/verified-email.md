---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/vertical-auth': minor
'@substrat-run/dev-issuer': minor
'create-substrat': minor
'@substrat-run/demo-todo': major
---

An operation reads the caller's verified address as `ctx.verifiedEmail` (K-61), passed to `getScope` by the door. A `join` or `sign-up` that takes `email` no longer loads: upgrading such a vertical means reading `ctx.verifiedEmail` instead.
