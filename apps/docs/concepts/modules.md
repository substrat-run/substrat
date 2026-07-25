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
| `envSpec` | declared environment variables (label, description, placeholder, `required`, `secret`) a deployment must provide | host/console config forms — carried on the registry (see below) |
| `guards` | manifest-declared operation pre-conditions: a named predicate the kernel runs inside the operation's transaction, before the handler (a throw blocks it) | kernel |
| `withdraws` | operation names whose default binding this module suppresses — the name stops resolving, so a vertical can re-offer the transition behind its own guarded operation | kernel operation resolver |
| `searchables` | entity types and fields registered for tenant-scoped search | search service |
| `api` | path to the emitted OpenAPI for the module's HTTP surface, if any | tooling / SDK generation |
| `ui` | routes, nav items, entity views, widgets — permission-keyed, composed into the vertical's app at build time | app shell |

Every field past `entitlementKey` is **optional and additive** (decision 28): a manifest that
omits them still parses, and adding one never breaks an existing module.

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
