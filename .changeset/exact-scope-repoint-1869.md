---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/contract-tests': minor
'@substrat-run/adapter-sqlite': patch
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/vertical-host': patch
'@substrat-run/control-plane-api': patch
---

Restoring, forking, snapshotting or carrying a scope onto a new version now re-points only the scope-level grants of the scope the copy came from (#1869). Before, it re-pointed every stored grant whose object started with `scope:` in any letter case, so an entity-narrowed grant stored on an entity typed `Scope` or `SCOPE` (possible before #1856) became a grant on the whole destination scope. Such grants now keep their entity.

A copy the platform exported itself (a fork, snapshot, preview, carry onto a new version, adoption or rebind) moves exactly the grants on its source scope and nothing else, so a carry, whose source is its destination, moves nothing. A copy a caller supplies (a restored backup, an uploaded file) does the same when it holds a grant on the scope it says it came from. When it does not, or names no source (as when `substrat scope restore` loads a local world), the old rule applies without case folding: `Scope:` and `SCOPE:` objects stay put, and an entity typed exactly `scope` still moves, since nothing tells it from a scope grant there (the write verbs refuse that type since #1856). A supplied copy that holds grants on its source and also on a third scope, neither its source nor its destination, is refused with a message naming them, and the target keeps what it held. In a platform copy such a grant authorized nothing where it came from, and it is left as it is. A dashboard upload passes the uploaded file's own `scopeId` as that source when it is a scope id, as a separate `sourceScopeId` beside the dump (the restore route and `ScopeHost.restoreScope` accept it), so an upload of another scope's export re-points exactly; the dump's own ids are unchanged. `/internal/restore` accepts an optional `sourceScopeId` and `exact` (refused together without a source), and the control plane sends them on every restore, adoption, rebind, preview fork and carry. A vertical built on an older `@substrat-run/vertical-host` ignores them and keeps the old rule until it is re-pushed.

A kernel namespace (`principal`, `org`, `tenant`, `scope`, `role`, `connection`, `capability`, `system`, `vertical`, in any case) is now refused as an entity name by `defineEntities` and `emitModel`, as an entity type in a manifest's `entityRelations`, `attachmentTargets`, `liveTargets`, `searchables`, `lists` and `ui.entityViews`, and as an `entityGrants` shape in a pushed deploy manifest or a manifest published through `POST /verticals/:slug/versions` (a version already stored stays readable). So a module finds out when it emits its model or registers, not at its first `ctx.link`. A name that only starts with one, such as `scopeItem`, is fine.

The connection-grant read-back (`connectionGrantsInScope`) now matches `connection:` and `granted:` case-sensitively, and the permission walk holds every tuple its readers return to the requested relation prefix exactly, so a relation spelled `Role:` expands no role.

New exports: `RESERVED_NAMESPACES` and `isKernelNamespace` from `@substrat-run/contracts`, `repointScopeGrants` and `RepointSource` from `@substrat-run/kernel`, and `scopeRepointContractSuite` from `@substrat-run/contract-tests`.
