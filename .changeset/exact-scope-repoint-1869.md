---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/contract-tests': minor
'@substrat-run/adapter-sqlite': patch
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/vertical-host': patch
'@substrat-run/control-plane-api': patch
---

Restoring, forking, snapshotting or carrying a scope onto a new version now re-points only the scope-level grants of the scope the copy came from (#1869). Before, it re-pointed every stored grant whose object started with `scope:` in any letter case, so an entity-narrowed grant stored on an entity typed `Scope` or `SCOPE` (possible before #1856) became a grant on the whole destination scope. Such grants now keep their entity. When the source scope is known and its grants are in the copy, exactly those move: a copy restored into its own scope, or carried onto a new version, moves nothing. When the source is not known, or the copy holds no grant naming it (as when `substrat scope restore` loads a local world), the old rule applies without case folding, so `Scope:` and `SCOPE:` objects stay put. `/internal/restore` accepts an optional `sourceScopeId`, and the control plane sends it on every restore, adoption, rebind, preview fork and carry. A vertical built on an older `@substrat-run/vertical-host` ignores the field and keeps the old rule until it is re-pushed.

A kernel namespace (`principal`, `org`, `tenant`, `scope`, `role`, `connection`, `capability`, `system`, `vertical`, in any case) is now refused as an entity name by `defineEntities` and `emitModel`, and as an entity type in a manifest's `entityRelations`, `attachmentTargets` and `liveTargets`. So a module finds out when it emits its model or registers, not at its first `ctx.link`. A name that only starts with one, such as `scopeItem`, is fine.

The connection-grant read-back (`connectionGrantsInScope`) now matches `connection:` and `granted:` case-sensitively, and the permission walk holds every tuple its readers return to the requested relation prefix exactly, so a relation spelled `Role:` expands no role.

New exports: `RESERVED_NAMESPACES` and `isKernelNamespace` from `@substrat-run/contracts`, `repointScopeGrants` from `@substrat-run/kernel`, and `scopeRepointContractSuite` from `@substrat-run/contract-tests`.
