---
'@substrat-run/adapter-sqlite': patch
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/contract-tests': patch
---

Commit HostAdmin's tenant writes (create, status, name, reap) and vertical writes (register, publish, listing, publish request, install block, tenant-provisioner and email-sender grants, delete, admit, reject, promote, serving state) with their admin audit rows in one directory transaction. If the audit insert fails, the prior state remains for a retry; if the write fails, no audit row is left. Audit row fields are unchanged. One ordering change: a promote's own `promoteVersion` row now commits with the channel move, so it is written before the `bindScopeVersion` rows of the scopes a private promote rebinds, not after them. A Cloudflare tenant reap now clears the tenant's directory rows in the same transaction as the status change. The other HostAdmin writes (roles and grants, hostnames, entitlements, connections, scope-level writes and the rest) still record their audit row as a separate step.
