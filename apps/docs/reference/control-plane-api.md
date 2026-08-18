# @substrat-run/control-plane-api

The **HTTP surface over [`HostAdmin`](/reference/kernel)** — the audited control-plane
transport (control-plane.md §4.5). It is the seam between the platform's admin
operations (provision a scope, bind a hostname, grant a role, deploy a vertical) and
whatever runs them: the CLI, the Console, and the Dashboard all call this one surface.

It is a **transport, not a source of truth**. Every route lands on a `HostAdmin` method,
every mutation is audited there, and the same API runs over any scope host — the
[pure-SQLite adapter](/reference/adapter-sqlite) in CI, [Durable Objects](/reference/adapter-cloudflare)
in production.

```sh
pnpm add @substrat-run/control-plane-api
```

## `createControlPlaneApi`

A [Hono](https://hono.dev) app that exposes `HostAdmin` over HTTP, with authentication and
the audit trail wired in. It takes a `ScopeHost` (whose `.admin` is the `HostAdmin` it
projects) plus the auth, deploy, and observability seams, and returns a plain Hono app you
serve on Node, Workers, or in tests:

```ts
import { createControlPlaneApi } from '@substrat-run/control-plane-api';

const app = createControlPlaneApi({ host /* ScopeHost */, /* auth, deploy, … */ });
export default app;
```

Every request is authenticated to a **`PlatformActorId`** (staff SSO/session) or a
**builder** principal (a scoped push token), and that actor is the same one `HostAdmin`
stamps into every audit row — the transport never invents authority, it carries it.

## The surface

Route groups map one-to-one onto the `HostAdmin` capability groups:

- **Tenants** — `/tenants` (+ `/status`, `/reap`, `/identities`, `/entitlements`): the
  tenant registry, lifecycle, identity links, and per-tenant SKU grants.
- **Scopes** — `/scopes`, `/tenants/:t/scopes/:s` and its lifecycle verbs (`configure`,
  `version`, `snapshots`, `restore`, `rewind`, `bookmarks`, `reap`), the read-only data
  window (`tables`, `tables/:table`, `query`, `export`, `health`), and `/fleet/migrations`.
- **Verticals** — `/verticals` (+ `versions`, `versions/:id/admit`|`reject`, `channels`,
  `channels/:c/promote`, `deploy`, `instances`, `listing`, `publish-request`,
  `install-block`): the registry, admission, promotion, and the deploy path. A vertical has one
  channel — `prod` ([dev/staging retired](/concepts/deploying#the-one-channel-prod)); `channels/:c/promote`
  refuses a non-`prod` channel with a `400`.
- **Hostnames** — `/hostnames` (+ `/status`, `/verify`): the K-26 hostname map and its
  Cloudflare-for-SaaS issuance/verification.
- **Connections** — `/tenants/:t/connections` (+ `/verify`, `/credential`, `/activity`,
  `/connection-grants`): the integrations hub. A credential is *verified against the
  provider* when it is connected rather than merely stored, `/credential` says which one is
  loaded without revealing it, and `/activity` reads what the connection actually did.
- **Copies and erasure** — `/directory/backups` and `/directory/restore` for the directory
  itself, `/scopes/:s/backups` and `/snapshots` for a scope, and
  `/scopes/:s/subjects/:id/shred`, which redacts the spine payloads and destroys the sealing
  key in one audited, idempotent call — returning **a receipt the DSAR response is written
  from**. Deliberately staff-only: a builder forwards the request, the platform executes it.
- **Platform grants** — `/verticals/:slug/email-sender` and
  `/verticals/:slug/tenant-provisioner`: the capabilities a vertical must be *granted*
  rather than configure for itself.
- **Roles**, **admin-log**, **ops-failures**, **meters**, and **observability**
  (`/observability/logs`, `/observability/metrics`) — the permission surface, the
  append-only audit history, operational failures, billable readings, and fleet telemetry.
- **`/push-tokens`** — mints the scoped builder tokens a `substrat push` authenticates with.

Routes are the shape only; enumerate the [OpenAPI](/reference/contracts) document for the
exact request/response schemas. The package also ships the typed clients that consume this
surface — `ControlPlaneClient` (Console/CLI) and the narrowed, tenant-scoped `VerticalClient`
(an app provisioning itself) — plus the deploy helpers (`deployManifest`, `createWfpUploader`)
that validate a bundle against the sandbox contract and upload it to Workers-for-Platforms.

## The audited-transport role

The one property that must not be retrofitted (K-20): a surface that can act on the
directory without a durable record of *who* acted is worse than none. This package is that
guarantee at the network edge — it authenticates the actor, forwards to `HostAdmin`, and
lets the kernel write the append-only row. Staff auth (SSO, MFA) gates *exposing* the
surface; the audit property is built into it. See
[The control plane](/platform/control-plane).

## Versioning

`0.25.0`, AGPL-3.0. Pre-release (0.x): the surface changes without notice until the
platform GAs.
