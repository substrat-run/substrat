---
'@substrat-run/create-substrat': patch
---

A scaffolded project's dev API now defaults to `:8891` instead of `:8873`. The `887x`/`527x`
block is reserved for this monorepo's own demos, and `8873` is the shop demo's API — so a
project created with `npm create substrat` refused to boot beside the demo it was read from.
`PORT=…` still moves it, and the issuer default is unchanged at `:8879` (that is
`@substrat-run/dev-issuer`'s own default, which the scaffold's `issuer` script relies on).
