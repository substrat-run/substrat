---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/vertical-host': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/docs': patch
---

Upload links: four tightenings after the first release's review.

**A family no longer admits an active type.** In an `uploadLinks.contentTypes` allowlist, `image/*`, `text/*` and every other family now leave out the types a browser runs rather than shows: `image/svg+xml`, `text/html`, `application/xhtml+xml`, `text/javascript`, `application/javascript`, `text/xml` and `application/xml`. An exact entry still admits one on purpose (`['image/*', 'image/svg+xml']`). An absent allowlist still admits every type, these included. The rule is `ACTIVE_CONTENT_TYPES` in `@substrat-run/kernel`, and `uploadContentTypeAllowed` applies it in both the route and the redemption. A link minted under a family that a vertical relied on for SVG or HTML now answers 415 for those files. Name the type to keep taking them.

**A wrong path is the same 404 whatever the link's state.** The target named in the path is judged before whether the link is pending, used, expired or revoked, so a spent link at another entity's path now answers 404 (`upload_link_wrong_target`) instead of 410. `ScopeHost.inspectUploadLink` takes an optional fourth argument, the target, and both adapters judge it in the kernel. A wrong path still spends nothing.

**A malformed secret never reaches the scope.** The route checks the secret's shape (`isUploadLinkSecretShape` from `@substrat-run/contracts`: `sbup_` and 43 base64url characters) before it resolves the host or the scope. It answers the same 404 an unknown secret gets. The kernel holds every lookup to the same shape.

**`mountUploadLinkRedeem` no longer takes a `path` option.** It always listens at `/api/attachment-uploads/:entityType/:entityId/:secret`, the path `mintUploadUrl` returns and the one whose secret `invocationLog` redacts. A custom mount matched no minted URL and wrote its secret to the log. `invocationLog` now also redacts any path segment that starts with `sbup_`, wherever it sits.

`uploadLinkContractSuite` adds cases for the principal-only mint and revoke (a consumer is refused both), redemption from another scope and another tenant, the active-type rule and the target-before-state answer, all run by both adapters.
