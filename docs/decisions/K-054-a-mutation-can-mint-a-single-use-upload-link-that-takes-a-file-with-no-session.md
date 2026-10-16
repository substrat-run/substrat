---
id: K-54
date: 2026-10-16
layer: kernel
title: "A mutation can mint a single-use upload link that takes a file with no session"
status: proposed
aliases: []
amends: []
tracking: ["#2311", "#2314", "#2315"]
---

# K-54 — A mutation can mint a single-use upload link that takes a file with no session

> Proposed, not ratified. It records the write path that [#2311](https://github.com/substrat-run/substrat/pull/2311) shipped and that no earlier record covers. Deciding it is the maintainer's. One question below is left open on purpose.

**An attachment target opts in, and its declaration is the policy.** A module's `attachmentTargets[]` entry may declare `uploadLinks: { maxBytes, contentTypes? }`. Without it, `ctx.attachments.mintUploadUrl` refuses that target. `maxBytes` is required and held under the platform ceiling of 25 MiB. `contentTypes` is an allowlist of exact media types and families (`image/*`), and when it is absent the link admits any well-formed type. A family never admits an active type, one a browser runs rather than shows: HTML, `text/xsl`, `multipart/x-mixed-replace`, the types a browser sniffs for HTML (`application/unknown`, `unknown/unknown`), every XML type (`text/xml`, `application/xml` and any `+xml` subtype, SVG and XHTML among them) and every WHATWG JavaScript MIME type. The type is judged as its essence, without parameters, whitespace or case, and anything that is not exactly one `type/subtype` (a comma-separated list, a control character, a wildcard) is refused by every allowlist. Only an exact entry admits an active type. A mint may narrow the size, never widen it, and it cannot change the types. The declaration is rendered into the vertical's `PERMISSIONS.md` under *Upload links*: the entity type, the key the minter must hold, the ceiling, the types and the declaring module. So a widening is a reviewed diff, under the permission checkpoint, like a widened role.

**A link authorizes exactly one thing.** It is one attachment, of at most the link's `maxBytes`, of a type the link admits, to the one entity it was minted for, in the scope it was minted in. Nothing else. It never acts as anyone, never makes a session and reads nothing. It is not a capability, because a capability acts as itself and is refused attachment writes by design (#1686). The file is written by the platform's own attachment write, authored by the principal who minted the link. The target's `writePermission` is checked as that principal at the mint and again at redemption, so taking the key away ends what their links can do. Only a principal mints or revokes. A consumer or a schedule runs as the system actor and is refused (`forbidden`, `upload_link_delegation`), because the system actor has no authorship to lend.

**The secret.** It is 32 bytes from a CSPRNG, written as unpadded base64url behind the prefix `sbup_`, so a secret scanner can recognise one. Only its SHA-256 is stored, and every lookup is an indexed equality on that hash. A link lives 600 seconds unless the mint says otherwise, and never more than 3600. It is spent in the same scope transaction that inserts the attachment row, so a redemption that fails anywhere leaves it unspent, and two racing redemptions store one file. An operation that tries to persist the secret, in an event, its own table or a platform intent, is refused, with the same tripwire capabilities have.

**No oracle.** A secret that names nothing and a malformed one get the identical 404. A malformed one gets it from the route, without the scope being asked. The target in the request path is judged before the link's state, so a path naming another entity is the same 404 whether the link is pending, used, expired or revoked, and it spends nothing. Only a request carrying the right secret at the right path learns that the link is gone (410). A link minted in one scope is not found in any other scope of its tenant or of any other tenant, and stays usable where it was minted.

**The vertical's own guards run at the mint only.** An entity lock or a state check is decided in the operation, before it mints. The platform cannot know it and does not run it again at redemption. That is why the time box is short and a link can be revoked: a vertical that locks an entity after minting a link for it revokes the link.

**The secret is in the URL path.** A secret carried only in a header could not be used with `curl --upload-file URL` alone, and that one-line upload is the reason the path exists. The vertical's `invocationLog` writes any `sbup_` segment, and the secret segment of the redemption path, as `[redacted]`. *Open question, for the maintainer:* request logs of the hosting platform may retain the URL for the link's lifetime. The maintainer decides whether to accept that, to move the secret out of the path, or to have those logs redact it.

**Compensation: a failure after the commit never rejects, and bytes are kept on doubt.** The bytes go to the blob store before the row, as for any upload. They are deleted again only when the scope answered a refusal, which means the row did not commit. A failure in post-commit work is not turned into a refusal. When the transport fails and the commit is unknown, the bytes are kept, because deleting them could leave a committed row without its file. The cost is an object that no row points at, and a sweep for those is [#2314](https://github.com/substrat-run/substrat/issues/2314). A caller whose reply was lost cannot yet retry the same link, and idempotent redemption is [#2315](https://github.com/substrat-run/substrat/issues/2315).

## Evidence and limits

- **Implemented and tested** on both adapters, the hosted one included: `uploadLinkContractSuite` (`packages/contract-tests/src/upload-link-suite.ts`) and the HTTP route (`packages/vertical-host/test/upload-link-redeem.test.ts`). The review of #2311 and its follow-up added the cases for the principal-only mint, scope and tenant isolation, the active-type rule, the target-before-state answer, the malformed-secret short circuit and the streaming size cap. Each guard was mutation-checked.
- **The `PERMISSIONS.md` rendering** is held by `tools/permission-diff.test.mts` on fixture verticals. No vertical in the repo declares `uploadLinks` yet.
- **Not decided here:** the open question on platform request logs above, and #2314 and #2315.

## Why

**A caller with no session still needs to hand over a file.** An MCP client, a script or a shell has no cookie and no bearer for the vertical's own route, and a file of any real size cannot go through a tool call as base64. The smallest authority that solves this is one file, to one entity, once, for a few minutes, written as someone who could have written it anyway.

**The opt-in is the policy so that the review sees both.** A separate switch and a separate policy could drift apart. One declaration, rendered where the permission checkpoint already makes a human read it, means a target that starts taking links, or takes bigger or broader ones, cannot merge unseen.

**Families exclude active types because the uploader chooses the bytes.** The file is authored by the minter, but its contents come from whoever holds the link, and that may be a third party. `image/*` reads as "pictures" to the person writing it, and an SVG is a document that runs script when served inline. Requiring the exact name makes admitting one deliberate. An absent allowlist stays "any", because that already says everything is admitted. The docs tell a vertical to serve stored files as `Content-Disposition: attachment` with a sandboxing CSP.

**Judging the target first removes a signal nobody needs.** Whether a link at another path was already used is information only about the link's history. Answering every wrong path the same way costs nothing and keeps single use where it was: a wrong path never spends.
