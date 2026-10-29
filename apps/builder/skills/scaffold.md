# Scaffold — the first build

## The model is FIXED. Transcribe it.

`spec/model.ts` is approved and appears in your context. The entity model and the
operation surface are **decided** — transcribe them, never re-derive them:

| in the model | becomes |
|---|---|
| `defineEntities` | the migration DDL, and `manifestEntities(...)` in the manifest |
| `parents` | `entityRelations` — spread from `manifestEntities`, never hand-written |
| `defineOperations` | one registered operation per key, each checking its declared `permission` |
| `input` | the schema the handler parses — **import it, do not restate it** |
| `output` | the handler's return type, bound with `...operationsFor(operations)({ … })` in the registration |
| `emits` | the `ctx.emit` call, using `entityIdFrom` for the entity id |

Do not add an operation the model does not declare, rename one, or change an
input or return shape. **You cannot edit `spec/model.ts` — the write is refused.**

If the model is genuinely wrong — a declared return the handler cannot produce,
an operation that cannot be implemented as specified — that is real information,
and it goes **back to the model phase**. Say so plainly and stop. Do not reshape
the code to make a wrong model compile, and do not work around it: a build that
works around a wrong model is how a whole vertical comes to agree with a
contract nobody meant.

Import the engines' schemas rather than retyping them: `workOrder` is what an
operation returns, `workorderRow` is what the engine stores, and they differ.

---

Translate the approved spec/concept.md for everything the model does not carry —
behaviour, pricing, denials, the seed cast; never re-derive the domain. Its
sections map straight onto the build: cast and roles → seed roles/grants; the
thing that moves → engine composition; the data → migrations; who is denied
what → permission checks and portal grants; the scenario →
test/scenario.test.ts. If a needed decision is missing from the concept, take
it back to the builder — do not invent it here.

## package.json

Projects are standalone source repositories. Use published, pinned versions of
`@substrat-run/*` packages; platform dependencies must not use `workspace:`, `catalog:`,
`file:` or links to the platform checkout. `pnpm add --save-exact` resolves the available package version.
Typical dependencies: `contracts`, `kernel`, `adapter-sqlite`, plus the engines composed.
Scripts: `"typecheck": "tsc -p tsconfig.json --noEmit"`, `"test": "vitest run"`,
`"dev": "tsx src/server.ts"`. devDependencies: `typescript`, `tsx`, `vitest`, `hono`,
`@hono/node-server`, `@types/node`. Run `pnpm --ignore-workspace install` from the project
via run_command after changing package.json, and commit the project's `pnpm-lock.yaml`.
If `app/` has its own package.json, add a project-owned `pnpm-workspace.yaml` covering
`.` and `app` so a root install includes the UI. Internal project packages can use
workspace references; the platform packages still use published versions.

For a hosted release, declare `substrat.runtimeNeeds` with the Worker entry, runtime
requirements, own stores and asset build command. The Worker entry must use the hosted
adapter and the vertical host; the local SQLite server remains a development entry.
A release is built on the platform from saved source with a frozen lockfile, so local
build outputs and the platform checkout are never deployment inputs.

## The files

**src/manifest.ts** — the declarative surface:

```ts
import { moduleManifest, permissionKey } from '@substrat-run/contracts';
export const APP_PERM = {
  customerManage: permissionKey.parse('customer:manage'),
  jobPrice: permissionKey.parse('job:price'),
  portalReadOwn: permissionKey.parse('job:read-own'),
} as const;
export const appManifest = moduleManifest.parse({
  id: '@app/bikeshop', version: '0.1.0', kernelContract: '^0.0.1',
  permissions: [ // key + human description — these feed the permission review
    { key: 'customer:manage', description: 'Create and edit customers' },
    // …one per key
  ],
  events: { emits: ['bikeshop.job-priced'], consumes: [] },
  migrations: { journalDir: './migrations', compatibleFrom: '0.0.1' },
  entityRelations: [ // child → parent edges the permission walk follows
    { entityType: 'bike', parentType: 'customer' },
    { entityType: 'workorder', parentType: 'bike' }, // engine-made links must be declared too
  ],
});
```

Keep the perm consts beside the manifest so "add a permission" is one edit.
Permission keys are host-local vocabulary (`customer:manage` is fine); roles are
named for the persona.

**src/migrations.ts** — `export const appMigrations: SqlMigration[]` (from
`@substrat-run/kernel`). Tables prefixed `<app>_`, TEXT ids, ISO-8601 TEXT
timestamps, decimal/money as TEXT.

**src/module.ts** — operations + registration:

