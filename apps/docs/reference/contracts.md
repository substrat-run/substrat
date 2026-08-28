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

The owner seat of a hosted scope (#925) is here as well: `ownerSeat` / `OwnerSeat` —
`claimed` | `unclaimed` | `unknown`, the bound `owner`, whether the plain first-sign-in
path is still `open` and until when, and whether a `claimLink` is outstanding — and
`ownerClaimLink` / `OwnerClaimLink`, the freshly minted `claimUrl` + `expiresAt` that
rides one exchange from the vertical through the control plane to the dashboard and is
persisted by nobody (the vertical keeps only its hash).

## Errors (`errors.ts`)

The failure vocabulary, one closed taxonomy for every layer (D-22 / RFC 9457):

- `errorCode` / `ErrorCode` — `unauthenticated`, `permission_denied`, `forbidden`,
  `not_found`, `conflict`, `validation_failed`, `precondition_failed`, `rate_limited`,
  `unavailable`, `internal`. A module never invents a code; it narrows one with a
  `reason` slug it owns (`conflict` + `reason: 'already_exported'`).
- `problem` / `Problem` — the wire body: the RFC 9457 members plus `code` and the
  per-code extensions in `PROBLEM_EXTENSIONS` (`permission_denied.permission` /
  `.entity`, `validation_failed.errors` as `validationIssue[]` — path, message, code —
  `precondition_failed.entity`, `rate_limited.retryAfter`). `PROBLEM_CONTENT_TYPE`,
  `PROBLEM_TYPE_BASE` and `problemTypeFor(code)` name the `type` URIs; `PROBLEM_CATALOG`
  and `DOCUMENTED_ERROR_CODES` are what the OpenAPI emitter documents.
- `substratError(code, message, extensions?)` — the one way to throw: it types *and*
  parses the extensions at the throw site. `SubstratError`, `isSubstratError`,
  `errorCodeOf`.
- `toProblem(err, instance?)` — any thrown value to a `Problem`, an unknown one becoming
  `internal` with nothing leaked; `problemForStatus` for the transport-level cases.
  `validationIssuesFrom(zodError)` is what turns a failed input parse into the
  `validation_failed.errors` member.
- `wireFailure` / `toWireFailure` / `fromWireFailure` — the same error carried across a
  structured-clone or RPC boundary and rehydrated as the same class on the other side.

See [Failures are data](/concepts/api-design#_5-failures-are-data).

## Pagination (`pagination.ts`)

The one list convention: keyset pages over the list's own sort key, `{ entries,
nextCursor }` out. `ListPage` (`limit`, `cursor`, `order` — the kernel-side params,
unset limit meaning *unbounded* for an internal caller), `listPageQuery` /
`ListPageQuery` (the HTTP query, which always defaults a page), `Page<T>` and
`CountedPage<T>` (`total`, opt-in per operation because it is a second query),
`pageOf` / `countedPageOf` / `mapPage` / `isPage` / `pageSchema`, `listLimitOf`
(`LIST_PAGE_DEFAULT` 20, `LIST_PAGE_MAX` 200 — one resolution for the HTTP layer,
`ctx.page` and handler-composed reads), the `Link` and `X-Total-Count` headers
(`PAGE_LINK_HEADER`, `PAGE_TOTAL_HEADER`, `PAGE_EXPOSED_HEADERS`, `nextPageLink`),
`LIST_SORT_PARAM`, and `pageVisible` — the over-fetch loop a per-row-filtered read owns.
See [Lists are pages, not dumps](/concepts/api-design#_4-lists-are-pages-not-dumps).

## Concurrency (`concurrency.ts`)

The wire half of optimistic concurrency (#129): `ETAG_HEADER` (`ETag`, always strong),
`IF_MATCH_HEADER`, `CONCURRENCY_EXPOSED_HEADERS`, `etagOf(version)` and
`ifMatchAdmits(ifMatch, version)`. The version itself is the ULID of the entity's last
event and lives in the kernel (`entityVersionOf`), because contracts sits below the
spine and must not know which table answers. A stale tag is a `precondition_failed`
`Problem` that deliberately does not carry the current version. See
[A read-modify-write says what it is writing over](/concepts/api-design#_7b-a-read-modify-write-says-what-it-is-writing-over).

## Idempotency (`idempotency.ts`)

The wire half of request idempotency (#116): `IDEMPOTENCY_KEY_HEADER`
(`Idempotency-Key`), `IDEMPOTENCY_REPLAYED_HEADER`, `IDEMPOTENCY_EXPOSED_HEADERS`,
`isValidIdempotencyKey` (`IDEMPOTENCY_KEY_MAX_LENGTH`), `canonicalJson` and
`requestFingerprint(operation, input)` — what makes two requests *the same request*, so a
second key use with a different fingerprint is a reuse (`IDEMPOTENCY_REUSED`, 409) rather
than a replay — plus `IDEMPOTENCY_RETENTION_MS` (24 h), `IDEMPOTENCY_RESULT_LIMIT` and
`IDEMPOTENCY_REPLAY_UNAVAILABLE`. The table that remembers the answer is the kernel's
(`_substrat_idempotency`). See [Writes are safe to retry](/concepts/api-design#_7-writes-are-safe-to-retry).

## Impersonation (`impersonation.ts`)

Acting as a principal with the real actor preserved (K-42): `beginImpersonationInput`
(tenant, scope, `principal`, a `reason` of at least `IMPERSONATION_MIN_REASON` characters,
`mode`, `minutes`), `impersonationMode` (`'read-only' | 'write'`), `impersonationSession`
/ `ImpersonationSession` and its `impersonationSessionId`, `impersonationStamp` (the
`{ session, actor }` pair every outbox row, denial and platform intent written under a
session carries), `impersonationFilter`, and the bounds — `IMPERSONATION_MAX_MINUTES`
(60, an over-ask is refused rather than clamped), `IMPERSONATION_DEFAULT_MINUTES` (15),
`DEFAULT_IMPERSONATION_LIMIT`.

## Denials (`denial.ts`)

The refused-check log's shapes (K-35): `permissionDenial` / `PermissionDenial`,
`denialFilter` (actor, permission, operation, `since`/`until`), `denialBucket` and
`denialSummary` (per actor and key, busiest first, with the window's own floor), and
`DEFAULT_DENIAL_LIMIT` / `DENIAL_LIMIT_MAX`. Read through `HostAdmin.listDenials` /
`summarizeDenials`. See [Denials are recorded](/concepts/permissions#denials-are-recorded).

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
entity relations, entitlement key, searchables (`{ entityType, fields, tokenizer? }` — the
table and id column are filled in by `manifestEntities` from the entity registry, and the
kernel derives a per-scope FTS5 index from the result), UI contributions, `envSpec`
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

## Client context (`client-context.ts`)

`clientContext` / `ClientContext` — who is on the other end of a request, as distinct
from the principal: `device` (browser, OS and `kind` — desktop, mobile, tablet, bot —
parsed out of the `User-Agent` by `parseUserAgent`), `language` (the head of
`Accept-Language`), and `geo` (country, region, city, timezone, continent). Every
collected value is nullable; `device` and `geo` are always present and `device.kind` is
`unknown` when the parser could not tell. There is no IP address. A host builds one with `clientContextOf(headers,
geo?)` and hands it to an operation as **input**; module code has no request to read.
The Cloudflare read of `request.cf` is normalised once, in
[`cloudflareClientContext`](/reference/adapter-cloudflare) — a vertical sees this shape
on every runtime.

## Versioning

The package is semver'd and every event and manifest carries explicit schema versions.
Pre-1.0, shapes change without notice; from the first shipped vertical onward, breaking
changes to emitted schemas are CI-diffed and linted.

## The model

One TypeScript module declares a vertical's entities, operations and permissions; the
compiler checks the joins between them. Full walkthrough in
[The model](/concepts/model).

| export | what it does |
|---|---|
| `defineEntities` | declares entities — `table`, `fields`, `parents`, `key`, `erasable`. `parents` is checked against the map's own keys; `key` and `erasable` against each entity's own fields |
| `defineOperations(entities, permissions, engines?)` | declares operations against those entities, a declared permission set, and any composed engine registries |
| `manifestOperations(ops, { permissions, checksDeclaredElsewhere?, consumes? })` | the operation half of the manifest — descriptions supplied, the permission key set and `events.emits` derived; a key checked but owned by a composed engine is listed under `checksDeclaredElsewhere` with its owner, and both an undescribed key and a stale exemption are load errors |
| `manifestEntities(entities, refs)` | composes the entity-referencing manifest fragments; derives `entityRelations` from each entity's `parents` |
| `permissionsUsedBy` · `eventsEmittedBy` | derive the manifest's `permissions` and `events.emits` from the operations |
| `operationInputsOf(ops)` | the `operationInputs` map a `ModuleRegistration` carries — every operation's declared input schema, which the **host** parses on every path in before the guards and the handler |
| `operationConcurrencyOf(ops)` · `operationIdempotencyOptOutsOf(ops)` | the `operationConcurrency` map (which entity's version each operation's `If-Match` is checked against) and the operations that opted out of `Idempotency-Key` — both derived, never written a second time |
| `emitModel` | renders the registry to deterministic JSON — the artifact `pnpm lint:model --check` gates |
| `EntityRow<T, K>` | a declared entity's row type, for `ctx.sql.query<…>` |
| `OperationImpl<Ops, Ctx>` | the handler map an operation set requires; bind with `satisfies` |
| `journalColumns(sql)` | test tooling — columns per table from a migration journal, following `ADD COLUMN`, `DROP TABLE` and `RENAME TO` |

`model.json` is for consumers that must not execute your code, or that want diffability. A
code generator reads the TypeScript: `z.toJSONSchema` drops `.refine()` and `.brand()`, so a
generator reading the JSON would emit validators weaker than you declared.
