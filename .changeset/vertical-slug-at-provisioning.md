---
'@substrat-run/contracts': patch
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/control-plane-api': patch
---

An empty vertical slug was accepted at provisioning and then failed to parse when scopes were listed. Provisioning now takes the vertical in the registry's grammar (`verticalSlug`: lowercase letters, digits and hyphens, optionally prefixed by an owner slug and one `/`) and refuses anything else, an empty or whitespace-only string included, with `validation_failed` naming the `vertical` field. The rule is held in `resolveScopeRecord`, which both adapters' `provisionScope` call, and at the edges that feed it: the `POST /scopes` body and the tenant-provisioner payload (`provisionTenantPayload.instance.vertical`). A null or absent vertical still means no vertical.

One directory row that does not read as a scope no longer stops a `runPlatformSweep` pass. `HostAdmin.listScopesReadable` is a new optional read that answers `listScopes`'s rows, except that a row which does not parse is returned in `unreadable` by its ids and the names of the fields that failed. Both adapters implement it through the kernel's new `readableScopes`. The sweep reads the directory through it, steps over such a row in every phase, and names it once per pass in `errors` as `scope-row` (at most twenty, then one line saying there are more). `listScopes` itself is unchanged and stays strict, and so does the default tenant reap, which clears the tenant's directory afterwards. `unreadableScopeRowContractSuite` holds both adapters to it.
