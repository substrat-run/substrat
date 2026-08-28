# @substrat-run/vertical-host

The platform's `/internal/*` management contract — the routes the control plane calls to
provision, reconcile, introspect, snapshot, export/restore, bookmark/rewind and configure an
install — plus the `application/problem+json` error envelope, **authored once and mounted**
into a vertical's [Hono](https://hono.dev) worker.

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
  ownerSeat,       // the owner seat's state, for the dashboard (omit ⇒ 501)
  mintOwnerClaim,  // a short-lived owner-claim link (omit ⇒ 501)
  onDeleteScope,   // e.g. drop the scope from a sweep roster (optional)
});

export default app;
```

### What it owns vs. what you supply

- **Generic routes** — `export`, `restore`, `bookmarks`, `rewind`, `snapshot`,
  `delete-scope`, `tables`, `tables/:table`, `query`, `platform-requests`,
  `platform-requests/settle` — pure delegations to your scope host, owned entirely by the
  package.
- **Flavored routes** — `provision`, `reconcile`, `configure`, `owner-seat`,
  `owner-claim` — the package keeps the platform-secret gate, body parse and response
  envelope; you supply only the hook. Omit `resolveOwner` / `onConfigure` / `ownerSeat` /
  `mintOwnerClaim` and that route answers `501`. The two owner-seat routes are how the
  dashboard sees whether anyone has claimed an instance, and mints the claim link that
  binds its owner once the first-sign-in window has closed (see
  [vertical-auth](/reference/vertical-auth)).
- **The gate** — one `/internal/*` middleware runs the platform-secret check; an unset
  secret fails closed (`403`).
- **The error envelope** — a Hono `onError` that maps the kernel/engine vocabulary onto HTTP
  (`permission denied → 403`, `not found / unknown scope → 404`, `invalid transition /
  immutable → 409`, a runtime fault → `502`) and renders every failure as an
  [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) problem document —
  `Content-Type: application/problem+json`, with the platform's closed `code` and, where a
  module narrowed it, the module's own `reason`. `error` is still present as a copy of
  `detail` for one migration window; read `detail`. Registered last, so mounting the surface
  installs it. The shape is the one every surface answers with, described in
  [API design § failures are data](/concepts/api-design#_5-failures-are-data).

## `problemResponse(c, err)`

The same envelope, for a vertical's **own** routes. The `onError` above is registered by
`mountPlatformSurface` for the whole app, so a vertical that mounts the platform surface
already answers problem+json everywhere; a vertical that owns its `onError` — to log, or to
map its own domain errors to a status first — keeps the shape in one line:

```ts
import { problemResponse } from '@substrat-run/vertical-host';

app.onError((err, c) => problemResponse(c, err));
```

An `HTTPException` that already carries its own response is handed back untouched, so a
redirect or a `WWW-Authenticate` a route chose survives. `demos/callout`, `demos/handlebar`
and `demos/manyfold` are the worked references.

## `mountOperations(app, operations, resolveStub, options?)`

One route per declared operation, from the same object the module registers — the seam that
reads `If-Match` (a stale tag → `412 precondition_failed`) and `Idempotency-Key` (a reused
key → `409 conflict`, a replay → the stored response with `Idempotency-Replayed: true`) on
every unsafe method, so a vertical never hand-parses either header. It maps the kernel's own
vocabulary to a status (`PermissionDenied → 403`, a `ZodError` → `400`, a runtime fault →
`502`) and re-throws everything else unchanged, so a vertical's domain errors reach
`app.onError` exactly as before — this decides the status, `problemResponse` decides the
shape. Two declarations that would dispatch identically fail at mount, naming both. The
headers and their semantics are specified in API design —
[§7 writes are safe to retry](/concepts/api-design#_7-writes-are-safe-to-retry) and
[§7b a read-modify-write says what it is writing over](/concepts/api-design#_7b-a-read-modify-write-says-what-it-is-writing-over).

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
