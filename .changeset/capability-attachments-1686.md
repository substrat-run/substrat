---
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/vertical-host': minor
'@substrat-run/contract-tests': minor
---

A link share of a folder or a document can now deliver the files under it.

`ScopeHost.getCapabilityAttachments(sessionToken, tenantId, scopeId)` is the attachment surface for a capability session, the counterpart of `getConnectorAttachments`. It is optional, so an adapter built before it still satisfies the interface. Both adapters implement it:

- **Reads** (`list`, `open`) check the attachment target's `readPermission` on the file's entity, as `{ capability }`, through the same checker an invoke uses. That checks the capability's keys and its entity subtree, and re-checks that its minter can still read. The session is resolved again on every call, so a revoke or an expiry refuses the next download. A read never takes a use.
- **Writes** (`upload`, `remove`) are refused, even when the capability carries the write key, and the refusal is recorded in the denial log against the capability. No bytes reach the blob store. The refusal is the kernel's `capabilityAttachmentWriteRefused`.
- **A capability minted with `operations` can't read attachments.** No attachment verb is an operation it could have listed, so those reads are refused as `forbidden`.

`@substrat-run/vertical-host` adds `mountLinkShareDownload` (`GET /api/capability/attachments/:attachmentId`) and `linkShareAttachments`. Both use `linkShareStub`'s precedence: the `sb_capability` cookie first, then the signed-in visitor. A host without `getCapabilityAttachments` refuses a request carrying the cookie instead of answering as the visitor. The download is sent `Cache-Control: private, no-store`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff` and a `sandbox` content security policy, always as `Content-Disposition: attachment` (`attachmentDisposition`).

`@substrat-run/contract-tests` adds `capabilityAttachmentContractSuite`, and its capability fixture now declares attachment targets on `doc` and `folder`.
