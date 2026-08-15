# Scaffold — the first build

Translate the approved spec/concept.md; never re-derive the domain. Its
sections map straight onto the build: cast and roles → seed roles/grants; the
thing that moves → engine composition; the data → migrations; who is denied
what → permission checks and portal grants; the scenario →
test/scenario.test.ts. If a needed decision is missing from the concept, take
it back to the builder — do not invent it here.

## package.json

`@substrat-run/*` dependencies use version `"workspace:*"` (the project is a
workspace member — this resolves). Typical set: `contracts`, `kernel`,
`adapter-sqlite`, plus the engines composed. Scripts: `"typecheck": "tsc -p
tsconfig.json --noEmit"`, `"test": "vitest run"`, `"dev": "tsx src/server.ts"`.
devDependencies: `typescript`, `tsx`, `vitest`, `hono`, `@types/node`. Run
`pnpm install` via run_command after changing package.json.

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
import { z, moneyOf, mulMoney, addDecimal, type EntityRef } from '@substrat-run/contracts';
import { assertAllowed, ulid, type ModuleRegistration, type OperationHandler } from '@substrat-run/kernel';
import { createWorkOrder, getReportedLines, completeWorkOrder, PERM as WO } from '@substrat-run/engine-workorder';
import { APP_PERM, appManifest } from './manifest.js';
import { appMigrations } from './migrations.js';

const createJobInput = z.object({ bikeId: z.string(), title: z.string() });
const createJobOp: OperationHandler<z.infer<typeof createJobInput>, { id: string }> = async (ctx, raw) => {
  assertAllowed(await ctx.check(APP_PERM.customerManage));
  const input = createJobInput.parse(raw);
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
};

export const appModule: ModuleRegistration = {
  manifest: appManifest, migrations: appMigrations,
  operations: { 'bikeshop/create-job': createJobOp /* namespaced '<app>/op-kebab' */ },
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

**src/server.ts** — thin Hono wrapper: `x-principal` header → cast lookup →
`getScope` → `invoke`; one route per operation (`POST /api/<op>`);
`PermissionDenied` → 403, refused transitions/guards → 409, unknown → 404. No
business logic in routes. Read `PORT` from env (the studio sets it). seed.ts
and server.ts are harness code — node imports are fine THERE, never in module
code.

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

**app/** (when the concept wants a UI): Vite + React served against the API,
principal picker in the top bar, typed fetch wrappers over the routes, hash
routing with view state in the URL (`#/…` — refresh must not lose the screen).
Keep it in `app/` with its own package.json; the API proxies or serves it.
