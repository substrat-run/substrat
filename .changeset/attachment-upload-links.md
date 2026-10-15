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

An operation can mint a single-use, short-lived upload URL for one attachment on one entity, so a caller with no session (an MCP client's shell, a `curl`) uploads a file without sending base64 through a tool call. An `attachmentTargets` entry opts in with `uploadLinks: { maxBytes, contentTypes? }` (at most 25 MiB; absent, a mint is refused), and `ctx.attachments.mintUploadUrl({ entity, filename?, maxBytes?, ttlSeconds?, visibility? })` returns `{ id, secret, path, expiresAt, maxBytes, filename }`. It checks the target's `writePermission` on the entity as the caller, for a principal only, and lives ten minutes by default and an hour at most. `ctx.attachments.revokeUploadLink` and `ctx.attachments.uploadLinks` take a link back and list them, never with the secret.

`mountUploadLinkRedeem` from `@substrat-run/vertical-host` mounts `PUT`/`POST /api/attachment-uploads/:entityType/:entityId/:secret`. It reads the body under the link's size, decides the media type (the request's, else the extension, else the bytes; PDF, PNG, JPEG and GIF must match their bytes) and hands it to `ScopeHost.redeemUploadLink`, which writes it through the ordinary attachment write: bytes first, then the row and `attachment.added` in one transaction, authored by the principal who minted the link and checked against the target's `writePermission` as them again at redemption. The link is spent in that same transaction, so any refusal leaves it unspent. Answers: 201, 404 (unknown secret, or a path naming another target), 410 (used, expired or revoked), 413, 415, 403. The answer is `no-store`, carries no `ETag` or `Location`, and drops the CORS headers an outer layer set. `invocationLog` writes the secret segment of that path as `[redacted]`.

Only the secret's SHA-256 is stored, in the new kernel-owned `_substrat_upload_links` table, and a module that persists the secret is refused as it is for `ctx.capabilities`. A copy of a scope starts with no links. Three kernel-authored events, `attachment.upload-link-minted`, `attachment.upload-link-redeemed` (written with the `attachment.added` it caused, and naming the attachment) and `attachment.upload-link-revoked`, join the reserved set. `ScopeHost` gains `inspectUploadLink` and `redeemUploadLink`, both optional like `getCapabilityAttachments`. `lint:permissions` renders an *Upload links* section for a vertical that declares one, and `@substrat-run/contract-tests` adds `uploadLinkContractSuite`, which both adapters run. Existing upload routes and their behaviour are unchanged.
