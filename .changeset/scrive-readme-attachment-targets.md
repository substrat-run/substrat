---
'@substrat-run/connector-scrive': patch
---

docs: the document store caveat 4 says is missing has shipped — and this connector uses it

README caveat 4 stated that rendering the real avtal "needs a document store that does not exist
yet (`attachmentTargets` is declared in the manifest contract and implemented nowhere)". Both
halves are false. `attachmentTargets` is implemented in `adapter-sqlite` and `adapter-cloudflare`
— bytes to the per-tenant blob store, metadata in `_substrat_attachments`, permission-gated per
declared entity type with a spine event in the same transaction (#473) — and
`reconcileScriveDispatch` in this package has been landing the sealed signed PDF through it since
#476 step 2.

So a caveat meant to record a platform gap was telling readers to wait for something they could
already use, two functions away from code that uses it. The remaining gap is narrower and belongs
to this connector: `create` calls `renderPdf` unconditionally and has no way to be handed the
vertical's rendered document. Raised as R4 on #687.

Docs and one stale source comment only — no behaviour change.
