# Substrat knowledge — approved concept → working vertical

Translate the approved spec/concept.md; never re-derive the domain. Its sections
map straight onto the build: cast and roles → seed roles/grants; the thing that
moves → engine composition; the data → migrations; who is denied what →
permission checks and portal grants; the scenario → test/scenario.test.ts. If a
needed decision is missing from the concept, take it back to the builder — do
not invent it here.

Your workspace root IS the project. The gates that must pass: `pnpm typecheck`,
boundary-lint, and the scenario test.

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
timestamps, decimal/money as TEXT. Append-only forever: never edit a shipped
version, only append the next.

**src/module.ts** — operations + registration:

```ts
import { z, moneyOf, mulMoney, addDecimal, type EntityRef } from '@substrat-run/contracts';
import { assertAllowed, ulid, type ModuleRegistration, type OperationHandler } from '@substrat-run/kernel';
import { createWorkOrder, getReportedLines, completeWorkOrder, PERM as WO } from '@substrat-run/engine-workorder';
import { APP_PERM, appManifest } from './manifest.js';
import { appMigrations } from './migrations.js';

const createJobInput = z.object({ bikeId: z.string(), title: z.string() }); // export for api.ts if used
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

Import `z` from `@substrat-run/contracts`, **never add `zod` as a dependency**
— a second zod copy fails at runtime with `expected a Zod schema`, pointing
nowhere near the cause.

The **pricing moment** pattern: read engine lines (`getReportedLines`) → apply
the vertical's price list (minimum-billing, dropped internal articles —
whatever the concept says) → call the engine's `completeWorkOrder` — one
transaction, invariants intact. Engine data is reached ONLY through such
exported in-scope functions; another module's tables are private even for
SELECT — need more fields on an engine entity? Add your own side table keyed by
the engine's id.

Portal listing is a proof walk, not UI filtering: iterate candidates and
`await ctx.check(perm, entityRef)` per entity; entity-narrowed grants plus the
declared `entityRelations` edges make the walk reach the owner.

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
is the attacker the scenario needs. Export `MODULES` and a `ROLES` map.

**src/server.ts** — thin Hono wrapper: `x-principal` header → cast lookup →
`getScope` → `invoke`; one route per operation (`POST /api/<op>`);
`PermissionDenied` → 403, refused transitions/guards → 409, unknown → 404. No
business logic in routes. Read `PORT` from env (the studio sets it). seed.ts
and server.ts are harness code — node imports are fine THERE, never in module
code.

**app/** (when the concept wants a UI): Vite + React served against the API,
principal picker in the top bar, typed fetch wrappers over the routes, hash
routing with view state in the URL (`#/…` — refresh must not lose the screen).
Keep it in `app/` with its own package.json; the API proxies or serves it.

## test/scenario.test.ts

Replay the concept's scenario headlessly against a temp dir via
`buildHost`/`stub.invoke`: migrations journal → happy path → **denials hold**
(wrong role; portal isolation between two customers; the cross-tenant attacker
gets `unknown scope`/`permission denied`) → pricing math exact → events
consumed → state machine can't skip. Truths that decide whether it's worth
anything:

- **Never a bare `.rejects.toThrow()`** — pin the message, or a typo'd
  operation name passes as a "denial". Pair every closed-door assertion with a
  control proving a neighbouring door is open, or the test passes just as
  happily with the engine unregistered.
- **Compute money literals with the real helpers** (`mulMoney`/`addDecimal`),
  never by hand: `fromMicro` strips trailing zeros, so 34 894,80 serialises as
  `'34894.8'` — asserting `'34894.80'` fails on a correct number.
- Do not re-test engine invariants (state machines, append-only) — verified in
  the engines, inherited by you.

## Conventions that prevent rework

- User-authored config is DATA, not code: if users shape schema/settings
  (content types, pricing rules), store rows + lazy idempotent defaults behind
  an admin permission — never user input into live DDL.
- Every link edge you traverse must be declared in some registered manifest's
  `entityRelations` — including edges engines create from refs you hand them.
- Money/decimals are strings via contracts helpers; IDs are `ulid()`; dates are
  ISO-8601 TEXT.
