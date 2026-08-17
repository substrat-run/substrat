---
"@substrat-run/kernel": minor
"@substrat-run/adapter-sqlite": minor
"@substrat-run/adapter-cloudflare": minor
"@substrat-run/vertical-host": minor
"@substrat-run/control-plane-api": minor
"@substrat-run/engine-test-kit": minor
"@substrat-run/engine-protocol": minor
"@substrat-run/connector-scrive": minor
---

The signatory is sent the contract, not an attestation sheet (#711).

`connector-scrive`'s `create` rendered its own document unconditionally: one page
naming the template, the parties and the content hash. Honest paper for a
hash-attestation model, and the wrong paper for a contract — what landed in a
counterparty's inbox was a list of identifiers, and they were asked to sign it
with BankID. There was no way for a caller to supply the real one.

**The seam.** A vertical uploads its rendered document onto the protocol instance
and names it when binding; the freeze event carries the id; the connector opens it
and sends those bytes:

```ts
const doc = await attachments.upload({ entity: { entityType: 'protocol', entityId }, … });
await scope.invoke('protocol/bind-document', { instanceId, contentRef, contentHash,
                                               documentAttachmentId: doc.id });
```

Bind nothing and today's sheet goes out unchanged, byte for byte — a vertical that
renders nothing keeps working with no change.

**By id, never by search.** The return path lands the sealed *signed* copy on the
same instance, so a connector that picked "the document on this instance" could
mail a counterparty their own signed contract to sign again. Naming an id makes
that unrepresentable rather than merely unlikely, and removes the only real design
question the issue raised.

**What the platform was actually missing.** The attachment store has existed since
#473 and this connector already wrote through it on the return path — but the
outbound leg needed a read that did not exist, in two different ways:

- on `adapter-sqlite` a connector runs INSIDE the scope's actor task
  (`dispatchExecutors` is called from within `enqueue`), and every verb of the
  ordinary attachment surface re-enqueues on that actor — so reading from a
  dispatch wedged the scope, silently, forever. `dispatchConnector` does *not*
  enqueue, so a naive implementation works on the routed path and hangs under
  `invoke`/`drainDue`. Pinned in `adapter-sqlite/test/connector-reads.test.ts`.
- on the hosted Cloudflare path only `upload` crossed the `/internal` connector
  seam, so the control plane held the credential while the vertical held the bytes.

New in the kernel: **`ConnectorContext.openAttachment(id)`** — reads only, by id
only, authorized as the connection against the target's `readPermission`.
`ScopeHost.dispatchConnector` gains `options.provider`, which is what a routed
delivery authorizes that read as (taken from the intent's own `connector:<slug>`
kind, so the two cannot drift). `ConnectorDelegation` gains `openAttachment`, backed
by `GET /internal/connector-attachment/:id` (raw bytes, record in a header — a
contract is megabytes and base64 in JSON would inflate it for nothing).

`engine-protocol` gains migration `0004-bound-document` and an optional
`documentAttachmentId` on `bindDocument`, carried additively onto
`protocol.content-bound` (with the kernel's own `sha256`), `protocol.signatures-requested`
and `protocol.signed`. `bindDocument` refuses an attachment that is not on the
instance being bound — the reconciliation belongs where the document and the hash
are first named together.

**Permission diff.** A connection now needs `protocol:read` to send the vertical's
document. Meridian's `connectScrive` grants it, and also `protocol:attach`, which
was missing — the sealed-copy landing has been failing there and reporting itself
as a `skipped` reason rather than an error, so nobody was told.

**Not a silent fallback.** A named-but-unreadable document is a hard failure. Once
a vertical has said which bytes its signatory must see, substituting other paper is
quieter than a refusal and worse, because a document still goes out and someone
still signs it. The dispatch dead-letters; the ledger row is written only after
`start`, so the retry after the fix sends the right document.

`engine-test-kit` gains an opt-in `attachments` option — an engine's declared
`attachmentTargets` could not be exercised there at all before, because the
harness's scope had no vertical and so no blob store.
