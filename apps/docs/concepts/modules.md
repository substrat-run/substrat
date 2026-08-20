---
description: "Engines and verticals join a scope host the same way — as modules bundling a manifest, migrations, operations and consumers. Covers envSpec, schedules, and attachment contracts."
---

# Modules & the manifest

Engines and verticals join a scope host the same way: as **modules**. A module is one
registration object bundling a manifest, migrations, operations, and event consumers:

```ts
import type { ModuleRegistration } from '@substrat-run/kernel';

const registration: ModuleRegistration = {
  manifest,      // self-describing metadata (validated Zod document)
  migrations,    // ordered SQL, journaled per module, applied lazily per scope
  operations,    // 'workorder/create' → handler
  consumers,     // 'workorder.completed' → handler
};

host.registerModule(registration);
```

## The manifest

The manifest is what makes a module **self-describing** — to the kernel that loads it,
to the app shell that renders it, and to the agents that build on it. It's a Zod-validated
document (`moduleManifest` in `@substrat-run/contracts`):

```ts
export const workorderManifest = moduleManifest.parse({
  id: '@substrat-run/engine-workorder',
  version: '0.0.1',
  kernelContract: '^0.0.1',          // semver range of the kernel API it targets
  permissions: [
    { key: 'workorder:create', description: 'Create work orders' },
    // ...
  ],
  events: {
    emits: [{ type: 'workorder.created', schemaVersion: 1 } /* ... */],
    consumes: [],
  },
  migrations: { journalDir: './migrations', compatibleFrom: '0.0.1' },
  attachmentTargets: [{ entityType: 'workorder', readPermission: 'workorder:read' }],
  entityRelations: [{ entityType: 'workorder', parentType: 'facility' }],
  entitlementKey: 'workorder',
  envSpec: [                         // optional: config the deployment must provide
    { key: 'WEBHOOK_SECRET', description: 'Signing secret for inbound webhooks', secret: true },
  ],
  ui: { /* routes, nav, entityViews, widgets */ },
});
```

Field by field:

