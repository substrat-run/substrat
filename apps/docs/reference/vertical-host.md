# @substrat-run/vertical-host

The platform's `/internal/*` management contract — the routes the control plane calls to
provision, reconcile, introspect, snapshot, export/restore, bookmark/rewind and configure an
install — plus the `{ error }` response envelope, **authored once and mounted** into a
vertical's [Hono](https://hono.dev) worker.

Before this package every sandbox-clean vertical hand-copied those routes and a Hono
`onError` into its own `worker.ts`. The copies drifted — route sets disagreed and some
workers shipped *without* the error handler, so a failing `/internal/restore` surfaced to the
control plane as the Workers runtime's bare `Internal Server Error` with no diagnosis. One
copy, mounted, removes that whole failure class.

## `mountPlatformSurface(app, deps)`

```ts
import { Hono } from 'hono';
import { mountPlatformSurface } from '@substrat-run/vertical-host';
import { CloudflareScopeHost } from '@substrat-run/adapter-cloudflare';
import { ROLES, OWNER_ROLE_KEY } from './provision.js';

const app = new Hono<{ Bindings: Env }>();

// your own user-facing surface:
app.get('/api/me', /* … */);
app.post('/api/invoke', /* … */);

// the entire platform contract + guaranteed error envelope, in one call:
mountPlatformSurface(app, {
  platformSecret: (env) => env.PLATFORM_SECRET,
  hostFor: (env) => hostFor(env),
  roles: ROLES,
  ownerRoleKey: OWNER_ROLE_KEY,
  onProvision,     // pending-owner claim / site registry (optional)
  resolveOwner,    // owner-of-record for reconcile (omit ⇒ 501)
  onConfigure,     // per-instance config store (omit ⇒ 501)
  onDeleteScope,   // e.g. drop the scope from a sweep roster (optional)
});

export default app;
```

### What it owns vs. what you supply

- **Generic routes** — `export`, `restore`, `bookmarks`, `rewind`, `snapshot`,
  `delete-scope`, `tables`, `tables/:table`, `query`, `platform-requests`,
  `platform-requests/settle` — pure delegations to your scope host, owned entirely by the
  package.
- **Flavored routes** — `provision`, `reconcile`, `configure` — the package keeps the
  platform-secret gate, body parse and response envelope; you supply only the hook. Omit
  `resolveOwner` / `onConfigure` and that route answers `501`.
- **The gate** — one `/internal/*` middleware runs the platform-secret check; an unset
  secret fails closed (`403`).
- **The error envelope** — a Hono `onError` that maps the kernel/engine vocabulary onto HTTP
  (`permission denied → 403`, `not found / unknown scope → 404`, `invalid transition /
  immutable → 409`) and renders everything else as `{ error: <message> }`. Registered last,
  so mounting the surface installs it.

### The scope host is structural

`hostFor` returns anything satisfying the `VerticalScopeHost` interface — the `…Local`
methods plus the introspection and platform-request reads. The package therefore depends on
neither `@substrat-run/adapter-cloudflare` nor any concrete host, and a future adapter fits
the same shape.

### Self-enforcing

A vertical that never calls `mountPlatformSurface` has no `/internal/provision`, so it fails
to provision on first deploy and in its scenario test — louder than any lint could be.

## License

AGPL-3.0-only (dual-licensed commercially).
