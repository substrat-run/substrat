# @substrat-run/adapter-sqlite

The **pure-SQLite scope host** — real kernel semantics with no Cloudflare dependency.
One SQLite file per scope, a per-scope actor for strict serialization, a directory
database for fail-closed addressing, and a kernel-stamped event outbox.

It is **not a mock**: it is the adapter local development and CI run on, it passes the
[full conformance suite](/reference/contract-tests) that the production adapter passes, and
it is the reason the self-host and escrow story is literally true rather than aspirational.

```sh
pnpm add @substrat-run/adapter-sqlite
```

## Usage

```ts
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { UNSAFE_allowAllChecker, webCryptoSecretBox } from '@substrat-run/kernel';

const host = new SqliteScopeHost({
  dir: './data',                    // one .sqlite file per scope + _directory.sqlite
  checker: UNSAFE_allowAllChecker,  // omit for the default tuple checker (deny by default)
  secretBox: webCryptoSecretBox('k', key), // omit if you use no connectors — see below
  fetch: myFetch,                   // omit for the runtime's fetch
});

host.registerModule(myModule);
host.admin.createTenant(actor, { id: tenantId, slug, name });                // tenant first
await host.provisionScope(actor, { tenantId, scopeId, jurisdiction: 'eu' }); // idempotent
const stub = await host.getScope(principal, tenantId, scopeId);
await stub.invoke('workorder/create', input);
await host.close();
```

### The four options

| option | default | why it is shaped that way |
|---|---|---|
| `dir` | required | holds `_directory.sqlite` plus one `<tenantId>__<scopeId>.sqlite` per scope, and `tstore__…` files for [per-tenant stores](#per-tenant-relational-stores) |
| `checker` | the built-in tuple checker | deny-by-default on empty tuples. The permissive one is called `UNSAFE_allowAllChecker` because the name is the warning |
| `secretBox` | *unconfigured* | seals per-tenant credentials at rest. Omitted, the host **refuses to store a credential at all** rather than storing it in the clear — every other surface keeps working, so a deployment using no connectors needs no key |
| `fetch` | the runtime's `fetch` | egress for connectors, injectable so a test or a dev server can stand a provider up in memory. It is the only way to exercise a connector end to end before real credentials exist, and it stays the way to test failure paths a real provider will not produce on demand |

## How the semantics map

| Contract guarantee | Implementation here | In production ([the Cloudflare adapter](/reference/adapter-cloudflare)) |
|---|---|---|
| strict serialization per scope | in-process actor, one queue per scope | Durable Object single-threaded execution |
| scope storage isolation | one SQLite file per scope | one DO (SQLite-backed) per scope |
| fail-closed addressing | `_directory.sqlite` cross-check | directory + DO addressing |
| structured-clone boundary | explicit `structuredClone` both directions | the RPC boundary itself |
| stamped event envelopes | outbox table written in the same transaction | same, drained to the event spine |
| per-tenant relational store | a separate `tstore__*.sqlite` file | a minted per-tenant D1 |

## What lives in the spine

Every scope database carries the kernel's own tables alongside your module's. Module code
may **read** them for projections like a timeline; writing to them is a
[boundary-lint](/reference/boundary-lint) error, because a forged spine row is
indistinguishable from a real one.

| table | what it holds |
|---|---|
| `_substrat_outbox` | stamped domain events, with the checks that authorized them (K-34) and a `drained_at` marker |
| `_substrat_denials` | refused permission checks — recorded *outside* the transaction the denial rolled back (K-35) |
| `_substrat_migrations` | the applied journal, per `(module, version)` |
| `_substrat_tuples` | scope-local permission tuples |
| `_substrat_deliveries` | executor delivery attempts, retries, and dead letters |
| `_substrat_attachments` | attachment records against your entities |
| `_substrat_platform_requests` | durable [platform intents](/concepts/platform) a vertical enqueued for the platform to execute |
| `_substrat_schedule_state` | the last-fired cadence per registered schedule |
| `_substrat_idempotency` | recorded responses per `(subject, Idempotency-Key)`, with the request fingerprint that tells a replay from a reuse; pruned after 24 hours |

The directory database holds the other half — tenants, scopes, hostnames, verticals and
their versions and channels, orgs, roles, entitlements, identity pools and links,
connections and their sealed secrets, subject keys, impersonation sessions
(`_substrat_impersonations`), and the admin, access and ops-failure logs.

## The host surface

Beyond `getScope`, the host implements the admin-side contract the platform drives:

- **lifecycle** — `provisionScope`, `migrateScope`, `migrationFrontier`, `close`
- **copies** — `snapshotScope`, `importScope`, `restoreScope`, `deleteSnapshot`
  ([snapshots & test copies](/concepts/snapshots))
- **stores** — `provisionTenantStore`, `openTenantStore`, `provisionBlobStore`
- **delivery** — `registerExecutor`, `drainDue`, `executorDeadLetters`
- **connectors** — `registerConnector`, `dispatchConnector`, `getConnectorScope`,
  `getConnectorAttachments`
- **schedules** — `registeredSchedules`, `runDueSchedules`, `getSystemScope`
- **platform intents** — `listPlatformRequests`, `listPlatformRequestHistory`,
  `settlePlatformRequest`
- **attachments** — `attachments`

…plus `host.admin`, the [`HostAdmin`](/reference/kernel) surface every control-plane
operation goes through.

### Per-tenant relational stores

A vertical that needs one database per *tenant* rather than per scope gets a handle, never
a path: `provisionTenantStore` returns an opaque `ref` — here a `tstore__…​.sqlite`
filename, in production a minted D1 id — and `openTenantStore` turns it back into a store.
The prefix exists so a store file can never collide with a scope database.

## Debugging is opening a file

Scope databases run in WAL mode and can be opened read-only with any SQLite tool, which is
the single biggest practical reason to develop against this adapter:

```sh
sqlite3 ./data/<tenantId>__<scopeId>.sqlite '.tables'
sqlite3 ./data/<tenantId>__<scopeId>.sqlite 'SELECT type, entity_id, actor FROM _substrat_outbox ORDER BY occurred_at DESC LIMIT 20;'
sqlite3 ./data/_directory.sqlite 'SELECT * FROM scopes;'
```

## Notes

- Uses [better-sqlite3](https://www.npmjs.com/package/better-sqlite3) (a native module).
  With pnpm 10+, allow its build script via `pnpm.onlyBuiltDependencies`.
- **Single-node by design.** It preserves the serialization *semantics*, not the scale-out;
  production scale-out is the Cloudflare adapter's job. That is a deliberate split, not a
  gap — the semantics are what the contract tests pin, and they are identical.
- The directory schema is re-applied on every open **and after a restore**, because a dump
  taken before a directory migration carries the old shape and replaying it verbatim would
  roll the schema backwards.
- Pre-release: interfaces change without notice until the first vertical ships.

## See also

- [Operations & the scope host](/concepts/scope-host) — the contract in prose
- [`@substrat-run/contract-tests`](/reference/contract-tests) — what both adapters must pass
- [Running locally](/guide/running-locally) — this adapter as a development loop
