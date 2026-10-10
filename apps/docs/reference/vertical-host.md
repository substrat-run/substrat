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
  transferOwner,   // hand the owner of record to another member (omit ⇒ 501)
  completeOwnerTransfer, // close that hand-over once seated and revoked (required with it)
  abandonOwnerTransfer,  // close an open hand-over without finishing it (omit ⇒ an abandon 501s)
  members,         // let the dashboard manage this app's members — vertical-auth's membersHook (omit ⇒ 501)
  onDeleteScope,   // (env, scopeId, tenantId?) — e.g. drop a scope from a registry (optional)
});

export default app;
```

`onDeleteScope(env, scopeId, tenantId?)` receives the tenant ID from current control planes,
so a vertical can remove the scope from a tenant-specific registry. Older delete requests
omit the tenant ID; handle `undefined` if the hook must support them.

### What it owns vs. what you supply

- **Generic routes** — `export`, `restore`, `bookmarks`, `migrations`, `rewind`, `snapshot`,
  `delete-scope`, `tables`, `tables/:table`, `query`, `history`, `facets`, `cause`,
  `effects`, `invocation`, `dead-letters`, `lifecycle-flow`, `operation-series`, `denials`, `denials/summary`, `capabilities`, `platform-requests`,
  `platform-requests/history`,
  `platform-requests/settle` — pure delegations to your scope host, owned entirely by the
  package. The table, query, denial and event reads (`tables`, `tables/:table`, `query`,
  `denials`, `denials/summary`, `capabilities`, `history`, `facets`, `cause`, `effects`, `invocation`, `dead-letters`, `lifecycle-flow`, `operation-series`) are how the
  control plane answers those questions for a *hosted* vertical, whose scope it cannot
  open itself: the transport delegates the read here, then records the K-24 access row
  for it as if it had served the read (see
  [`HostAdmin.recordDelegatedRead`](/reference/kernel)). `migrations` is delegated the
  same way but is schema metadata, and leaves no access row.
- **Connector write-back routes** — `connector-invoke`, `connector-attachment`,
  `connector-attachment/:attachmentId`, `connector-grant` — the far end of the shared
  control plane running this vertical's connectors (#574, #711): the connection directory
  and its sealed secrets live platform-side, so what comes *back* over these verbs carries
  no credential — an operation invoked as the connection, provider bytes in (multipart:
  a `meta` JSON field beside the `body` file) or out (the raw bytes, with the record in
  a header), and the `connection:<id>` grant tuple the first two are checked against.
  Each is authorized in the scope's own DO like any other caller, and the grant has no
  revoke mirror because every delegated call re-passes the platform's live-connection
  gate first. Generic in the same sense as the group above: owned by the package,
  answered by your host's `connector…Local` members.
- **Members** — `GET /internal/members`, `POST /internal/members/invite`, `…/role` and
  `…/remove`: the dashboard's Members section for an installed app. One scope per call. The
  platform names the `caller`, the signed-in person, and every change is bounded by what that
  person holds **in this scope** (the kernel's assignment bound, asked in the same scope task
  that writes): an invite through `assignScopeRoleBounded`, a role move through
  `changeScopeRoleBounded`, which takes the old role and grants the new one together or not at
  all, and a removal through `revokeScopeRolesBounded`. A refusal answers `403` naming what is
  missing and writes nothing. Every bound is over the roles the person holds in the scope,
  never an invite row's recorded role. A removal takes every scope role first (a refusal
  writes nothing), then withdraws the open invite, then unbinds every login, so an accept of
  the old link afterwards finds nothing. The roster lists each open invite with both the role
  it was minted at and the roles its principal holds now. The owner of record answers `409`: move it with `owner-transfer`. So does a principal
  holding a role outside the hook's `roles`, such as a service account. A role move for someone
  whose invite is still open answers `409` too: withdraw it and invite them again at the new
  role, so an open invite's recorded role is always the role it confers. Omit `members` and all
  four answer `501` (this app declares no member roles), which the dashboard shows as such.
- **Flavored routes** — `provision`, `reconcile`, `configure`, `owner-seat`,
  `owner-claim`, `owner-transfer` — the package keeps the platform-secret gate, body parse and response
  envelope; you supply only the hook. Omit `resolveOwner` / `onConfigure` / `ownerSeat` /
  `mintOwnerClaim` / `transferOwner` and that route answers `501`. The two owner-seat routes are how the
  dashboard sees whether anyone has claimed an instance, and mints the claim link that
  binds its owner once the first-sign-in window has closed (see
  [vertical-auth](/reference/vertical-auth)). `owner-transfer` is the hand-over. Your
  `transferOwner` hook moves the owner of record; the package then seats `to` in
  `ownerRoleKey`, revokes `from`'s, and calls `completeOwnerTransfer`, in that order, so the
  scope always has a live owner seat. Sending the same hand-over again finishes one a failure
  left open, and once it is closed, answers `done` and changes nothing. Only the scope-level
  seat is revoked: `fromRevoked: false` can mean `from` still holds the role at the tenant
  level, which the platform, not the vertical, takes back. A reconcile's lockout
  repair re-seats whoever the record names, so after a hand-over it brings back the new owner,
  never the old one.
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
redirect or a `WWW-Authenticate` a route chose survives. `demos/handlebar` and `demos/manyfold`
are the worked references.

## `mountOperations(app, operations, resolveStub, options?)`

One route per declared operation, from the same object the module registers — the seam that
reads `If-Match` (a stale tag → `412 precondition_failed`) and `Idempotency-Key` (a reused
key → `409 conflict`, a replay → the stored response with `Idempotency-Replayed: true`) on
every unsafe method, so a vertical never hand-parses either header. It maps the kernel's own
vocabulary to a status (`PermissionDenied → 403`, a `ZodError` → `400`, a runtime fault →
`502`) and re-throws everything else unchanged, so a vertical's domain errors reach
`app.onError` exactly as before — this decides the status, `problemResponse` decides the
shape. A throw that declared no code but whose sentence says "not found", "permission
denied" or "invalid transition" still gets 404, 403 or 409 for now; that reading is
deprecated and announced in the log
([API design](/concepts/api-design#_5-failures-are-data)), so declare the code instead. Two declarations that would dispatch identically fail at mount, naming both. The
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
methods plus the introspection and platform-request reads. Every member is required, and
the list grows with the routes above: beside the lifecycle halves (`provisionScopeLocal`,
`restoreScopeLocal`, `projectRolesLocal`, `exportScopeLocal`, `snapshotScopeLocal`,
`deleteScopeLocal`, `migrationBookmarksLocal`, `rewindScopeLocal`) it now needs
`appliedMigrationsLocal` (#1320) and the six event reads — `entityHistoryLocal`,
`facetEventsLocal`, `eventCauseLocal`, `eventEffectsLocal`, `invocationEventsLocal`, `deadLettersLocal` — plus the introspection trio
(`introspectScopeTables`, `introspectScopeTable`, `introspectScopeQuery`), the denial reads
(`listDenialsLocal`, `summarizeDenialsLocal`), the platform-request reads and settle
(`listPlatformRequests`, `listPlatformRequestHistory`, `settlePlatformRequest`), and the
connector write-back's far end (`connectorInvokeLocal`, `connectorAttachmentUploadLocal`,
`connectorAttachmentOpenLocal`, `connectorGrantLocal`). A host written against an older
list fails to compile, which is the point of the interface being structural. The package therefore depends on neither
`@substrat-run/adapter-cloudflare` nor any concrete host, and a future adapter fits the
same shape.

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

## `mountLiveReads(app, options)`

The route a page holds open to hear that something changed: `GET /api/live`, a WebSocket
subscription to the scope's change feed. A frame names the entity that changed, and the page
re-reads it through the operation it already calls. Mount it on both hosts:

```ts
import { mountLiveReads } from '@substrat-run/vertical-host';

