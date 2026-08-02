# @substrat-run/kernel

The kernel's **behavioral seams** in pure TypeScript. This package imports no platform
APIs — Cloudflare specifics live only in adapters, and every adapter must pass the same
[conformance suite](/reference/contract-tests).

```sh
pnpm add @substrat-run/kernel @substrat-run/contracts
```

## Scope host (`scope-host.ts`)

The adapter seam. Full semantics in
[Operations & the scope host](/concepts/scope-host).

| Export | Kind | Purpose |
|---|---|---|
| `ScopeHost` | interface | `getScope`, `getConnectorScope`, `getSystemScope` (the scheduler's door — a stub whose authority is a module on a timer, #383), `provisionScope`, `registerModule`, `defineOperation`, `registeredSchedules` / `runDueSchedules` (the recurring-work seam the platform sweep drives), `admin`, `close` |
| `ScopeStub` | interface | the capability — the only way code outside a scope reaches it |
| `OperationContext` | interface | what a handler sees: ambient `tenantId`/`scopeId`/`principal`, `sql`, `emit`, `check`, `entitlement`/`entitlements` (read a held SKU/quota at request time — the gate a CP-less vertical uses), `link` |
| `OperationHandler<I, O>` | type | `(ctx, input) => O \| Promise<O>` |
| `ConsumerHandler` | type | event consumer; at-least-once, must be idempotent |
| `ModuleRegistration` | interface | manifest + migrations + operations + consumers |
| `SqlMigration` | interface | `{ version, sql }` — ordered, journaled per module |
| `ScopedSql`, `SqlValue` | types | synchronous scope-local SQL: `query<T>()`, `exec()` |
| `ExecutorHandler` | type | `(admin, event) => void` — out-of-band host code effecting what a module asked for via an event (K-22). Registered with `registerExecutor`; receives `HostAdmin`, never `ctx`, because it acts with platform authority |
| `HostAdmin` | interface | the audited control-plane surface. Every mutation takes a `PlatformActorId` and writes an append-only audit row; directory reads take one too and record to the K-24 access log. The capability groups it now spans: **permissions & membership** (`defineRole`, `listRoles`, `assignRole`, `unassignRole`, `grant`, `grantToOrg`, `grantToConnection`, `grantToSystem` — the schedule's system-principal grant (#383), `addMember`, `removeMember`, `listMembers`); **organizations** (`createOrg`, `listOrgs`, `getOrg`); **the vertical + version registry** (`registerVertical`, `publishVersion`, `admitVersion`/`rejectVersion`, `promoteVersion`, `bindScopeVersion`, `setVerticalListed`, `verticalServing` — push-is-not-live admission, channels, and the stable serving script); **the hostname map** (`bindHostname`, `setHostnameStatus`, `setHostnameIssuance`, `listHostnames`, `resolveHostname` — the router's unlogged per-request read); **tenant registry** (`createTenant`, `setTenantName`, `setTenantStatus`, `listTenants`, `getTenant`, `reapTenant`); **scope directory + lifecycle** (`listScopes`, `getScopeRecord`, `activateScope`, `suspendScope`/`unsuspendScope`, `archiveScope`/`unarchiveScope`, `reapScope`, `rewindScope`); **scope introspection** (`listScopeTables`, `readScopeTable`, `queryScope`, `exportScope` — the read-only "Data" window into a scope's own database); **entitlements** (`grantEntitlement`, `revokeEntitlement`, `listEntitlements`); **the connections hub** (`createConnection`, `openConnection`, `listConnections`, `updateConnectionSecret`, `revokeConnection`, connector-state get/put/list — the integrations credential store); **identity** (`registerIdentityPool`, `linkIdentity`, `unlinkIdentity`, `resolveIdentity`, `listIdentityTenants`, `listIdentityLinks` — the per-tenant gather behind identity-link projection); and the logs (`auditLog`, `accessLog`) |
| `ProvisionScopeInput` | interface | tenant, scope, optional shape + jurisdiction (provisioned via `provisionScope(actor, input)`) |

## Permission checker (`permission-checker.ts`)

The evaluation seam — the model is kernel-owned, the engine is swappable. See
[Permissions](/concepts/permissions).

| Export | Purpose |
|---|---|
| `PermissionChecker` | `check(principal, permission, node, entity?) → Promise<Decision>` |
| `assertAllowed(decision)` | throws `PermissionDenied` unless allowed; the standard first line of an operation. Narrows the type to the proof-carrying allow. |
| `PermissionDenied` | the error class |
| `denyAllChecker` | **secure default** — denies everything |
| `UNSAFE_allowAllChecker` | test-only; grants everything via a synthetic proof tuple. The name is the warning. |

## `ulid()`

A dependency-free ULID generator — the ID scheme used everywhere
(`ids` in [`@substrat-run/contracts`](/reference/contracts)).

```ts
import { ulid } from '@substrat-run/kernel';
const id = ulid(); // '01JZX6ZH2E...'
```

## Guarantees adapters must uphold

Any `ScopeHost` implementation must provide — verified by
[`@substrat-run/contract-tests`](/reference/contract-tests):

- **Strict serialization per scope** — one operation at a time, to completion.
- **Structured-clone boundary** — inputs/results cloned both directions, even
  in-process.
- **Kernel-stamped events** — id, timestamp, tenant, scope, actor stamped below the API
  surface.
- **Fail-closed addressing** — mismatched `(tenantId, scopeId)` throws, never resolves
  elsewhere.
- **PII invariant at emit** — PII-classed events without `subjectId` are rejected.