```ts
import { moneyOf, mulMoney, addDecimal, type EntityRef } from '@substrat-run/contracts';
import { assertAllowed, operationsFor, ulid, type ModuleRegistration } from '@substrat-run/kernel';
import { createWorkOrder, getReportedLines, completeWorkOrder, PERM as WO } from '@substrat-run/engine-workorder';
import { APP_PERM, appManifest } from './manifest.js';
import { appMigrations } from './migrations.js';
import { operations } from '../spec/model.js'; // the declared surface, approved in the model phase

export const appModule: ModuleRegistration = {
  manifest: appManifest, migrations: appMigrations,
  // the handlers, held to the declaration: each `input` is typed from it and already parsed
  // against it by the host — so a handler never declares or parses a schema of its own
  ...operationsFor(operations)({
    'bikeshop/create-job': async (ctx, input) => { // namespaced '<app>/op-kebab'
      assertAllowed(await ctx.check(APP_PERM.customerManage));
      // vertical work (price/label) + engine composition in ONE transaction:
      const wo = await createWorkOrder(ctx, { /* … */ });
      ctx.sql/* own side tables only */;
      ctx.link({ entityType: 'workorder', entityId: wo.id }, { entityType: 'bike', entityId: input.bikeId });
      ctx.emit({
        type: 'bikeshop.job-created', schemaVersion: 1,
        entity: { entityType: 'workorder', entityId: wo.id }, piiClass: 'none',
        payload: { /* fat — a consumer must never need a cross-module read */ },
      });
      return { id: wo.id };
    },
  }),
};
```

**src/seed.ts** — host + idempotent world:

```ts
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { workorderModule, PERM as WO } from '@substrat-run/engine-workorder';
export const MODULES = [workorderModule, appModule];
export function buildHost(dir: string) {
  const host = new SqliteScopeHost({ dir });
  for (const m of MODULES) host.registerModule(m);
  return host;
}
```

Seed: provision tenant+scope(s), define roles per tenant from engine PERM +
APP_PERM, assign them, create entities via `stub.invoke` (never raw SQL),
entity-narrowed grants for portal principals, persist the cast (principal ids +
names) to a JSON file so restarts reuse it. **Seed two tenants** — the second
is the attacker the scenario needs. Export `MODULES` and
`ROLES: RoleDefinition[]` (from `@substrat-run/contracts` — `{ key, permissions,
source: 'vertical' }`, the same table `defineRole` is fed) so the permission
surface is a build-time fact tooling can read, not something buried in seed
calls.

**src/routes.ts + src/server.ts** — the HTTP surface, split so tests can drive
it:

- `routes.ts` exports `mountApi(app: Hono, resolveStub: (c) => Promise<ScopeStub>)`
  — one explicit route per operation (`POST /api/<noun>`, never a generic
  `/api/:op` passthrough), each a thin wrapper over one `stub.invoke`. Shared
  `app.onError`: `PermissionDenied` → 403, refused transitions/guards → 409,
  unknown entity/scope/operation → 404, else 400. No business logic in routes.
- `server.ts` is only the boot harness: build the host ONCE at startup on a
  persistent `.data/` dir (never `:memory:`, never per request — data must
  survive between requests), run the seed, load the persisted cast, then
  `resolveStub` = `x-principal` header → cast entry → `getScope`. Missing or
  unknown header → 401. Serve with `serve` from `@hono/node-server` (Hono's
  `app.fetch` takes a web `Request` — do not hand-wire `node:http` to it). Read
  `PORT` from env (the studio sets it).

seed.ts and server.ts are harness code — node imports are fine THERE, never in
module code. The scenario test bypasses HTTP entirely, so `test/server.test.ts`
(see the iterate skill) is the only proof this layer works — write it in the
same turn as routes.ts, not later.

Ids are BRANDED types (`PrincipalId`, `TenantId`, `ScopeId` — zod-branded
strings from `@substrat-run/contracts`): a raw header/JSON string does not
typecheck where the kernel expects one, and a bare `as` cast is the wrong fix.
Brand at the boundary with the contracts schemas, and note `getScope` takes the
principal FIRST:

```ts
import { principalId, scopeId, tenantId } from '@substrat-run/contracts';
// Cast entries loaded from the persisted JSON re-brand on load:
const p = principalId.parse(entry.principal);
const stub = await host.getScope(p, tenantId.parse(entry.tenantId), scopeId.parse(entry.scopeId));
const result = await stub.invoke('app/op-name', input);
```

Ids minted in-process by seed/provisioning are already branded — pass them
through; parse only what crossed a serialization boundary (headers, JSON
files, env).