mountLiveReads(app, {
  live: (c) => hostFor(c.env).liveReads,             // undefined on the pure host
  subscriber: async (c) => {
    const node = nodeFor(c.req.raw, c.env);          // tenant + scope, as the router asserted them
    const principal = await principalFor(c.env, c.req.raw);  // your own session: the principal only
    return principal ? { ...node, principal } : null;
  },
});
```

Take the tenant and scope from where the rest of your routes take them, the node the router
asserted for this request, and only the principal from the session. Never take the scope
from the session or from anything the client sent: the socket would then subscribe to
whichever scope the cookie or the query string named.

Register it before `mountOperations`. It decides four things, in this order:

1. **It is a WebSocket handshake.** Anything without `Upgrade: websocket` is `426` with
   `x-substrat-live: not-an-upgrade`, before anything else is asked. This is what makes the
   next rule safe: a browser's WebSocket API always sends `Origin`, while a plain cross-site
   GET carrying a `SameSite=Lax` cookie may not.
2. **The page asking is your own.** A browser sends cookies on a WebSocket handshake, and a
   WebSocket handshake is not subject to CORS. A `SameSite=Lax` session cookie does not
   help either, because another tenant's subdomain of the platform's domain is the same site.
   So the route compares the `Origin` header with the request's own origin, exactly (scheme,
   host and port), and answers `403` on any difference, including `Origin: null`. The host is
   not asked and `subscriber` is not called. A WebSocket handshake with no `Origin` did not
   come from a browser page, and goes through.
   Behind a TLS-terminating proxy on a self-hosted node server, the request's URL is `http`
   while the page's `Origin` is `https`, so the route answers `403`. That costs only the
   push: a client that keeps its poll as the floor, as ticket0's does, goes on polling.
3. **This host can push at all.** The pure host has no `liveReads`, so the route answers
   `501` with `x-substrat-live: poll`. That is the same header the hosted adapter sets on its
   own refusals, so a client that reads it keeps polling whichever end said no. The name is
   exported from `@substrat-run/contracts` as `LIVE_MODE_HEADER`, with its values as `LiveRefusal`.
4. **Who is asking.** Your `subscriber` callback, from your own session. `null` is `401`,
   never a subscription as some default principal.

The route does not decide what a subscriber hears. The scope checks every frame against the
`liveTargets` read permission your module declares, on that frame's entity, so subscribing
grants nothing. `path` moves the route; the gate moves with it. `demos/ticket0` is the worked
reference.

### Narrowing a feed to one entity

`subscriber` may also return `within`, an `EntityRef`. The feed then carries only frames about
that entity and what hangs beneath it through declared parent edges (what `ctx.link` and
`ctx.relink` write), the same walk a permission check makes. The principal's own check still
runs on every frame, so `within` can only take frames away. A screen watching one record
passes it to stop hearing the rest of the scope.

Two built roots go further. Each replaces the per-frame check with a check on the **root**,
and each frame is then a bare nudge (`{ kind: 'nudge', id, at }`) that names no event type and
no entity, because the subscriber may not be able to read each row beneath it. Both come from
`@substrat-run/kernel`, and a plain object of the same shape is refused: the builder is the
only way in.

- **`within: checkedWithin(entity, permission)`**: for a signed-in principal whose grant
  reaches the root but not each row the way a `liveTargets` key would. The principal must
  pass `permission` on `entity` at the handshake, or the route answers `403` with
  `x-substrat-live: forbidden`. The check runs again, once per socket, on every pass that has
  a row beneath the root to announce. If it refuses or throws, the scope closes the socket
  (`1008`) before sending anything, and the client's reconnect meets the `403`. A withdrawn
  grant, or a root moved out of the grant's reach, therefore ends the feed. ticket0's portal
  does this (`harness/portal-live.ts`): rooted at a conversation's public thread, checked on
  the customer's own `conversation:read-own`.
- **`within: vouchedWithin(entity, { because })`**: for a subscriber with no principal of its
  own, such as a visitor holding a session token. Your code proves access once, before
  subscribing, and nothing re-checks it, so a token revoked while the socket is open keeps
  receiving nudges until the socket closes. That is accepted for ticket0's widget
  (`harness/widget-surface.ts`), rooted at the visitor's session, because the nudge names
  nothing and every re-read it causes is checked again.

Prefer `checkedWithin` whenever there is a grant to check: authority then leaves with the
grant. For either one, root the feed at an entity whose subtree holds only what the caller may
see, because the walk is the row filter.

### A socket ends with its session

`subscriber` may return `expiresAt`, the instant the caller's credential stops being valid.
`AuthSubject.expiresAt` from `@substrat-run/vertical-auth` carries it: a session cookie's or a
bearer's `exp`. A handshake at or past it is refused, and the scope closes the socket (`1008`)
on its first pass at or past it, before sending anything, whatever the caller's grants still
say. A scope nobody writes to has no passes, so the scope also sets an alarm for the earliest
expiry among its sockets and closes them then. Without `expiresAt`, a socket lives until one
end closes it.

### How many sockets

One principal may hold 8 live sockets on a scope (`LIVE_SOCKETS_PER_PRINCIPAL`, the hosted
adapter's own limit). The next is accepted and closed at once with `LIVE_CLOSE.tooMany`
(`4429`), because a browser never sees a failed handshake's status, only a close code. A client
should read `4429` as "poll and stop asking", not as a reason to reconnect. It can import
`LIVE_CLOSE` from `@substrat-run/contracts/wire-headers`, which imports nothing, so a browser
bundle takes the close codes without the rest of the package. `checkedWithin` gates are asked once per
(principal, key, root) per pass, however many of those sockets share a root, when the scope
reads its permissions from its own storage. A scope that still reads them from the directory
asks once per socket instead (see below).

### How fresh a live decision is

Each frame is decided just before it is sent. A decision the pass reuses for a later socket or
row (a `checkedWithin` gate, the walk up from a row) is reused only while all three of these
still hold, checked against the clock immediately before each send:

- nothing has been written to the scope since the decision was made;
- no grant, tuple, parent edge or entitlement in the scope has reached its `expires_at` since
  the decision was made;
- the scope reads its permissions from its own storage. While it still reads tenant tuples,
  roles and org membership from the directory, a change there writes nothing in the scope, so
  the gate is asked again for every socket and row.

What stays open is a change that lands while a check is still being evaluated. It can let that
one evaluation's frame through: one nudge, after the change. Frames carry no content (a nudge
names no entity, and a `change` frame only names a row the subscriber could read when it was
checked). The next frame, the next pass and the client's poll all see the change. This is the
live-read freshness contract: a push is a hint that can be up to one evaluation stale, and the
read it prompts is checked as usual.

## `requestConnectUrl(request)`

How a vertical starts a provider consent round **itself** (#1310), for the case the
[connections hub](/connectors/) does not fit: the people connecting a new client company
to its bookkeeping provider work inside the vertical and have no dashboard account, and
there is no credential to paste until the round has happened.

```ts
import { requestConnectUrl, ConnectUrlRequestError } from '@substrat-run/vertical-host';

