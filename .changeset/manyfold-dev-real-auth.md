---
'@substrat-run/demo-manyfold': minor
'@substrat-run/demo-manyfold-app': minor
---

Manyfold: the dev server now uses real auth, matching the deployed worker — no impersonation anywhere.

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
