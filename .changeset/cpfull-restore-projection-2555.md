---
'@substrat-run/kernel': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': patch
---

A staff restore or import on a Cloudflare host the control plane runs lands with the directory's current permission state (#2555).

- **adapter-cloudflare, the load.** `restoreScope` and `importScope`, on a host with `scopeLocalPermissions`, write what a fan-out sends as the load's last step, in its own transaction: the tenant's roles, tenant-level tuples, entitlements and identity links, and the vertical's connection keys, each a full replace. What the directory has revoked since the dump was taken does not come back with it. The scope-level tuples are the dump's, and none is revoked.
- **Judged in the load.** The role set is judged there against the roles, tombstones and seats the dump has just brought, asking only about the roles that state seats, stores or keeps a tombstone of. Refused: `forbidden`, `restore refused: ` or `import refused: ` followed by the in-unit sentence, and every row of the scope is as it was. An import refused there, or whose second read cannot land, takes down the scope it created: only one this call created and still `provisioning`, never an existing scope. That teardown is best effort, and a failing one files a staff-only ops-failure row. A retry with the same scope id imports.
- **Flags.** The destination keeps its `permission_source` and `entitlements_enforced` through the load, never the dump's; the projection then moves them as a fan-out would. On a host without `scopeLocalPermissions`, only the flags are kept.
- **A second read.** The directory is read again after the load. When it moved in between, the scope is projected once more, once, judged against the seats the load brought. The admin row records `reprojected`: `true`, `'refused'` or `'failed'`. A re-projection that cannot land fails the verb last. A restore, or an import onto an existing scope, is recorded first (and a restore's switches re-asserted); an import's own new scope is taken down. A refused one holds only until the next fan-out, and its refusal names the staff remedy: take the dump's seats in that role back, or define the role person-held again.
- **Version skew.** The load is a new ScopeDO method, `importDumpProjected`: a host meeting an older ScopeDO is refused with nothing loaded. `importDump` is unchanged. A preview's snapshot still loads with `importDump`.
- **kernel.** `loadedRoleSetRefusedRole`: a role set judged against a loaded scope's stored state, on `reservedRoleSetRefusal`'s walk, asking only about the roles that state has a part in.
- **contract-tests.** `restoreRoleContractSuite` reads the scope's roles after a restore that follows a change to the directory's roles; its fixture takes an optional `readsRolesRemotely`.
