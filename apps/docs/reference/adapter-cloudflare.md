# @substrat-run/adapter-cloudflare

The **Durable-Object scope host** — the production backing for the same scope-host
contract the [pure-SQLite adapter](/reference/adapter-sqlite) implements. One
SQLite-backed Durable Object per scope, a durable control-plane DO for the directory, and
a stateless coordinator that mints capability stubs.

Both adapters pass the **same** [conformance suite](/reference/contract-tests) unchanged
(decision 14), so a vertical developed and CI-tested on pure SQLite runs on Cloudflare with
no code change. Several verticals run deployed on it today, [OIDC-only](/concepts/identity)
against a shared relying party.

```sh
pnpm add @substrat-run/adapter-cloudflare
```

## The pieces

- **`ScopeDO`** — one scope = one SQLite-backed Durable Object. `defineScopeDO([…modules])`
  bundles the kernel, engines, and the vertical's modules into the DO at build time (a DO
  can't receive handler closures over RPC). Each operation runs inside
  `ctx.storage.transaction(async …)` — the DO analogue of `BEGIN IMMEDIATE … COMMIT`, which
  rolls back on a throw *across `await`s* — with strict per-scope serialization, lazy
  migrations on wake, manifest guards, and the outbox→consumer dispatch loop.
- **`ControlPlaneDO`** — the durable directory: tenants, scope lifecycle, roles,
  entitlements, identities, tenant-level tuples, and the append-only admin audit log. Under
  scope-local permissions (below) it is a **write-time** authority that projects into scopes,
  not a read-time dependency — and a CP-less vertical binds no control plane at all.
- **`CloudflareScopeHost`** — the coordinator. Stateless (rebuilt per request); it validates
  and gates against the control plane, then mints a `ScopeStub` that RPCs `invoke` into the
  scope's DO. Implements the same `ScopeHost` contract as the pure adapter. Its `controlPlane`
  binding is **optional**: omit it (with `scopeLocalPermissions`) for a CP-less vertical that
  provisions via `provisionScopeLocal` and trusts the router-asserted node.
- **`createRouteResolver`** (the `@substrat-run/adapter-cloudflare/routing` subpath) — resolves
  an inbound `hostname → RouteTarget` (tenant, scope, `deploymentRef`, `verticalSlug`) for
  Workers-for-Platforms dynamic dispatch. The environment [router](/platform/router) is built on
  it.
- **`cloudflareClientContext`** / **`cloudflareGeo`** — the one place `request.cf` is read.
  Normalises the edge's geo (country, region *name*, city, timezone, continent; the `T1` /
  `XX` sentinels become null; latitude, longitude and postal code are not carried) and
  joins it to the header half from contracts (`clientContextOf`) into a
  [`ClientContext`](/reference/contracts) — the shape a vertical takes as operation input
  on every runtime, so a desk can show "Safari 17 on iOS · Stockholm" without knowing
  which host it is on.
- **`definePlatformSweeperDO`** — the alarm-driven Durable Object that runs the platform's
  scheduled maintenance. A singleton (`PLATFORM_SWEEPER_NAME`) whose `alarm()` runs one
  `runPlatformSweep` pass — reaping expired previews, an archived scope's DO storage, and
  connection reconciliations — then re-arms itself. A DO alarm, not a cron, because a
  hosted vertical pushed into a dispatch namespace gets no `triggers.crons`; `ensureArmed()`
  is idempotent and self-arms from code. The workerd analogue of the kernel's node-side
  `startPlatformSweeper`.
