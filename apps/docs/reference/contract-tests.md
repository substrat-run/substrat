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
| `listContractSuite` | `ctx.page` — from a declaration of sortable and filterable columns, a keyset walk that never skips or repeats a row, with a count that matches the filter (#811) | `UNSAFE_allowAllChecker`; a page is a read, and the operation's own `assertAllowed` gates it |
| `inputParseContractSuite` | an operation's declared `input` is parsed by the **host**, before the guards and the handler, on every path into a scope — `stub.invoke`, not only HTTP (#893) | the **default** checker; the fixture's handlers run a real `ctx.check` |
| `entityVersionContractSuite` | `ctx.versionOf` — an entity's version is the ULID of the last event that touched it; a shred keeps it (#901) | `UNSAFE_allowAllChecker`; what the spine answers |
| `concurrencyContractSuite` | `If-Match` → `412` — the version comparison runs inside the write's own transaction, and a refused write leaves nothing behind (#129) | the **default** checker, so the precondition is shown to run *after* the permission check and *before* the guards |
| `idempotencyContractSuite` | `Idempotency-Key` — a retry does not do the work twice, because the recording is written in the same transaction as the work (#116) | the **default** checker, for the same ordering reason |
| `timelineContractSuite` | `readTimeline` / `readHistory` — the supported read of an entity's history, including the page-boundary and actor-decoding cases five demos got wrong (#800) | the **default** checker; the history half asserts the K-34 authorization stamp |
| `impersonationContractSuite` | acting as a principal with the real actor preserved — authority is the impersonated principal's, both actors are stamped, read-only holds on `ctx.sql`, the time box is checked per invoke (K-42) | the **default** checker; half the suite is that the door confers no authority of its own |

```ts
// packages/adapter-yours/test/contract.test.ts
import {
  connectorTestFetch,
  permissionContractSuite,
  scheduleContractSuite,
  scopeHostContractSuite,
  // …and the other nine, each with the same (name, factory) signature
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

Every suite takes the same `(adapterName, makeFixture)` pair; the one thing that varies is
which checker the fixture is built with, and the table says which and why. The complete
wiring — all thirteen, with the reason beside each — is
[`packages/adapter-sqlite/test/contract.test.ts`](https://github.com/substrat-run/substrat/blob/main/packages/adapter-sqlite/test/contract.test.ts),
and the two shipped adapters run every suite in it. The count is deliberately not written
here: it grows with every merged guarantee, and the number that matters is that the
Cloudflare host's is the same as SQLite's.

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

**Paged reads** (`listContractSuite`, #811)
- a module that only *declares* which columns are sortable and filterable gets a correct
  keyset walk in every scope, over indexes it never wrote;
- the sort column in the fixture is deliberately non-unique and the page sizes force ties
  to straddle a boundary — the walk that drops tied rows emits SQL that *reads* perfectly,
  so the assertions are behavioural, never string comparisons;
- the count matches the filter, and the cursor neither skips nor repeats a row.

**Input parsing at the door** (`inputParseContractSuite`, #893)
- the declared `input` is parsed by the host before the guards and the handler — so a
  malformed call is refused on every adapter, and "parse, don't trust" is not a fact about
  which substrate a tenant landed on;
- it holds for `stub.invoke`, not only the HTTP mount: a scenario test, a seed and a
  schedule all go through the parsed path.

**Entity versions and optimistic concurrency** (`entityVersionContractSuite`, #901;
`concurrencyContractSuite`, #129)
- an entity's version is the ULID of the last event that touched it — no table has a
  version column, and none is going to;
- a shred keeps the version: an erased entity can still refuse a stale write, rather than
  failing open at the moment the data was most sensitive;
- a silent mutation (one that emits nothing) does not move the version — pinned as a known
  property, not papered over;
- `If-Match` is compared inside the write's own transaction; a `412` is never a partial
  write with an error attached;
- an `If-Match` on an operation that declares no concurrency is **refused**, not ignored — a
  caller must not believe its write was serialised when nothing was compared.

**Idempotency** (`idempotencyContractSuite`, #116)
- every case counts *executions*, not responses — a host that re-ran the work and produced
  the same answer would pass a response comparison, and a duplicated work order looks a
  great deal like the original;
- a failed request leaves no recording, so the retry runs;
- a key belongs to the subject that sent it; a reused key with a different request is
  refused, never served; a replay that cannot be answered is a `409`, not a second run.

**Timelines** (`timelineContractSuite`, #800)
- a burst of events from one operation shares one instant (`ctx.now()` is stable for the
  invocation), and a page boundary inside that burst loses nothing — the timestamp-cursor
  bug two demos shipped;
- `actor` decodes to the principal or the system actor, not the JSON-quoted string the
  column holds;
- a shred keeps the row: the history says something happened here, even when the payload
  is gone.

**Impersonation** (`impersonationContractSuite`, K-42)
- the permission model answers as the *impersonated* principal, resolved the ordinary way —
  a session against someone who holds nothing is refused exactly as they would be, with the
  denial recorded against both actors;
- the stamp cannot be supplied or suppressed by module code: the same handler writes a null
  stamp through the ordinary door and both actors through the impersonation door;
- read-only is a mechanism — a handler that writes with plain `ctx.sql.exec` is refused,
  not only one that calls `ctx.emit`;
- the time box is checked per invoke, so an expired session expires for the caller holding
  the stub too.

## The entity-check kit

The suites above hold an **adapter** to the contract. The same package also ships the kit
that holds a **vertical or engine** to its own permission declarations — the evidence
behind the `CONFORMANCE.md` each one checks in beside its `PERMISSIONS.md`.

The problem it exists for (#747): an operation declares what its permission checks against
— `{ key, entity, idFrom }` for one entity, a bare key for the node — and nothing verified
it. A declaration of `entity: 'list'` beside a handler calling `ctx.check(perm)` typechecks
and fails *open*: everyone holding the key anywhere in the scope passes, which in a sharing
app is every member against every record.

`entityCheckConformanceSuite` reads the declared operation set and generates, for every
operation that declares an entity check, the behavioural pair that tells the two apart. A
probe principal holds the key **only** through entity-narrowed grants, never scope-wide:

- **grant on A, invoke against A → not denied.** A real entity check resolves the grant; a
  node check asks for the key at the scope, which a narrowed grant does not widen, and
  denies. This is the case that catches the node-check bug — and it fails in the direction
  nobody files a security bug about (a baffling denial, not a breach).
- **grant on A, invoke against B → a permission denial, specifically.** The breach
  direction: a handler that checks nothing, checks a constant entity, or reads the id from
  the wrong field. A business error here is a *failure*, which also pins that the check is
  the operation's first line and answers before a not-found ever can.

Neither case alone is the test; the pair is.

### Declaring the claim

The claim lives in `test/conformance.ts`, which both the vitest file and the
`CONFORMANCE.md` emitter (`pnpm lint:conformance`, `--check` in CI) import — one object, so
the receipt cannot disagree with what the suite runs. There are three helpers, because
there are three strengths of evidence, and the helper stamps the kind rather than letting a
package label itself:

| helper | kind | what it proves |
|---|---|---|
| `declareEntityChecks({ subject, operations, … })` | `driven` | the pair runs against every declared check; a wrong implementation fails |
| `declareNodeOnly({ subject, operations, because })` | `declared` | the operation set is declared and narrows nowhere — the day one narrows, the plan stops being empty and this goes red (`declaredNodeOnlySuite`) |
| `assertNodeOnly({ subject, sources, because })` | `asserted` | a lexical tripwire over the module's source for a two-argument `ctx.check` (`nodeOnlySuite`) — proves an absence on the obvious path, nothing more, and the report says so |

A driven claim, from `demos/todo/test/conformance.ts`:

```ts
import { declareEntityChecks } from '@substrat-run/contract-tests/conformance';
import { todoOperations } from '../spec/model.js';

export const conformance = declareEntityChecks({
  subject: 'todo',
  operations: todoOperations,
  // Only what each schema REQUIRES beyond the entity id — the kit reads the input
  // shape and supplies the id itself.
  inputs: {
    'todo/rename-list': { name: 'Renamed by the conformance kit' },
    'todo/share-list': { email: 'ada@example.com' },
  },
  // A declared permission is the gate an operation opens with, not necessarily the
  // whole authority it exercises. `share-list` honours `list:manage`, then delegates
  // `list:contribute` via ctx.grant — and delegation only narrows a permission the
  // caller HOLDS. The reason is required, not a comment.
  alsoGrant: {
    'todo/share-list': {
      permissions: ['list:contribute'],
      because: 'the handler delegates list:contribute to the invitee via ctx.grant, …',
    },
  },
  // What the kit cannot generate, asserted EXACTLY: losing coverage fails here until
  // this list says so, which is the gap made visible in the diff.
  uncovered: {
    'todo/set-item-done': "declares 'resolved' — the entity id is not in the input",
  },
});
```

The test file passes that same object through as the suite's options, with a fixture the
vertical supplies:

```ts
entityCheckConformanceSuite(conformance.subject, conformance.operations, async () => ({
  createEntity: async (type) => /* make one, return its id — fresh per case */,
  grantOnEntity: async (permission, ref) => /* the ADMIN grant, never the vertical's own share op */,
  invoke: async (operation, input) => /* as the probe principal */,
}), conformance);
```

Two more options cover shapes the plain form cannot:

- **`coEntities`** (#939) — an operation naming a *second* entity of the kind it narrows to
  (`ticket0/merge` folds one conversation into `intoConversationId`). A made-up id is
  refused before the check under test answers, so the kit creates the co-entity the way it
  creates the target, fresh per case, and grants the same keys on it. What it does **not**
  assert is that the handler checks the co-entity at all — that is the operation's own
  claim, proved where its scenario is written.
- **`refEntityType`** (#896) — an engine narrowing to a `refFrom` ref the caller supplies
  whole has no entity type of its own to name; the harness names one and `createEntity`
  makes it. An engine that cares which noun it was handed has a finding, not a fixture
  problem.

### What it reports rather than drives

A kit that quietly covered the easy half would read as "checked" when it is not, so
anything it cannot generate lands in `uncovered`, asserted against the list the author
wrote down:

- a `resolved` check — the entity id is not in the input, so the harness cannot reach it;
- an `entityFrom` field whose schema is an open `z.string()` — the kit reads admissible
  types off a literal or enum and refuses to pick one;
- an operation whose input has required fields nothing supplied.

And three guards keep the receipt honest: an `alsoGrant` or `coEntities` entry naming an
operation the kit does not drive fails (a stale note reads as coverage), and a suite that
generated no pair at all fails — silence must not read as success.

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
