---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/vertical-host': minor
'@substrat-run/contract-tests': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/control-plane': minor
---

Attachment bytes beside the storage gauge (#2501). The stored gauge measured scope databases only. The scheduled pass now also reads what each due scope's attachment rows sum to, in the same attempt, and keeps it as its own day row, with the database sample's rules: the day's latest reading, thirteen months, deleted at reap. `/meters` serves it as `storage.attachments {bytes, sampled}`, beside `bytes`, never in it: the basis stays the scope databases, and attachments stay in `excluded`.

- contracts: `storageGauge.attachments`.
- kernel: `ATTACHMENT_BYTES_SQL`, the `_substrat_scope_attachment_storage` table in `SCOPE_STORAGE_DDL`, `listScopeAttachmentStorageRows`, `attachments` on a storage reading, and the storage phase's optional `readAttachments`, bounded by `storeReadTimeoutMs` like the store read. A deployment that cannot read attachment bytes (`StorageReadUnsupported`) is neither a failure nor a size of 0. A failed attachment read keeps the database sample and the store reading, and is the scope's error. Also the optional `HostAdmin.scopeAttachmentBytes`, the co-located read, access-logged.
- adapter-sqlite, adapter-cloudflare: the table, the co-located read, and the scope DO's `attachmentBytes`. contract-tests holds both adapters to them, from an upload to `/meters`.
- vertical-host: `GET /internal/attachment-size`, behind the same platform gate as every `/internal` route, answering 501 on a host without `attachmentSizeLocal`.
- control-plane-api: `VerticalClient.attachmentSize`.
- control-plane: the storage phase reads attachment bytes through the deployment that holds each scope.

No existing retention changes.
