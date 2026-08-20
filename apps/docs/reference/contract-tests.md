# @substrat-run/contract-tests

The **conformance suite** for scope-host adapters. Every adapter — pure SQLite,
Cloudflare Durable Objects, and any future one — must pass this suite **unchanged,
forever**. If an adapter needs the suite modified, the contract changed, and that is a
decision, not a patch.

This is the mechanism behind the platform's central promise: the guarantees are
properties of the substrate, and here is the substrate being tested for them. It is also
what makes a [third adapter](/guide/comparisons) a bounded job rather than an archaeology
project — the suite *is* the specification of what an adapter must do.

```sh
pnpm add -D @substrat-run/contract-tests vitest
```

## The suites

The package exports test *suites* built on [Vitest](https://vitest.dev); it runs nothing
itself. Each adapter calls them from its own `test/` folder, passing a factory that returns
a fresh host.

| suite | what it holds the adapter to | runs against |
|---|---|---|
| `scopeHostContractSuite` | the scope-host contract — isolation, serialization, the spine, snapshots, connectors | `UNSAFE_allowAllChecker`, so a failure is never a permission failure in disguise |
| `permissionContractSuite` | the tuple checker — roles, grants, orgs, identity, the audit and access logs | the **default** checker; the whole point is the real engine |
| `scheduleContractSuite` | registered schedules firing under the system actor | the **default** checker, so the system grant resolves for real |
| `atomicContractSuite` | `ctx.atomic` — a caught engine error discards that region's writes and nothing else | the **default** checker; the K-34 assertion needs a real authorization |
| `searchContractSuite` | the derived FTS index — triggers, tokenizers, read-after-write, and a fork that searches without a re-index | `UNSAFE_allowAllChecker`; what the index answers, not who may ask |

```ts
// packages/adapter-yours/test/contract.test.ts
import {
  connectorTestFetch,
  permissionContractSuite,
  scheduleContractSuite,
  scopeHostContractSuite,
} from '@substrat-run/contract-tests';
import { UNSAFE_allowAllChecker, webCryptoSecretBox } from '@substrat-run/kernel';
import { YourScopeHost } from '../src/index.js';

scopeHostContractSuite('adapter-yours', async () => {
  const host = new YourScopeHost({
    checker: UNSAFE_allowAllChecker,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
    fetch: connectorTestFetch, // the in-memory third party — see below
  });
  return { host, cleanup: async () => host.close() };
});

permissionContractSuite('adapter-yours', async () => { /* default checker */ });
scheduleContractSuite('adapter-yours', async () => { /* default checker */ });
```

Today that is **253 assertions**, and the two shipped adapters run every one of them.

## What the suites verify

The list has grown well past the original five guarantees. Grouped by what breaks if the
adapter gets it wrong:

**Isolation and addressing**
- a write in one scope is invisible in another;
- a mismatched `(tenantId, scopeId)` pair throws rather than resolving to someone else's
  data — on `getScope`, and on every admin-side path that takes the pair (K-3);
- provisioning is idempotent, and refuses a scope under a tenant with no record.

**Transaction semantics**
- 10 concurrent read-await-write increments land on exactly 10 (K-6);
- mutating an input after `invoke()`, or mutating a returned result, never affects scope
  state — the structured-clone boundary is real on both directions;
- a throwing handler rolls back *everything* it did, including the events it emitted and
  the platform intents it enqueued (K-4).

**The spine**
- tenant, scope, actor, ULID id and timestamp are stamped kernel-side, not by the caller;
- a PII-classed event without a `subjectId` is rejected at emit;
- every allowed check is stamped onto the event it authorized (K-34), and every *refused*
  check is recorded as a denial even though its operation rolled back (K-35);
- reads of the directory and of the audit trail are themselves recorded in the access log —
  including reads *of the access log* — and never leak into the mutation trail;
- the two-tier retention split: drain to Tier 2, then prune exactly what drained, and refuse
  to prune anything undrained (K-24).

**Migrations**
- module migrations apply lazily and journal per `(module, version)`;
- the host reports a migration frontier a woken scope is never behind;
- `migrateScope` on an up-to-date scope touches nothing.

**Delivery**
- each event reaches an executor exactly once;
- a failing executor does not fail the operation that emitted the event;
- one poison delivery does not block the deliveries behind it;
- exhausting attempts dead-letters the delivery *with the evidence kept*, and a
  dead-lettered delivery is terminal.

**Export, fork, restore, snapshot** — the machinery behind
[snapshots and previews](/concepts/snapshots)
- a scope dump is complete: every introspected table is in it;
- an import round-trips into a new scope, is an independent copy, and records its fork
  provenance;
- a restore rewinds a diverged scope and it still *runs* afterwards — including the awkward
  cases: a dump missing kernel-spine tables, a child table sorting before its parent,
  a target already holding FK-related rows, and scope-level grants that must be re-pointed
  at the destination;
- `bindScopeVersion` snapshots a migration-changing rebind **and only that** — the
  digest is the gate;
- the GC sweep reaps exactly the expired forks, and `gcSnapshots: false` skips it.

**Erasure** ([GDPR](/concepts/events))
- a shred redacts the payload and **keeps the envelope**, for the named subject only;
- it is idempotent, and re-running still reports the tombstone;
- after a shred what was sealed no longer opens, and nothing may be re-sealed;
- a different subject in the same scope stays fully readable;
- the erasure lands in **both** logs — the mutation trail and the evidence-destruction one.

**Introspection and the SQL console** (§5.4, #219)
- the table list flags the spine as system;
- `queryScope` runs a read-only `SELECT` (joins included, spine readable), caps the result
  and *reports* truncation rather than erroring, and rejects every write shape — leaving no
  trace when it does.

**Connections and connectors**
- a connection is a subject that opens the door and confers nothing: no memberships, no
  roles, a grant is a separate act;
- it cannot reach a scope outside its own tenant or vertical, and stops working the moment
  it is revoked;
- credentials seal at rest and never come back out.

**Permissions** (the second suite)
- deny by default, reporting the checked permission and node;
- tenant roles inherit downward into scopes, with a proof path;
- scope roles stay confined to their scope;
- entity-narrowed grants resolve through declared parent edges, and expire;
- `ctx.grant` delegates and **cannot elevate** — a caller may narrow only what it holds;
- revoking a membership stops it granting but keeps it readable as evidence;
- identity is keyed per tenant: the same `externalId` in two pools is two people, and a
  tenant-bound pool refuses to enumerate tenants.

## `connectorTestFetch` — the third party, in memory

Connector conformance needs an outside world, and a suite that reached a real API would be
neither hermetic nor able to produce the failure paths that matter. The package ships one:

```ts
import { connectorCalls, connectorTestFetch, resetConnectorCalls } from '@substrat-run/contract-tests';
```

`connectorTestFetch` is a `fetch` the host can be constructed with; `connectorCalls`
records what was attempted, so a test can assert on the request an adapter *made* as well as
the result it returned.

## The fixture modules

The suites need modules to run, and they bring their own rather than borrowing a demo's —
so a change to Callout can never quietly change what an adapter is held to:

| export | what it is for |
|---|---|
| `contractTestModules` | the standard registration set most of the suite runs against |
| `contractTestInitialModules` | the pre-migration set, for the lazy-migration assertions |
| `contractTestBareOps` | operations with no migrations, for the paths that must not need any |
| `brokenMod` | a module whose handler throws — the rollback assertions |
| `connectorMod` | exercises the connector dispatch path |
| `scheduleMod` | a registered schedule, for the schedule suite |
| `billedMod` | emits meter readings |

## Why this matters if you never write an adapter

This package is why your local test run means something. The pure-SQLite host your CI uses
and the Cloudflare host your customers hit are held to identical, executable semantics —
so "works locally" and "holds in production" are the same claim, and it is tested on every
commit rather than asserted in a README.

## See also

- [`@substrat-run/adapter-sqlite`](/reference/adapter-sqlite) — the local/CI/self-host host
- [`@substrat-run/adapter-cloudflare`](/reference/adapter-cloudflare) — the production one
- [Operations & the scope host](/concepts/scope-host) — the contract in prose
