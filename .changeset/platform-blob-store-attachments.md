---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/cli': minor
---

Platform blob store + attachment surface (#473): `attachmentTargets`, declared by
the contract and every engine but implemented by nothing, now has a runtime home.

- **A fourth store shape.** `blobStoreNeed` in `runtimeNeeds.blobStores` — the
  `tenantStoreNeed` sibling for attachment bytes: the platform mints one bucket per
  tenant (R2 on `adapter-cloudflare`, a per-tenant directory on the pure adapter), the
  builder declares no id, so it is a *need* the platform provisions, never an `r2_bucket`
  binding the bundle carries. Seams: `ScopeHost.provisionBlobStore` / `listBlobStores`,
  a `blob_stores` ledger in both adapters, and the `createR2BlobStores` REST client.
- **`attachmentTargets` consumed.** `ScopeHost.attachments(principal, tenant, scope)`
  gates every read by the declared target's `readPermission` and every mutation by its
  new optional `writePermission` (default: the read key) — proof path included,
  per-entity, evaluated where `ctx.check` is. The read gate no longer leaves `ctx` for a
  hand-rolled route handler.
- **Rows in the scope, bytes in the store.** The metadata fact lands in a new
  `_substrat_attachments` table inside the scope database (so `scope pull` / restore /
  PITR carry it), transactional with an `attachment.added` / `attachment.removed` spine
  event. Bytes go straight to the per-tenant store, never through the scope's
  structured-clone invoke pipe. Keys are platform-derived (`scope/<scopeId>/att/<id>`),
  so per-scope isolation inside a per-tenant store is construction, not convention.
- **Integrity across the split.** Bytes are SHA-256'd at upload and written once under a
  fresh ULID key, so a row can never point at bytes other than the ones it was born with;
  a PITR rewind can at worst orphan an object (GC-able), never re-point a row.
- **Deploy path.** The WfP bindings patcher and every in-place serving upload now
  re-derive `r2_bucket` bindings from the blob-store ledger alongside the D1 tenant-store
  bindings (`blobStoreBindingName(binding, tenantId)`), so a re-deploy is structurally
  unable to drop a tenant's attachment bucket. The CLI carries `blobStores` from
  `runtimeNeeds` into the deploy manifest, admitted as a need (never a binding).
