# @substrat-run/vertical-host

The platform's `/internal/*` surface — provision, reconcile, introspection, the read-only
SQL console, platform-request drain, snapshot / delete / export / restore / bookmarks /
rewind, and per-instance configure — **authored once** and mounted into a vertical's Hono
worker, plus the error envelope that turns a thrown route into a readable `{ error }`.

Before this package every sandbox-clean vertical hand-copied those ~14 routes and a Hono
`onError` into its own `worker.ts`. The copies drifted — route sets disagreed and two
workers shipped without the error handler, so a failing `/internal/restore` surfaced as
the Workers runtime's bare `Internal Server Error` with no diagnosis (issue #510).

**Full documentation: https://substrat.net/reference/vertical-host**

## Usage

```ts
import { Hono } from 'hono';
import { mountPlatformSurface } from '@substrat-run/vertical-host';
import { CloudflareScopeHost } from '@substrat-run/adapter-cloudflare';
import { ROLES } from './provision.js';

const app = new Hono<{ Bindings: Env }>();

// the vertical's own user-facing surface:
app.get('/me', /* … */);
app.post('/op/:name', /* … */);

// the entire platform contract + guaranteed error envelope, in one call:
mountPlatformSurface(app, {
  platformSecret: (env) => env.PLATFORM_SECRET,
  hostFor: (env) => new CloudflareScopeHost({ scope: env.SCOPE }),
  roles: ROLES,
  ownerRoleKey: 'hr-admin',
  onProvision:  (env, b) => identityDo(env, b).setPendingOwner(b.scopeId, b.owner),
  resolveOwner: (env, r) => identityDo(env, r).getOwnerOfRecord(r.scopeId),
  onConfigure:  (env, b) => identityDo(env, b).putConfig(b.scopeId, b.entries),
  ownerSeat:      (env, r) => identityDo(env, r).ownerSeat(r.scopeId),
  mintOwnerClaim: (env, r, i) => mintOwnerClaimLink(identityDo(env, r), r.scopeId, i.origin),
});

export default app;
```

## What it owns vs. what you supply

- **Generic routes** (`export`, `restore`, `bookmarks`, `rewind`, `snapshot`,
  `delete-scope`, `tables`, `tables/:table`, `query`, `platform-requests`,
  `platform-requests/settle`) — pure delegations to the scope host, owned entirely here.
- **Flavored routes** — `provision` (`onProvision`), `reconcile` (`resolveOwner`),
  `configure` (`onConfigure`), `owner-seat` (`ownerSeat`) and `owner-claim`
  (`mintOwnerClaim`). The platform keeps the secret gate, body parse, and response
  envelope; you supply only the hook. Omit `resolveOwner` / `onConfigure` / `ownerSeat` /
  `mintOwnerClaim` and that route answers `501`.
- **The gate** — one `/internal/*` middleware runs `assertPlatformCall`; an unset secret
  fails closed (`403`).
- **The error envelope** — registered last, so mounting the surface installs it.

The scope host is taken **structurally** (`VerticalScopeHost`), so this package depends on
neither `adapter-cloudflare` nor any concrete host.

## Self-enforcing

A vertical that never calls `mountPlatformSurface` has no `/internal/provision` and fails
to provision on first deploy and in its scenario test — louder than any lint.

## `createModelHost` — `@substrat-run/vertical-host/model`

Governance around a language-model call, provider-neutral: resolve `provider:model` against
platform-held credentials, consult the host's `guard`, run, and hand one `ModelUsageLine`
(reported tokens, rate-card list price, five fixed attribution keys) to the host's `record`.
Lives around operations, never inside a scope's transaction. See the reference page.
