# @substrat-run/demo-manyfold-app

## 0.1.0

### Minor Changes

- fbf0704: Multi-scope Manyfold: archive a site.

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

- eba255c: Multi-scope Manyfold, D3 (UI): a "New site" control in the app.

  Admins get a **+ New site** button next to the site switcher (shown when the caller holds
  `content:admin`). It takes a name, calls `POST /api/sites` (which runs `manyfold/request-site` —
  D1's permission-gated op), then polls `GET /api/sites` until the platform provisions the new site
  and it appears in the registry, and switches to it. This completes the self-serve, in-app,
  vertical-authorized site-creation flow (multi-scope-manyfold.md M3) end-to-end over the merged
  platform-intent path (A→D2 + the periodic sweep C).

  The wait is the platform drain. Today that is the ~2-min periodic sweep, so the control shows a
  "provisioning — this can take a minute" note while it polls. The low-latency **router kick** (which
  turns that into seconds — `POST /api/sites` already tags its response with `x-substrat-platform-request`
  for it) is the one remaining piece: it touches the environment router (critical path) and needs a
  control-plane service binding + secret it doesn't have today, so it's deferred to its own carefully
  reviewed change. Refs #358.
