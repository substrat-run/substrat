# @substrat-run/contracts

The **source of truth** for every data shape that crosses a Substrat boundary. Schemas
are written in [Zod](https://zod.dev), so the reviewed artifact *is* the runtime
validator — OpenAPI and JSON Schema documents are emitted from this package, never
hand-maintained beside it.

```sh
pnpm add @substrat-run/contracts zod
```

## IDs (`ids.ts`)

Branded ULID types — opaque, sortable, no PII, and unmixable at compile time:

| Schema | Type | Notes |
|---|---|---|
| `tenantId` | `TenantId` | |
| `scopeId` | `ScopeId` | a `ScopeId` won't typecheck as a `TenantId` |
| `principalId` | `PrincipalId` | a tenant subject |
| `platformActorId` | `PlatformActorId` | a control-plane staff subject — branded apart from `PrincipalId` so the two can't be confused |
| `eventId` | `EventId` | |
| `dataSubjectId` | `DataSubjectId` | keys crypto-shredding erasure |
| `moduleId` | `ModuleId` | npm-package-shaped: `@substrat-run/engine-workorder` |
| `instant` | `Instant` | ISO 8601 with timezone; stamped kernel-side |
| `permissionKey` | `PermissionKey` | module-namespaced: `workorder:create` |
| `slug` | — | URL-safe identifier |

```ts
import { tenantId, type TenantId } from '@substrat-run/contracts';

const t: TenantId = tenantId.parse(input); // validated + branded
```

IDs are deliberately meaning-free: they appear in logs and billing systems outside any
jurisdiction, so they must never encode anything.

## Tenancy (`tenancy.ts`)

`tenant` / `Tenant`, `scope` / `Scope`, plus `tenantStatus`, `scopeStatus`,
`storageShape` (`'A' | 'B'`) and `jurisdiction` (`'eu' | 'us' | 'global'`, plus
`provisionableJurisdiction` — the subset the control plane currently accepts), and `createTenantInput`.
Also `org` / `Org` and `createOrgInput` — organizations inside a tenant, which
membership tuples point at and `grantToOrg` targets. `migrationFailure` on a scope is
non-null when its last migration attempt failed, which is what stops a scope that
serves nothing from rendering as healthy. See [Tenants & scopes](/concepts/tenancy).

## Control plane (`control-plane.ts`)

`adminAction` (the enum of audited control-plane mutations) and `adminLogEntry` /
`AdminLogEntry` — one append-only audit row: actor, action, target, before/after,
timestamp. `tenantId` is nullable for platform-level actions that target no tenant;
`causedBy` holds the id of the event that caused the action, when one did, which is what
joins the two halves of the [connector seam](/concepts/events#the-connector-seam).

Identity lives here too: `identityLink`, `resolvedIdentity`, `identityPool` /
`poolTopology` (`'central' | 'tenant-bound'` — whether the same external subject id in
two tenants is one human or two), and `orgMembership`, whose `revokedAt` is a tombstone
rather than a deletion. See [The platform layer](/concepts/platform) and
[Authentication & identity](/concepts/identity).

## Events (`events.ts`)

- `entityRef` / `EntityRef` — the opaque `(entityType, entityId)` reference everything
  generic binds to.
- `piiClass` — `'none' | 'pseudonymous' | 'direct'`, required on every event.
- `domainEventInput` — what module code passes to `emit()`; origin fields deliberately
  absent.
- `domainEvent` — the full kernel-stamped envelope.
- `actor` — a `PrincipalId` or `{ system: ModuleId }`.

The schema enforces the crypto-shredding invariant: a PII-classed event without a
`subjectId` fails validation. See [Events & audit](/concepts/events).

## Permissions (`permission.ts`)

The authored surface: `node`, `roleDefinition`, `roleAssignment`, `capabilityGrant`.
The evaluation representation: `objectRef`, `relationTuple` (internal to checkers).
The results: `decision` / `Decision` (proof-carrying discriminated union) and
`effectivePermissions`. See [Permissions](/concepts/permissions).

## Module manifest (`manifest.ts`)

`moduleManifest` / `ModuleManifest` — the self-description every module ships:
permissions, events (emits/consumes), migrations + skew window, attachment targets,
entity relations, entitlement key, searchables, UI contributions, `envSpec`
(`envVarSpec[]` — the declared environment that the Dashboard's Env form renders from),
and `schedules` (`scheduleSpec[]` — recurring work: `{ operation, cadence: { everyMinutes },
input?, permissions }` the platform sweep runs on every live scope under a system actor).
Field-by-field walkthrough in [Modules & the manifest](/concepts/modules).

`checkSubject` — who a permission check is *about*: `{ kind: 'principal' | 'connection'
| 'system', id }`. `systemGrant` grants a permission to a module's system principal
(`{ moduleId, permission, node, … }`), the scheduler analogue of `connectionGrant`.

## Vertical & version registry (`registry.ts`)

The registry shapes (#31): `vertical` / `Vertical` (slug, `source`, `ownerTenant`,
declared `envSpec`, install spec — entitlements/grants/capabilities/surfaces),
`verticalVersion` (digests + admission status — so *push is not live*), and the channel
records promotion moves a scope between. This is what turns the scope's nullable
`vertical` string into a pinnable record. See [The platform layer](/concepts/platform).

## Deploy manifest (`deploy.ts`)

`deployManifest` — the JSON a `substrat push` sends beside the module files (D-39),
re-parsed at the control-plane trust boundary and run through the §4 sandbox contract.
Carries `runtimeNeeds` (own-DO `storeNeed`s, per-tenant `tenantStoreNeed`s), the
permission registry, and `RUNTIME_BASELINE`. One schema, two parses, no drift.

## Connections (`connections.ts`)

The integrations hub's store (#101): `connection` / `Connection` and `connectionStatus`,
keyed on **(tenant, vertical, provider)** so one vendor's host code never reaches
another's credential. Everything here is metadata — the sealed credential never appears
in these shapes. See [The connector seam](/concepts/events#the-connector-seam).

## Scope introspection (`introspection.ts`)

The read-only "Data" window into a scope's own database (kernel-design §5.4):
`scopeTable`, `scopeTablePage` / `readScopeTableInput`, and the free-SQL `queryScope`
shapes — table-shaped and bounded, no write path to forge the spine.

## Routing (`routing.ts`)

The hostname map (K-26): `RouteTarget` (`hostname → (tenant, scope, vertical, surface,
region)` — what the environment router resolves), `hostnameBinding` / `HostnameStatus`
and its issuance/DNS records, plus `declaredSurface` and `surfaceName` (a scope fronts
many surfaces — storefront + back office — from one database).

## OpenAPI (`openapi.ts`)

`ApiCatalog` / `ApiOperationDoc` and the builder that renders a vertical's operation
catalog — the same Zod schemas its handlers parse — as an OpenAPI 3.1 document, so the
published contract cannot drift from the enforcement (D-22).

## Money (`money.ts`)

`money` / `Money` (decimal-string amount + ISO 4217 currency, both branded) and the
sanctioned arithmetic: `addMoney`, `mulMoney`, `moneyOf`, `addDecimal`, `mulDecimal`,
`compareDecimal` — exact micro-unit (6 dp) bigint arithmetic, half-up rounding. See
[Money](/concepts/money).

## Attachments (`attachments.ts`)

`visibility` — `'internal' | 'customer'`, the mandatory classification on every
attachment item that could reach a customer portal.

## Versioning

The package is semver'd and every event and manifest carries explicit schema versions.
Pre-1.0, shapes change without notice; from the first shipped vertical onward, breaking
changes to emitted schemas are CI-diffed and linted.
