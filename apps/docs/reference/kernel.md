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
| `OperationContext` | interface | what a handler sees: ambient `tenantId`/`scopeId`/`principal`, `sql`, `emit`, `check`, `search` (ids from the declared FTS index), `entitlement`/`entitlements` (read a held SKU/quota at request time — the gate a CP-less vertical uses), `link`, `grant`/`revoke` (delegation, never elevation), `requestPlatform`/`platformRequests`, `versionOf` (an entity's version — the ULID of the last event about it), `sealToConnection` |
| `OperationHandler<I, O>` | type | `(ctx, input) => O \| Promise<O>` |
| `ConsumerHandler` | type | event consumer; at-least-once, must be idempotent |
| `ModuleRegistration` | interface | manifest + migrations + operations + consumers |
| `SqlMigration` | interface | `{ version, sql }` — ordered, journaled per module |
| `ScopedSql`, `SqlValue` | types | synchronous scope-local SQL: `query<T>()`, `exec()` |
| `ExecutorHandler` | type | `(admin, event) => void` — out-of-band host code effecting what a module asked for via an event (K-22). Registered with `registerExecutor`; receives `HostAdmin`, never `ctx`, because it acts with platform authority |
| `HostAdmin` | interface | the audited control-plane surface. Every mutation takes a `PlatformActorId` and writes an append-only audit row; directory reads take one too and record to the K-24 access log. The capability groups it now spans: **permissions & membership** (`defineRole`, `listRoles`, `assignRole`, `unassignRole`, `grant`, `grantToOrg`, `grantToConnection`, `grantToSystem` — the schedule's system-principal grant (#383), `addMember`, `removeMember`, `listMembers`); **organizations** (`createOrg`, `listOrgs`, `getOrg`); **the vertical + version registry** (`registerVertical`, `publishVersion`, `admitVersion`/`rejectVersion`, `promoteVersion`, `bindScopeVersion`, `setVerticalListed`, `verticalServing` — push-is-not-live admission, channels, and the stable serving script); **the hostname map** (`bindHostname`, `setHostnameStatus`, `setHostnameIssuance`, `listHostnames`, `resolveHostname` — the router's unlogged per-request read); **tenant registry** (`createTenant`, `setTenantName`, `setTenantStatus`, `listTenants`, `getTenant`, `reapTenant`); **scope directory + lifecycle** (`listScopes`, `getScopeRecord`, `activateScope`, `suspendScope`/`unsuspendScope`, `archiveScope`/`unarchiveScope`, `reapScope`, `rewindScope`); **scope introspection** (`listScopeTables`, `readScopeTable`, `queryScope`, `exportScope` — the read-only "Data" window into a scope's own database); **entitlements** (`grantEntitlement`, `revokeEntitlement`, `listEntitlements`); **the connections hub** (`createConnection`, `openConnection`, `listConnections`, `updateConnectionSecret`, `revokeConnection`, connector-state get/put/list — the integrations credential store); **identity** (`registerIdentityPool`, `linkIdentity`, `unlinkIdentity`, `resolveIdentity`, `listIdentityTenants`); and the logs (`auditLog`, `accessLog`) |
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

## The other seams

Everything below is in the kernel for the same reason: it is a rule two or more
implementations have to agree on, and a second copy of it is a chance for them to disagree.
All of it is web-standard only — `globalThis.crypto`, `TextEncoder`, `URL` — because a
package that assumed Node would break the portability claim the adapters exist to prove.

### Erasure and secrets

| Module | Export | What it is |
|---|---|---|
| `subject-keys.ts` | `createSubjectKeys` | **The mechanism under `piiClass`.** A per-subject data key seals that subject's payloads at the moment a *copy* is written, so "erase from every copy we hold" becomes "destroy one key". A live scope needs no crypto — Tier 1 is mutable, erasing there is an ordinary redaction. The copies the platform keeps and cannot rewrite are the problem: a reap backup, a stored dump, the Tier-2 event lake. Those are full-fidelity on purpose, which is exactly why a `DELETE` can never reach one. A tombstone means a destroyed key is never re-minted |
| `secret-box.ts` | `webCryptoSecretBox`, `unconfiguredSecretBox`, `isSecretBoxConfigured`, `SecretBoxUnconfiguredError` | The symmetric seal/open adapter the connection store rests on. The kernel decides that per-tenant credentials are encrypted at rest and that plaintext never touches the directory; *what* encrypts is swappable — Web Crypto locally, a Secrets Store binding or an external KMS when hosted. `unconfiguredSecretBox` refuses to store a credential rather than storing it in the clear |
| `sealed-box.ts` | `sealTo`, `openSealed`, `generateSealingKeyPair`, `ConnectionSealingKeyUnavailableError` | The **asymmetric** sibling, answering a question a scope cannot otherwise ask: *hand this to a recipient I cannot talk to*. Every path out of a hosted scope is a spine row, so a symmetric key minted in-scope would have to travel the same rows as the value it protects. A connection's **public** half can be projected down, and a public key is enough to write with — so the scope seals, and the connector opens at egress with a private half that never left the directory |

### Trusting the edges

| Module | Export | What it is |
|---|---|---|
| `routed-node.ts` | `readRoutedNode`, `RouterAssertionError` | The vertical's side of the router contract: read the `(tenant, scope, surface)` the router asserted over its service binding. A request with **no** assertion is legitimate — that is a standalone deploy |
| `platform-call.ts` | `assertPlatformCall`, `PLATFORM_SECRET_HEADER`, … | The opposite direction: *is the platform itself calling?* Provisioning is control-plane-driven — only the vertical can create a usable scope DO — and here there is no legitimate unauthenticated case, because an open provisioning endpoint lets a stranger mint tenants inside your vertical. So this one **fails closed with no configuration at all** |
| `read-only-sql.ts` | `assertReadOnlyQuery` | The textual gate in front of the [scope SQL console](/platform/console). `readScopeTable` is safe by construction; a console taking user SQL is not, so read-only-ness is enforced per statement in two layers — this shared scan (both adapters, same rejections, so a query that runs in dev runs in prod) and an adapter-authoritative backstop behind it. The scan reads bare tokens *outside* comments, string literals and quoted identifiers, so a `;` inside a string never trips it |

### Fleet arithmetic

These are pure functions over the directory projection, deliberately shared so two callers
can never disagree about what a number means.

| Module | Export | What it is |
|---|---|---|
| `platform-sweep.ts` | `runPlatformSweep`, `startPlatformSweeper` | One pass of every scheduled thing the platform does — draining retryable effects, reconciling connectors, reaping expired snapshots, running each vertical's declared schedules. It holds **no timer**: a node deployment calls `startPlatformSweeper`, a Cloudflare one arms a sweeper DO's alarm |
| `migration-progress.ts` | `migrationFleet`, `migrationProgress`, `migrationSummary`, `MIGRATION_FLAG_THRESHOLD` | What "487/500 migrated, 13 pending, 0 failed" means, computed once for both the sweep's report and the ops view. It reads the directory projection against the registered frontier — **no scope is woken to answer a fleet question** |
| `meters.ts` | `foldMeterReading` | What counts as billable. Every adapter has the same three directory tables and could each write the same `GROUP BY`; they must not, because the billable rule is a *commercial* definition and two copies in two dialects is how the two fleets end up quoting different numbers for the same month |
| `provider-error.ts` | `isTerminalProviderError`, `providerErrorStatus`, `RETRYABLE_CLIENT_STATUSES` | Is a failed outbound call worth trying again? Deliberately **structural** — any error carrying a numeric `status` — so the drain never imports a provider's error class to classify it. It exists because a provider answering `409 requires valid personal number field` was once retried a hundred times over two days: that is not a fault to wait out, it is the provider telling the caller its request is wrong, and attempt 101 carries identical bytes |
| `scope-record.ts` | `resolveScopeRecord` | The directory row `provisionScope` writes, with every optional resolved — in the kernel so the two adapters cannot default differently |

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
- **An entity's version is the last event's ULID** — `versionOf` moves on every event
  about the entity, never moves for an event about another, and survives a shred: the
  payload is erased and the envelope kept, so an erased entity can still refuse a stale
  write. There is no version column anywhere, and deliberately not going to be one.
