---
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/control-plane-api': patch
'@substrat-run/vertical-auth': patch
'@substrat-run/oidc-rp': patch
'@substrat-run/psl': patch
'@substrat-run/boundary-lint': patch
'@substrat-run/model-emit': patch
'create-substrat': patch
---

Every published package now actually ships its license text.

`LICENSING.md` has always opened by claiming each package "ships the full text in its
tarball." Eight of them did not: `adapter-cloudflare`, `control-plane-api`,
`vertical-auth`, `oidc-rp`, `psl`, `boundary-lint`, `model-emit` and `create-substrat`
declared a license in `package.json` and shipped no `LICENSE` file. npm auto-includes
`LICENSE*` when present — none was present, so nothing was included.

That is worth a version bump rather than a docs fix, because a tarball is where the
claim is either true or false, and `adapter-cloudflare` is the load-bearing case: §5.7
makes the Cloudflare adapter half of the two-adapter rule that keeps the escrow story
literally true, and AGPL is what stops a hosted derivative of it from staying closed.
An AGPL package distributed without its license text is the weakest possible version of
that. The texts are the stock unmodified AGPL-3.0 and Apache-2.0, byte-identical to the
copies already in `kernel` and `contracts`.

No code changes.
