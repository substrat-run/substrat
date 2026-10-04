---
"@substrat-run/contracts": minor
"@substrat-run/adapter-cloudflare": minor
"@substrat-run/cli": minor
---

Attachments work on a hosted vertical with nothing to wire. When any module declares `attachmentTargets`, `substrat push` now declares the attachment blob store itself (`ATTACHMENT_BLOB_BINDING`, `ATTACHMENTS`), so the platform mints and binds a bucket for every installed tenant; and `CloudflareScopeHost` resolves the bucket for the tenant it is serving on its own, with `attachmentBuckets` left only as an override. Before this, no deployed vertical could upload an attachment. Re-push a vertical that declares attachment targets to get its buckets.

The push refuses `ATTACHMENTS` declared as a per-tenant relational store, or taken by one of the vertical's own bindings. `blobStoreBindingName` and `tenantStoreBindingName` now refuse a tenant id that is not a ULID, so no id can spell another tenant's binding.