// module.ts — the authorizing act, and the only place a permission is checked
const connectClientBooks: OperationHandler<{ clientId: string }, ConnectRequest> = async (ctx, raw) => {
  assertAllowed(await ctx.check(PERM.manageIntegrations));
  // …
  return { provider: 'fortnox', subjectRef: client.id };   // no URL yet, and no secret ever
};

// server.ts — the effect
const request = await scope.invoke('crm/connect-client-books', { clientId });
const { url, expiresAt, vertical } = await requestConnectUrl({
  controlPlaneUrl: env.CONTROL_PLANE_URL,
  platformSecret: env.PLATFORM_SECRET,
  tenantId, scopeId,
  provider: request.provider,
  createdBy: principal,                       // the principal whose check just passed
  subjectRef: request.subjectRef,             // your name for what is being connected, echoed back
  returnUrl: `https://${host}/clients/${clientId}`,
});
return Response.redirect(url, 302);
```

The permission check lives in the operation and the call lives in the harness, the shape
the credential relay established: module code cannot `fetch`, and the authority behind a
connect URL is a decision the scope already made. The vertical never learns the provider's
client credentials, the consent code or the token — it receives a link and forgets it —
and the resulting connection is stamped `createdBy` the principal named here, so the audit
trail leads back to that `ctx.check` rather than to a platform actor. What the platform
decides, not the caller: which vertical the connection lands on is re-derived from the
directory's record for `(tenantId, scopeId)` and again at the callback, `returnUrl` must be
an https surface bound to this scope, `ttlSeconds` may not exceed 900 (a longer value is
refused with `400`, not clamped — 15 minutes is the ceiling, and the default when it is
omitted), and a provider with no platform consent round is refused, naming the paste door.
A refusal throws `ConnectUrlRequestError`, carrying the relay's status so a route can map
it. An *unreachable* control plane is a different failure: the `fetch` itself rejects, and
that rejection is passed through as-is — a `TypeError` with no `status` — so a handler
that wants to answer `502` for both catches the two separately. The call goes through
`POST /internal/connections/connect-url` on the control plane, under the platform secret
injected into every dispatch script.

## `mintConnectLink(request)`, `listConnectLinks(request)`, `revokeConnectLink(request)`

The **mailed** sibling of `requestConnectUrl`. A bookkeeping bureau's staff work in the
vertical, but the person who must approve at Fortnox is the client company's own
administrator, who has no account anywhere and opens the link days later from an inbox. A
connect URL lives fifteen minutes and cannot be withdrawn; a connect link is a row the
platform holds, so it is **single-use** (the platform's callback spends it before storing the
credential), **revocable**, and lives seven days unless you ask for up to thirty.

```ts
import { mintConnectLink, revokeConnectLink, ConnectLinkRequestError } from '@substrat-run/vertical-host';