- **`defineScopeSweeperDO`** — the *vertical's own* timer, and the piece a CP-less vertical
  cannot do without. Same singleton shape (`SCOPE_SWEEPER_NAME`, one alarm, one pass at a
  time), but the roster is this deployment's scopes and the pass is the work that must happen
  inside them: draining retryable executor deliveries and firing the
  [schedules](/concepts/modules#recurring-work-schedules) the manifest declares. The platform
  sweeper reaps and reconciles from above; this one runs *your* recurring work where your data
  is.
- **Per-tenant stores** — `createD1TenantStores` and `createR2BlobStores`, the platform's
  reach into a minted D1 database or R2 bucket. Worth understanding for what they are *not*:
  this is the **control-plane** path — minting at provision, out-of-band SQL, ops inspection.
  Request-time access is not HTTP at all. The serving script carries a real `d1` /
  `r2_bucket` binding per store, named by the contracts helpers, attached by the control plane
  at provision and re-derived from the ledger on every serving upload. A vertical is *handed*
  a store; it never mints one, and never learns a database id or bucket name.

## Usage (a Worker)

```ts
import { defineScopeDO, ControlPlaneDO, CloudflareScopeHost } from '@substrat-run/adapter-cloudflare';
import { workorderModule } from '@substrat-run/engine-workorder';

export const ScopeDO = defineScopeDO([workorderModule /*, …engines, vertical */]);
export { ControlPlaneDO };

export default {
  async fetch(req, env) {
    const host = new CloudflareScopeHost({ scope: env.SCOPE, controlPlane: env.CONTROL_PLANE });
    // authenticate → getScope → invoke (the Callout demo wires a full Hono API + Better Auth)
    const stub = await host.getScope(principal, tenantId, scopeId);
    return Response.json(await stub.invoke('workorder/list', {}));
  },
};
```

`wrangler.jsonc` binds `SCOPE` + `CONTROL_PLANE` as SQLite-backed Durable Objects
(`new_sqlite_classes`). Run it on real `workerd` with `wrangler dev` (no account needed);
deploy with `wrangler deploy` (DO SQLite needs a Workers Paid plan).

Two options change the topology:

- **`scopeLocalPermissions: true`** turns on projection-on-write — the host projects a tenant's
  roles and tenant-level tuples into its scopes on every tenant-level write, and those scopes
  evaluate permissions from their own storage. This takes the control-plane DO off the request
  hot path (see [Permissions](/concepts/permissions#where-tuples-live-a-scope-reads-only-its-own-state)).
  Default off. Enabling it for scopes provisioned earlier wants a one-time
  `reconcileTenantProjection` back-fill.
- **omitting `controlPlane`** makes a **CP-less** vertical: it binds no control-plane DO, holds
  its role definitions locally, receives only scope-level assignments, provisions via
  `provisionScopeLocal`, and trusts the router-asserted node for tenancy/lifecycle. This is what
  lets a vertical deploy as its own isolated Workers-for-Platforms script with no platform
  binding — the shape [Callout](/verticals/callout) ships in.

## How the semantics map

| Contract guarantee | Implementation here |
|---|---|
| strict serialization per scope (K-6) | per-DO operation queue — the DO input gate over-delivers, so serialization is enforced explicitly |
| scope storage isolation | one SQLite-backed DO per scope |
| transactional operation + rollback (K-4) | `ctx.storage.transaction(async …)` — commits on success, rolls back on a throw across `await`s |
| structured-clone boundary | the coordinator→DO RPC boundary itself |
| fail-closed addressing + lifecycle gates | validated in the `ControlPlaneDO` before the stub is minted |
| permission checks | tuple checker, evaluated entirely from the scope's own storage — scope tuples written locally, tenant tuples + roles **projected** in by the control plane at write time (`scopeLocalPermissions`); no per-request control-plane read |

## Status

The shared contract suites run **green in workerd against real Durable Objects** (one
runtime-late-registration test is skipped — a deployed DO bundle is code-time), the control
plane is durable, and a fleet of verticals is deployed on it. Landed since this page first
listed them as deferred:

- **Scope-local permissions** (`scopeLocalPermissions`, `provisionScopeLocal`) — the control
  plane off the request hot path, projection-on-write, and a CP-less host mode.
- **The `hostname → (tenant, scope, deploymentRef)` router** — `createRouteResolver`, feeding
  Workers-for-Platforms dynamic dispatch, with custom domains issued end to end.
- **Per-tenant D1 and R2** — minted by the platform at provision, handed to the vertical as a
  binding.
- **Both sweepers** — the platform's maintenance pass and the vertical's own scope sweep, each
  an alarm-driven singleton because a dispatch-namespace script gets no crons.
- **The outbound seams** — connector dispatch riding platform intents, the declared egress
  allowlist, and the platform email relay, so a CP-less vertical reaches the outside world
  without ever holding a credential.

Still deferred, honestly:

- the directory is a single control-plane DO; the tenant-root-DO + global-D1 split
  (kernel-design §3.2) is a later scaling/blast-radius refinement, and the many-scope fan-out
  cost of projection for the platform's own tenant is an explicit open question;
- per-jurisdiction DO ids (K-7) are not built yet;
- Shape B (DO control plane fronting per-tenant D1) is not built.
