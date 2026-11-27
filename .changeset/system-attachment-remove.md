---
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/contracts': minor
---

`getSystemAttachments` now has `remove`, so a module's system principal can delete a file whose retention period has ended. The remove is checked against the target's write key, or its new optional `removePermission` (which admits a remove but not an upload), and its `attachment.removed` event names the module. `systemAttachmentRemoveContractSuite` holds both adapters to it.
