---
'@substrat-run/vertical-auth': minor
---

A `/tokens` subpath export, so a node host can reach `sha256Hex`, `claimToken`,
`ownerClaimPath` and the new `invitePath` without importing the package root — which
exports `IdentityDO`, and `IdentityDO` imports `cloudflare:workers`. A vertical's dev
server and its worker can now build the same invite link from the same three facts.
