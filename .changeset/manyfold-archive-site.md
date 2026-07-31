---
'@substrat-run/contracts': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/control-plane': patch
'@substrat-run/vertical-auth': minor
'@substrat-run/demo-manyfold': minor
'@substrat-run/demo-manyfold-app': minor
---

Multi-scope Manyfold: archive a site.

Rounds out scope management (create + switch were already there) with **archive**, reusing the
platform-intent mechanism — archiving a scope is a platform action the sandbox-clean vertical can't
do itself, so it's another intent kind:

- **contracts:** `archive-scope` kind + `archiveScopePayload` (`{ scopeId }`).
- **control-plane-api:** `archiveScopeHandler` — the drained scope proves the tenant; the target
  must be under that same tenant and run the same vertical (verified against the directory), then
  `host.admin.archiveScope`. Idempotent (an already-archived/absent target is a no-op success).
- **control-plane worker:** registers `archive-scope` alongside `provision-sibling` in the drain.
- **vertical-auth:** `IdentityDO.forgetSite` drops a site from the per-tenant registry.
- **Manyfold:** a `manyfold/archive-site` op (`content:manage-sites` — no new permission) enqueues
  the intent; `POST /api/sites/:slug/archive` runs it as the caller, then optimistically drops the
  site from the registry so the switcher updates immediately.
- **Manyfold app:** an admin-only **Archive** control next to the switcher (shown only when the
  tenant has more than one site); it archives the current site and switches away.

Tested: the handler archives its target + is idempotent + refuses a cross-vertical target;
`forgetSite` drops a site; the `archive-site` op enqueues an `archive-scope` intent and an author is
denied. Refs #358.