| Field | What it declares | Who consumes it |
|---|---|---|
| `id`, `version`, `kernelContract` | identity + the kernel API range this module targets | host, tooling |
| `permissions` | every key the module checks, with a description | permission review (the human-readable diff), admin UI, agents |
| `events.emits` / `events.consumes` | the module's event contract, schema-versioned | host wiring, compatibility checks, agents |
| `migrations` | journal location and `compatibleFrom` — the oldest schema this code tolerates (the skew window) | migration runner |
| `attachmentTargets` | entity types that accept attachments (documents, comments), and which permission gates reading them | kernel attachment services |
| `entityRelations` | parent edges (`workorder → facility`) that permission flows along | the [permission evaluator](/concepts/permissions) |
| `entitlementKey` | the SKU flag that gates loading this module for a tenant | entitlements / billing |
| `ownerGrants` | permissions a fresh install's owner holds on day one (marketplace install); scope-provisioning verticals only | dashboard install, registry |
| `entitlements` | the full entitlement set an install grants (own + composed); absent ⇒ derive from `entitlementKey` | entitlements, registry |
| `provides` / `requires` | named capabilities this vertical offers (`oidc-issuer`) or delegates to — wired tenant-side via the connection store | capability wiring, registry |
| `envSpec` | declared environment variables (label, description, placeholder, `required`, `secret`) a deployment must provide | host/console config forms — carried on the registry (see below) |
| `guards` | manifest-declared operation pre-conditions: a named predicate the kernel runs inside the operation's transaction, before the handler (a throw blocks it) | kernel |
| `schedules` | recurring work — operations the platform invokes on every live scope of this vertical, on a cadence, under a system actor (a date-triggered business rule) | the platform sweep ([recurring work](#recurring-work-schedules)) |
| `withdraws` | operation names whose default binding this module suppresses — the name stops resolving, so a vertical can re-offer the transition behind its own guarded operation | kernel operation resolver |
| `searchables` | entity types and fields to index for search — the kernel derives a per-scope FTS5 index and the triggers that maintain it | kernel ([Reads & scaling](/concepts/reads#finding-a-row-by-what-someone-typed)) |
| `api` | path to the emitted OpenAPI for the module's HTTP surface, if any | tooling / SDK generation |
| `ui` | routes, nav items, entity views, widgets — permission-keyed, composed into the vertical's app at build time | app shell |
| `ui.settingsPanels` | permission-keyed settings screens the shell mounts for the app | app shell |

Every field past `entitlementKey` is **optional and additive** (decision 28): a manifest that
omits them still parses, and adding one never breaks an existing module.

## Two manifests: authored in TypeScript, transported as JSON

Worth being precise, because "manifest" names two things. The **module manifest** above is
**TypeScript** — a typed object literal that `moduleManifest.parse(...)` validates. That
`parse` is a correctness gate (a malformed manifest throws at load), *not* a sign you author
JSON: you get full types, autocomplete, and refactoring across every field, and the keys in
`permissions` are the same branded `PermissionKey`s your operations check.

JSON appears in exactly one place — the **deploy manifest**, the envelope `substrat push`
assembles and POSTs to the control plane. It's JSON because it crosses a process and trust
boundary (the builder's CLI → the platform), and the same `deployManifest` schema re-parses it
on the far side. So the shape you *edit* is typed TypeScript; the "one big JSON that gets
parsed" is only the wire form, and only at the boundary where a wire form is unavoidable.

**The permission surface travels in that envelope.** The keys and descriptions, role templates,
and entity-grant *shapes* a vertical declares are carried in the deploy manifest as a
`registry`, content-hashed as `digests.permission` (D-39). It's derived from the same declared
surface the host registers (`MODULES` + `ROLES` + `ENTITY_GRANTS`), so it cannot drift from what
is enforced, and `PERMISSIONS.md` is the human-readable render of that same surface — the review
artifact for the permission checkpoint. Admission consumes it as a real permission diff between
two versions; any tenant-facing permissions view reads it back. The runtime grant table is
deliberately *not* in it: minted capability grants are scope-local tuples, reached only through
the admin-query RPC.

Two fields deserve special mention:

- **`ui.entityViews`** is the cross-engine rendering mechanism: a module that stores an
  opaque `EntityRef` can render the entity's card by looking up the view registered for
  its `entityType` — no imports between engines.
- **`entitlementKey`** is how the module system turns commercial: enabling an engine for
  a tenant is flipping an entitlement, and the kernel refuses to load what isn't
  entitled.

## Declared environment (`envSpec`)

A vertical **opts in** to a configuration surface by declaring `envSpec` — the environment
variables a deployment must provide, each self-describing:

```ts
envSpec: [
  { key: 'PUBLIC_ORIGIN', label: 'Issuer origin', description: 'The public URL of this app.',
    placeholder: 'https://app.example.com', required: true, secret: false, group: 'General' },
  { key: 'ADMIN_PASSWORD', label: 'Admin password', description: 'Bootstrap admin password.',
    placeholder: 'at least 8 characters', required: false, secret: true, group: 'Bootstrap' },
]
```

It's optional and additive — a vertical that declares nothing has no config surface.
`secret: true` marks a value that is **write-only** in any UI (masked, never echoed back) and
delivered as a secret; `group` sections the form; `required` is validated before deploy.

The spec **rides the registry**: when a vertical is registered (`registerVertical`), its
`envSpec` is stored alongside its slug. So a host or console can render a config form for **any**
registered vertical — a bundled builtin or a pushed builder vertical — without loading its
code. That is what makes opt-in a single edit in the manifest: declare `envSpec`, and the
[Dashboard](/platform/dashboard) shows a settings form for the app automatically. It evolves
with the manifest — re-registering a vertical refreshes its spec.

For a **pushed** vertical, `substrat push` reads `envSpec` from the vertical's `package.json`
`substrat` block (the same static, code-free source it reads `slug`/`name` from) and carries
it in the deploy manifest — the CLI never loads the built module, so the declaration must be
readable as data at push time.

::: tip Delivery depends on the app's shape
A **standalone** app (its own worker script) receives these as worker secrets/vars at deploy.
A **hosted** vertical (one script serving many tenants' scopes) can't use per-app worker
secrets — all its scopes share one script — so it takes per-tenant values through the
per-scope config it reads at runtime.
:::

## Recurring work (`schedules`)

Some business rules have no caller but the passage of time: a contract that becomes
active on its start date, a leave request that can no longer be approved once it has
already begun. The operation is ordinary — idempotent, permission-checked — it just
needs something to invoke it on a cadence. A vertical declares that in `schedules`:

```ts
schedules: [
  {
    operation: 'hr/expire-stale-requests',   // a registered module/verb operation
    cadence: { everyMinutes: 1440 },          // once a day
    permissions: ['absence:approve'],         // what the operation checks
    // input: { … }                           // optional static input, re-parsed by the op
  },
],
```

The [platform sweep](/concepts/platform#scheduled-work) enumerates every live scope of
the vertical and invokes the operation on each due one. Two things make it safe to run
unattended:

- **It is attributed to the schedule, never a person.** The invocation runs under a
  **system actor** — the emitted events read as `{ system: '@your/module' }`, not as
  whichever admin happened to be the last human to touch the data. Modelling a nightly
  job as a signed-in user is exactly the audit-trail laundering this exists to avoid.
- **`ctx.check` is still the only gate.** The `permissions` a schedule declares are
  granted to the module's system principal when a scope is provisioned, so the
  operation's own `assertAllowed(await ctx.check(…))` resolves the same way it does for
  any caller — a schedule can do exactly what it declares and no more. Those permissions
  appear in the vertical's [`PERMISSIONS.md`](/concepts/permissions#from-declaration-to-enforcement)
  under a *Scheduled work* section, so widening what a schedule may do lands in the
  reviewed diff. Revoking that grant for one tenant turns the schedule off for them —
  no special "disabled" flag, the operation just fails its own check closed.

`cadence` is a floor, not a guarantee of exact timing: a schedule fires no more often
than `everyMinutes`, and the sweep is what actually runs it (typically every couple of
minutes), so sub-sweep cadences round up. It is optional and additive like every field
past `entitlementKey` — a vertical that declares none has no recurring work.

::: tip Where it runs
The sweep must run in the vertical's **own** runtime, where its modules and scope data
live — a node server calls `startPlatformSweeper` at boot, a Cloudflare deployment arms
a `PlatformSweeperDO` alarm. See [the platform sweep](/concepts/platform#scheduled-work).
:::

## Migrations

Migrations are plain SQL, ordered and uniquely versioned per module:

```ts
migrations: [
  { version: '0001-init', sql: `CREATE TABLE workorder_orders ( ... );` },
]
```

Semantics:

- **Applied lazily per scope**, inside the scope's serialization domain, journaled in
  `_substrat_migrations` per (module, version). No global migration step; a scope
  migrates when it wakes.
- **Skew is a normal state.** With thousands of scopes, some will run the old schema for
  a window. `compatibleFrom` declares the oldest schema version the module's code
  tolerates; a reconciliation sweep wakes stragglers before the window closes.
- **Migrations are a human checkpoint.** They're deliberately plain SQL so review is
  review, not archaeology.

## Operations, consumers, and in-scope functions

- **`operations`** — the module's invokable surface, namespaced
  (`'workorder/create'`). Each default binding starts with its own permission check.
- **`consumers`** — event handlers keyed by event type; the types must appear in
  `manifest.events.consumes`. Idempotency required (at-least-once delivery).
- **In-scope functions** — plain exports (not registered anywhere) that a vertical's own
  operations can call to compose engine behavior in the same transaction. See
  [Operations & the scope host](/concepts/scope-host#in-scope-functions-vs-registered-operations).

## Attachment contracts and opaque refs

The kernel owns no entities, so everything generic binds to an opaque reference:

```ts
type EntityRef = { entityType: string; entityId: string };
```

Attachment contracts (documents, comments, activity, custom fields) attach to an
`EntityRef`; `attachmentTargets` declares which types accept them and which permission
gates access; `visibility` (`'internal' | 'customer'`) classifies every attachment item
so customer-portal exposure is a total, mandatory decision — like `piiClass`, a
classification only works if it was never optional.
