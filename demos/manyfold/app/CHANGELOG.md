# @substrat-run/demo-manyfold-app

## 0.2.0

### Minor Changes

- 6801089: Manyfold: the dev server now uses real auth, matching the deployed worker — no impersonation anywhere.

  Previously the node dev server authenticated with an `x-principal` header (a persona-picker
  impersonation bypass) and served a dev-only `/api/personas` list, while the worker used real
  sessions (Better Auth in the per-tenant IdentityDO, or OIDC). That divergence was also the source
  of a crash: `/api/personas` doesn't exist on the worker, so on the deployed app it fell through the
  SPA catch-all and returned `index.html` with a 200; the client parsed the HTML as `{}`, turning
  `personas` into a non-array, and `personas.find(...)` threw in the entry editor.

  Now both entrypoints authenticate the same way:

  - **Dev server** runs a real Better Auth instance in node (`src/auth-node.ts`), the same
    `AuthProvider` contract the worker uses — just running in-process against its own SQLite store
    instead of a Durable Object. A session cookie → verified subject → the principal that login is
    bound to (the kernel's identity directory). The `x-principal` bypass and `/api/personas` are
    gone; `x-site` remains, as site (scope) selection, not auth. A login per cast member is seeded so
    the demo runs out of the box (credentials printed on startup), and the members view's invite flow
    (`/api/invites`, `/api/accept-invite`) is wired for real.
  - **Worker** hardens its catch-all: an unmatched `/api/*` now returns a 404 JSON instead of the SPA,
    so a missing route can never be parsed as data again.
  - **App** drops the persona picker and the dev-mode branching entirely — dev flows through the same
    sign-in screen as prod, with a Sign out control; the members view always uses the real invite
    manager.

  Adds `better-auth` as a direct dependency of the Manyfold demo (already transitively present via
  `@substrat-run/vertical-auth`).

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