// module.ts — the authorizing act, exactly as for requestConnectUrl
const inviteClientBooks: OperationHandler<{ clientId: string }, ConnectRequest> = async (ctx, raw) => {
  assertAllowed(await ctx.check(PERM.manageIntegrations));
  // …
  return { provider: 'fortnox', subjectRef: client.id };
};

// server.ts — the effect
const request = await scope.invoke('crm/invite-client-books', { clientId });
const { url, link } = await mintConnectLink({
  controlPlaneUrl: env.CONTROL_PLANE_URL,
  platformSecret: env.PLATFORM_SECRET,
  tenantId, scopeId,
  provider: request.provider,
  createdBy: principal,                       // the principal whose check just passed
  subjectRef: request.subjectRef,             // stored on the link, shown when you list it
  ttlSeconds: 14 * 24 * 60 * 60,              // optional: default 7 days, at most 30
});
await sendMail(client.fortnoxAdmin, url);     // mail the URL; keep link.id, not the URL
await scope.invoke('crm/record-books-link', { clientId, linkId: link.id }); // on your client row
```

**Keep the link id.** Store it on your own row beside the `subjectRef` it was minted for —
the client row, here. Reading and revoking a link both name it by that id; there is no
"every link this scope minted" read.

`listConnectLinks({ …, linkIds, provider?, outstanding? })` answers the named links (1 to
100 ids), newest first — each with its `status` (`outstanding`, `used`, `revoked`),
`expiresAt`, and once spent, `usedAt`, `accountRef` and `accountLabel` (for Fortnox: the
database number and the company name that consented). An id that is not one of this scope's
links is left out of the answer rather than refused. `revokeConnectLink({ …, linkId })`
withdraws one; it is idempotent, and a link that was already used answers `used` —
disconnect the connection instead. Both are permission-checked acts like the mint: the
operation checks and returns the ids, the harness calls the helper. Only this scope's links
are reachable; for a revoke, another scope's id is a `404`, the same as an unknown one.

Where the round ends is yours to choose. **Leave `returnUrl` out for a link mailed to someone
with no account on your surface** — the round then ends on the platform's own page, whose copy
sends the reader back to whoever sent the link. With a `returnUrl` (https, on a hostname
bound to this scope), success and every refusal return there, as for `requestConnectUrl`,
plus `link=<id>`; a spent, withdrawn, lapsed or unknown link arrives as
`?error=link_used`, `link_revoked`, `link_expired` or `link_unknown`. A link is refused for a
preview or a fork, and for a provider with no platform consent round. A refusal throws
`ConnectLinkRequestError` with the relay's status. The calls go through
`POST /internal/connections/connect-links`, `…/list` and `…/revoke` under the platform
secret. The tenant's admin also sees your outstanding links on the dashboard's integrations
card and can revoke them there.

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

## Trusting the edges

The code that reads what the router asserted about a request, and writes that assertion down.
It lived in the kernel until #1978; nothing in it needs a kernel guarantee.

- **`readRoutedNode(headers, options)`**, **`RouterAssertionError`** — the vertical's side of
  the router contract: read the `(tenant, scope, surface)` the router asserted over its service
  binding. A request with **no** assertion is legitimate — that is a standalone deploy — so it
  answers `null`; a present but unsigned, incomplete or malformed one throws.
- **`invocationLog(options)`**, **`withInvocationLog(worker, options)`**, **`invocationStampOf`**
  — one structured log line per invocation, stamped with the tenant and scope the router
  asserted: the two dimensions Cloudflare cannot record, because observability is keyed on the
  script and one vertical's script serves every tenant that installed it. A successful request
  otherwise emits no log event at all, so this line is what gives a tenant-facing log view any
  rows. The stamp is written from `readRoutedNode`'s *verified* answer, never from the header: a
  forged tenant would file chosen text on somebody else's dashboard, and an un-routed local
  invocation writes nothing. `withInvocationLog` is the same stamp around a whole module
  worker's `fetch`, and it is what the platform wraps every uploaded vertical in (#1893).
  Mounted as middleware, `app.use('*', invocationLog({ routerSecret }))` **first** on a Hono
  app, it writes the line itself when nothing outside stamped the request, and steps aside when
  something did: the two share one stamp per request through `invocationStampOf`, so a request
  is never logged twice. `pnpm lint:invocation-log` refuses a missing, late or secretless mount
  (#1418). The line's shape, `InvocationLogLine`, is the kernel's
  ([`invocation-line.ts`](/reference/kernel#trusting-the-edges)), re-exported here.
- **`assertPlatformCall`**, **`PlatformCallError`** — is the platform itself calling? Defined
  in [`@substrat-run/contracts/wire-auth`](/reference/contracts#subpaths-that-import-nothing),
  because the control plane checks it too, and re-exported here.
- **`kickFlags(setHeader)`** — both response flags that ask the router to act on a scope now
  rather than at the next sweep, as the scope stub options that raise them.

## License

AGPL-3.0-only (dual-licensed commercially).
