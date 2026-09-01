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

### It also mounts the MCP surface

The same call renders those operations a second way: an
[MCP](https://modelcontextprotocol.io) endpoint at `${basePath}/mcp`, one tool per
operation that declares `http`, dispatching through the same `resolveStub` and the same
permission checks. On by default and zero rows of setup — `mcp: false` in the options
turns it off, and `mcp: { path, serverInfo }` configures it. Per operation, `mcp: false`
keeps a machine-facing route out of the tool list.

`mcpToolsOf(operations)` is exported so a vertical can see or assert its own tool surface
without standing up a server. See [the MCP surface](/concepts/mcp).

### The scope host is structural

`hostFor` returns anything satisfying the `VerticalScopeHost` interface — the `…Local`
methods plus the introspection and platform-request reads. The package therefore depends on
neither `@substrat-run/adapter-cloudflare` nor any concrete host, and a future adapter fits
the same shape.

### Self-enforcing

A vertical that never calls `mountPlatformSurface` has no `/internal/provision`, so it fails
to provision on first deploy and in its scenario test — louder than any lint could be.

## `mountPublicSurface(app, options)`

A surface anybody's browser may call, from a page you never served — a support widget, an
embeddable booking form. The other two mounts both assume a caller: `mountPlatformSurface`
is gated by the platform secret, `mountOperations` resolves a stub from whatever the vertical
authenticated. A visitor in a chat bubble has neither, and never gets a principal.

```ts
import { mountPublicSurface } from '@substrat-run/vertical-host';

mountPublicSurface(app, {
  service: 'widget',          // the service principal this surface runs as, named by you
  basePath: '/widget',
  resolveActor: async (c, { origin, service }) => {
    const desk = await deskFor(c, origin);           // which install — from the request, never the body
    if (!desk) return null;                          // → 403, same answer as an unlisted page
    const stub = await stubFor(desk, service);
    const invoke = <T,>(op: string, input: unknown) => stub.invoke(op, input) as Promise<T>;
    const { origins } = await invoke<{ origins: string[] }>('desk/widget-origins', {});
    return { invoke, allowedOrigins: origins };      // read LIVE, per request
  },
  routes: (route) => {
    route.post('/sessions', async (c, { actor, origin }) =>
      c.json(await actor.invoke('desk/widget-start', { origin })),
    );
  },
});
```

Three properties, and they are the reason this is platform code rather than a snippet:

1. **It runs as a declared service principal, and only that.** No header, cookie or body
   field on a public request selects an actor — you name one service at mount, and every
   call is invoked as whatever `resolveActor` answers for it. A public surface that can be
   talked into a different principal is not public, it is unauthenticated privilege.
2. **CORS is answered in middleware, from an async resolver, per request.** Not
   `hono/cors`: its `origin` callback is synchronous, so an allowlist living in a scope has
   to be cached at boot — and the cached copy disagrees with the live one the moment an
   admin edits it. The **preflight** is the first place the live list has to be true, since
   a browser that cached a permissive one never sends the request.
3. **The refusal happens before the handler.** Withholding `access-control-allow-origin`
   stops a browser *reading* a response; it does nothing to stop the write behind it. So an
   unlisted origin never reaches a route, and a page holding a leaked session token cannot
   post from an origin the install never listed.

The `Origin` **header** is what is checked — a browser sets it and a page cannot forge it —
never a body field, which would be a suggestion. Refusals are *thrown*, so they go through
the same `onError` every other refusal on the worker does. Paths are relative to `basePath`,
so a route cannot be declared outside the middleware guarding it, and the preflight
advertises exactly the methods the surface registered. `demos/ticket0` is the worked
reference. Rate limiting is not here yet.

## `createModelHost(options)` — from `@substrat-run/vertical-host/model`

The platform's model host: governance around one language-model call, provider-neutral.
Master plan §5.7 / D-18 splits the AI capability in two — the model is an adapter (any row
of [`@substrat-run/model-providers`](/reference/model-providers)), the governance is the
kernel's — and this is the governance, at the host layer:

```ts
import { createAnthropic } from '@ai-sdk/anthropic';
import { createModelHost } from '@substrat-run/vertical-host/model';

const models = createModelHost({
  env,                                        // the worker's own bindings — platform-held credentials
  aiBinding: env.AI,                          // the Workers AI binding: the cloudflare row then needs no credential
  factories: { anthropic: createAnthropic },  // the direct rows this bundle statically carries
  guard: async ({ spec, attribution }) => {   // policy, before the bytes go out — throw to refuse
    if (await spentToday(attribution.tenant) > budget) throw new Error('daily budget exhausted');
  },
  record: (line) => ledger.write(line),       // the one fact every call produces
});

const run = await models.run({
  spec: 'cloudflare:@cf/meta/llama-3.1-8b-instruct-fast',   // whatever the tenant picked
  attribution: { tenant, scope, vertical, version, operation: 'ticket0/answer' },
  system, prompt, maxOutputTokens: 400,
});
run.text;        // the answer
run.line;        // the ModelUsageLine, already handed to `record`
```

What it does, in order: resolve the spec against **platform-held** credentials (only the
row's own variables — never a per-install token); consult `guard`; run; turn the AI SDK's
usage into one `ModelUsageLine` — token counts as the provider reported them
(`reported: false` and zeros when it reported none; never an estimate that becomes a
bill), `listUsd` from the rate card on our side (`null` for a model the card does not
know — unpriced, not $0), and the **five fixed attribution keys** `tenant / scope /
vertical / version / operation` (the smallest per-request metadata limit among the
providers we route through is five, so a sixth key is refused at the line rather than
silently dropped on the wire). A `record` that throws fails the run: a call that could not
be recorded must not look like one that was.

`status(spec)` answers a settings screen — is this row configured on the platform, and
what is it missing — without running anything.

It lives **around** operations, not on `OperationContext`: a model call is a multi-second
network round-trip, and holding a scope's transaction open across it would be the
"no network in module code" rule broken from the inside. A vertical calls it from its
harness and records the result through its own operations. Margin is not here either —
the line carries list price; the platform's rate lives beside entitlements.

## License

AGPL-3.0-only (dual-licensed commercially).
