---
description: "Two ways in: scaffold a working vertical with `npm create substrat`, or build a scope host, a module and one operation from the packages up in ten minutes."
---

# Getting started

Two ways in, and they answer different questions.

**[Scaffold a vertical](#quick-start)** is the one to take first: one command gives you a
project that installs, tests green, and already carries the instruction layer your AI editor
reads. It answers *"what does building on Substrat feel like?"*

**[The ten-minute host](#the-ten-minute-host)** builds the same thing from the packages up —
a scope host, a module, one operation, one invocation. It answers *"what is actually
happening under there?"*, and it is worth doing once even if you never write a host again.

::: warning Pre-release
Substrat is 0.x. Interfaces change without notice until the first vertical ships.
:::

## Quick start {#quick-start}

```sh
npm create substrat my-app
cd my-app && pnpm install
pnpm test
```

That last line is the point: the scaffold ships a **small working vertical** — a bike-repair
shop — that is green out of the box. It is a worked example, not a skeleton to fill in, and
the build flow reshapes it into your domain rather than asking you to start from a blank
file.

Then open the project in your AI editor and start the flow:

| editor | command |
|---|---|
| Claude Code | `/substrat` |
| Cursor | the `new-vertical` command |
| opencode | the `new-vertical` command |

All three read the same two files the scaffolder wrote: `AGENTS.md` (the rules an agent must
not violate) and `.substrat/playbook.md` (the build flow). The scaffolder writes the
skeleton; **the agent writes the vertical**.

### What you got

```
src/manifest.ts     what the module declares — permissions, events, entitlement key
src/migrations.ts   the append-only journal
src/module.ts       the operations
src/provision.ts    roles and the permission surface `substrat push` reads
src/seed.ts         a world to develop against
src/server.ts       a Node dev server (SQLite adapter)
src/worker.ts       the Cloudflare entry, via @substrat-run/vertical-host
test/scenario.test.ts
AGENTS.md · .substrat/playbook.md · .claude/ · .cursor/ · .opencode/
```

There is no `wrangler.jsonc` and you never write one. The `substrat` block in
`package.json` declares what the deploy needs — the entry, the durable-object stores — and
[`substrat push`](/guide/deploying) derives the rest.

### The gates

```sh
pnpm test              # the scenario, including the denials
pnpm lint:boundaries   # the layer rules
pnpm typecheck
```

`lint:boundaries` is the one to run early and often: it is the mechanical enforcement of the
[module code rules](/concepts/modules) — no raw database imports, no `fetch`, no `node:*`, no
writes to the spine, no reading another module's tables. It fails the build rather than
leaving a note in a review.

::: tip Never install `zod`
Substrat is on Zod 4, and **Zod schemas do not compose across copies or majors**. Mix two and
`z.object({ facility: entityRef })` — the pattern every engine uses — fails at runtime with
`expected a Zod schema`, pointing nowhere near the cause. Import `z` from contracts and the
versions cannot diverge:

```ts
import { z, entityRef, money } from '@substrat-run/contracts';
```
:::

---

## The ten-minute host {#the-ten-minute-host}

Now the same thing from below: a scope host on pure SQLite, a module with a migration and one
operation, and an invocation through a capability stub. No cloud account, no services — one
directory of `.sqlite` files.

```sh
pnpm add @substrat-run/kernel @substrat-run/contracts @substrat-run/adapter-sqlite
```

`@substrat-run/adapter-sqlite` uses [better-sqlite3](https://www.npmjs.com/package/better-sqlite3),
a native module. With pnpm 10+, allow its build script:

```jsonc
// package.json
{
  "pnpm": {
    "onlyBuiltDependencies": ["better-sqlite3"]
  }
}
```

### 1. Create a host and provision a scope

```ts
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { UNSAFE_allowAllChecker } from '@substrat-run/kernel';
import { tenantId, scopeId, principalId, platformActorId } from '@substrat-run/contracts';

const host = new SqliteScopeHost({
  dir: './data', // one .sqlite file per scope + _directory.sqlite
  checker: UNSAFE_allowAllChecker, // omit for the secure default: deny everything
});

const actor = platformActorId.parse('01JZX6ZH2E8Q4W9T3M5N7P0R2T'); // control-plane staff subject
const tenant = tenantId.parse('01JZX6ZH2E8Q4W9T3M5N7P0R2S');
const scope = scopeId.parse('01JZX6ZH2EAB4CD9EF3GH5JK2M');

// A scope belongs to a tenant, so the tenant record comes first. Entitlements are
// default-deny: grant the module's SKU flag or its operations won't resolve.
host.admin.createTenant(actor, { id: tenant, slug: 'acme', name: 'Acme' });
host.admin.grantEntitlement(actor, tenant, 'notes');
await host.provisionScope(actor, { tenantId: tenant, scopeId: scope, jurisdiction: 'eu' });
```

Every control-plane call takes a platform `actor` and is audited. Provisioning is
idempotent and journaled, and requires an existing active tenant. The `jurisdiction` is
fixed at creation, forever — data residency is a provisioning decision, not a runtime flag.

::: tip The checker choice is the security posture
`UNSAFE_allowAllChecker` grants everything to everyone and is named accordingly — use it
in tests and scratch scripts only. Omit the option and you get the real tuple checker,
which denies by default until roles and grants say otherwise. See
[Permissions](/concepts/permissions).
:::

### 2. Register a module

A module is a manifest + migrations + operations, and — optionally, though every engine and
vertical in this repo does it — the schemas the host parses those operations against.
Here's a minimal one (engines ship
this structure for you — see [What is an engine?](/engines/)):

```ts
import { z, moduleManifest } from '@substrat-run/contracts';
import { assertAllowed, ulid, type ModuleRegistration } from '@substrat-run/kernel';

const noteInput = z.object({ text: z.string().min(1) });

export const notesModule: ModuleRegistration = {
  manifest: moduleManifest.parse({
    id: '@acme/notes',
    version: '0.0.1',
    kernelContract: '^0.0.1',
    permissions: [
      { key: 'notes:write', description: 'Create notes' },
    ],
    events: {
      emits: [{ type: 'notes.created', schemaVersion: 1 }],
      consumes: [],
    },
    migrations: { journalDir: './migrations', compatibleFrom: '0.0.1' },
    attachmentTargets: [],
    entitlementKey: 'notes',
  }),
  migrations: [
    {
      version: '0001-init',
      sql: `CREATE TABLE notes (
        id         TEXT PRIMARY KEY NOT NULL,
        text       TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL
      );`,
    },
  ],
  operations: {
    'notes/create': async (ctx, { text }: z.infer<typeof noteInput>) => {
      assertAllowed(await ctx.check('notes:write' as never));
      const id = ulid();
      ctx.sql.exec(
        'INSERT INTO notes (id, text, created_by, created_at) VALUES (?, ?, ?, ?)',
        [id, text, ctx.principal, ctx.now()],
      );
      ctx.emit({
        type: 'notes.created',
        schemaVersion: 1,
        entity: { entityType: 'note', entityId: id },
        piiClass: 'none',
        payload: { noteId: id },
      });
      return { id };
    },
  },
  operationInputs: { 'notes/create': noteInput },
};

host.registerModule(notesModule);
```

Things to notice:

- **The host parses the input, not the handler.** `operationInputs` names the schema for
  each operation, and the host applies it before the guards and the handler on every path
  in — HTTP, in-process `invoke`, a seed, a schedule. A handler that parsed its own input
  would be a trust boundary each new operation has to remember; this one cannot be
  forgotten. A vertical with a declared operation surface hands the whole map over at once
  with `operationInputsOf(ops)` rather than listing names — see
  [Modules & the manifest](/concepts/modules#the-parse-the-host-owns). Leaving the map out
  is legal and means nothing was declared to parse, so the Zod object above would be
  compile-time only.
- **The permission check is the first line.** `assertAllowed` throws `PermissionDenied`
  unless the decision is an allow.
- **`ctx.emit` takes no origin fields.** Tenant, scope, actor, id, and timestamp are
  stamped by the kernel; your code physically cannot mislabel an event.
- **The row's timestamp is `ctx.now()`, not `new Date()`.** Module code has no clock of
  its own — `ctx.now()` is an ISO 8601 instant, stable for the whole invocation, so the row
  and the event announcing it agree about when. `new Date()` / `Date.now()` in module code
  is a [boundary-lint R6](/reference/boundary-lint) violation, and a scaffolded project
  fails its own gate on it.
- **Migrations apply lazily per scope**, journaled, inside the scope's serialization
  domain — you never run a migration step yourself.
- **`id TEXT PRIMARY KEY NOT NULL`, not `id TEXT PRIMARY KEY`.** In SQLite a non-INTEGER
  primary key does not imply `NOT NULL`. In a real vertical you would not write the DDL at
  all — [`emitTables`](/reference/model-emit) derives it from your declared entities and
  cannot produce that hole.

### 3. Invoke through a stub

```ts
const principal = principalId.parse('01JZX6ZH2EXY4ZA9BC3DE5FG2H');

const stub = await host.getScope(principal, tenant, scope);
const { id } = await stub.invoke<{ id: string }>('notes/create', {
  text: 'first note',
});

await host.close();
```

`getScope` validates the `(tenantId, scopeId)` pair against the directory. A mismatched
pair **throws** — it never resolves to another tenant's scope, so a confused-deputy bug
in calling code fails closed instead of leaking data.

The stub is a capability: it carries the principal and the scope context, so the
operation handler receives ambient `ctx.tenantId` / `ctx.scopeId` / `ctx.principal` and
no IDs travel through your business logic.

### 4. Look at what happened

Scope databases are plain SQLite files in WAL mode — debugging is opening a file:

```sh
sqlite3 ./data/<tenantId>__<scopeId>.sqlite 'SELECT * FROM notes;'
sqlite3 ./data/<tenantId>__<scopeId>.sqlite 'SELECT type, tenant_id, actor, occurred_at FROM _substrat_outbox;'
```

The event row carries the full kernel-stamped envelope — that's your audit trail,
produced as a side effect of the write path rather than as something you remembered to
log. Nothing in the code above asked for it.

From inside an operation you read the same rows through
[`readTimeline`](/concepts/events#reading-one-entity-s-history) rather than by hand — it
decodes `actor` out of the union the column stores it as, and pages on the event id.

## Next steps

- [Running locally](/guide/running-locally) — the development loop, the demos, the personas
- [Deploying a vertical](/guide/deploying) — the `substrat` CLI, `push`, and the admission gate
- [The model](/concepts/model) — declaring entities and operations once, and what the compiler
  then checks between them
- [Tenants & scopes](/concepts/tenancy) — the tenancy tree and how scopes are addressed
- [Permissions](/concepts/permissions) — roles, grants, and proof-carrying decisions
- [Events & audit](/concepts/events) — the envelope, PII classes, and consumers
- [What is an engine?](/engines/) — using the work-order and invoicing engines instead of
  writing your own machinery
- [`@substrat-run/contract-tests`](/reference/contract-tests) — if you're writing an adapter
  rather than a vertical
