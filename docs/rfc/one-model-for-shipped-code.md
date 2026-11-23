---
status: proposed
layer: plan
description: "A review of how engines, connectors, verticals, the control plane and the router fit together today, and a direction that reduces it to three concepts (scope, module, app), two places code runs, and one version rule. It names what gets worse, and decides nothing."
---

# RFC: one model for shipped code

**Status: proposed.** This is a review of the current model and a direction. It decides nothing,
adds no decision record and amends none. It leans on three records that are themselves proposed
([D-64](../decisions/D-064-a-vertical-may-define-its-own-connector-and-it-runs-in-the-vertical-s-worker.md),
[D-73](../decisions/D-073-a-connector-is-its-own-deployable-unit-with-one-call-contract.md),
[K-58](../decisions/K-058-a-call-from-the-platform-to-a-vertical-carries-an-ed25519-envelope-and-a-deployed-vertical-holds-public-keys-only.md)),
so they are settled before anything here is relied on.

## 1. Problem

The base model is small and it holds: a scope is one database, the app runs inside it, and the
platform routes requests and holds the secrets. What grew around it grew one decision at a time.
A builder, and a reviewer, now meet:

- **eight names for code somebody ships**: engine, module, vertical, plugin, first-party connector,
  vertical-defined connector, store kind, extension;
- **five places that code runs** (§2.1);
- **six ways a version is fixed** (§2.2), with two documents that disagree about one of them;
- **a local run that is a different topology** from the hosted one (§2.3).

None of these is wrong on its own. Together they are hard to hold in one head, and the goal of
this RFC is a model that fits there without giving up speed, isolation or flexibility.

## 2. How it fits together today

### 2.1 Where code runs

| Place | What runs there | Record |
|---|---|---|
| Inside a scope's Durable Object | the kernel, the engines and the vertical's modules, on one SQLite database | [K-28](../decisions/K-028-workers-for-platforms-fits-the-architecture-unchanged-a-user.md): a vertical does not talk to a Durable Object, it is one |
| The vertical's worker | the HTTP surface, sign-in, host code, the vertical's own connectors, a call made between two transactions | D-64, [K-62](../decisions/K-062-an-operation-does-not-await-an-outside-call-inside-its-transaction.md) |
| The control plane | the directory, sweeps, the intent drain, uploads, and every first-party connector, in process | `apps/control-plane/src/connectors.ts` |
| A platform script in the dispatch namespace | a store driver per (kind, vertical); one connector, as a pilot in the test environment | [D-63](../decisions/D-063-a-store-kind-is-platform-code-registered-and-pinned-like-a-connector.md), D-73 |
| A sandboxed iframe | an extension an end user installs at runtime | [K-56](../decisions/K-056-a-runtime-installed-extension-acts-only-as-a-capability-the-vertical-mints-for-it.md) |

One router per environment sits in front of all of it
([K-26](../decisions/K-026-one-environment-wide-router-verticals-are-unreachable-except.md)). It resolves a
hostname to a tenant, scope, vertical and surface and dispatches. It also carries the platform's
own calls into a vertical through three entrypoints, one each for connector calls, peer calls and
scope-store calls (`apps/router/src/`).

**Workers for Platforms and Durable Objects are not alternatives.** The first is how a script is
deployed and isolated; the second is where state lives. A vertical is one script holding both.

| | Worker | Durable Object |
|---|---|---|
| State | none | SQLite, one database per scope |
| Concurrency | parallel | one call at a time per scope |
| Outbound network | through the egress worker, held to the declared hosts ([D-46](../decisions/D-046-a-hosted-vertical-s-outbound-egress-is-a-declared-per-versio.md)) | no policy; observed only ([D-58](../decisions/D-058-d-46-s-durable-object-limit-is-enforcement-only-do-originat.md)) |
| Used for | HTTP, sign-in, calls to the outside | operations, events, migrations, permissions |

### 2.2 How a version is fixed

| What | Mechanism | Who decides when it moves |
|---|---|---|
| Published packages and engines | npm semver; a vertical names them in its `package.json` and the platform bundles them at build ([D-66](../decisions/D-066-projects-use-github-or-artifacts-and-the-platform-builds-every-release.md)) | the vertical |
| A vertical's versions | each push is an immutable version; a prod promote re-uploads it onto one serving script, and every scope on it migrates in place ([K-33](../decisions/K-033-verticals-serve-in-place-from-one-stable-script-per-version-.md)) | the vertical's owner |
| Previews and forks | an archive script per version, against a copy of the data ([preview-and-snapshots.md](../architecture/preview-and-snapshots.md)) | the owner |
| First-party connectors | whatever the control plane was last deployed with | the platform, for every tenant at once |
| Store drivers | the driver is registered in this repository; a release runs once a person has approved it in the control plane, where its bytes are stored by driver and sha256 (D-63, [D-65](../decisions/D-065-a-store-driver-release-runs-after-a-person-approves-its-uploaded-bytes.md)) | the platform |
| Event payloads | `schemaVersion`; a change replaces, it is never emitted twice ([K-39](../decisions/K-039-payload-changes-are-loud-failure-replaces-until-dispatch-rou.md)) | the emitting engine |

**Two documents disagree.** [marketplace-publish.md](../architecture/marketplace-publish.md) §5.1 says
an installed instance pins its version, upgrading is the owner's call, and a publisher cannot
force an upgrade. K-33 serves a vertical from one script and gives up per-scope rollout, and the
code agrees with K-33: `runningVersionOf` (`packages/control-plane-api/src/platform-scope-stores.ts`)
answers the serving script's version for a scope on it. The bound version is a pointer. A promote
reaches every install.

### 2.3 What runs locally

A vertical runs on node against the SQLite adapter: one file per scope, its own directory file, and
`@substrat-run/dev-issuer` for sign-in ([running-locally.md](../../apps/docs/guide/running-locally.md)).
`substrat dev` wraps the project's own `dev` script and adds a request trace.

There is no router, no egress policy and no dispatch on a laptop. A first-party connector that is
published can be wired into the node harness by hand, with the developer's own credential. A
vertical-defined connector runs only in its tests: running it in process outside them is a
follow-up ([vertical-connectors.md](../architecture/vertical-connectors.md) §9). Mock profiles and a
local proxy are later phases of [connector-scripts.md](./connector-scripts.md) §4, not built.

## 3. Where today's model costs

**Concepts.** Eight names, five places, three router entrypoints for one kind of call, and three
connector implementations: in the control plane with a `ScopeHost`, in the vertical's worker with
a `ConnectionContext`, and as a script with a request shape of its own.

**Security.** The strong part is structural: a scope is unreachable from another scope, and a
vertical asks the platform through an intent instead of holding a credential that reaches upward.
Three parts are weaker.

1. A first-party connector is handed a `ScopeHost` whose `HostAdmin` reaches every tenant
   (connector-scripts.md §1).
2. The outbound allowlist binds a worker's requests, not a Durable Object's. That module code makes
   no network call is held by boundary-lint, which the CLI runs before upload;
   [self-serve-deploy.md](../architecture/self-serve-deploy.md) §4 says the upload's own guarantees
   are narrower than containment of uncooperative bundle code.
3. A call from the platform to a vertical rests on
   [K-27](../decisions/K-027-the-router-presents-a-shared-secret-and-the-vertical-verifie.md) until K-58 is
   ratified.

Several records the model rests on are proposed, not accepted: D-61, D-64, D-70, D-73, K-58, K-62.

**Performance.** The strong part is in-scope composition: an engine runs in the caller's
transaction with no hop, and a read is local SQLite. The costs are at the edges. For a
vertical-defined connector, a sweep is one call per bound scope and its state travels with every
call, capped (vertical-connectors.md §6.1, §6.2). Every first-party connector call for every tenant
runs in the worker that holds the directory. The hop a connector script adds has not been measured;
it is what D-73's pilot is for.

**Developer experience.** One push, mechanical gates, previews and generated artifacts are the
strong part. The weak part is that local and hosted differ, and each difference was found after a
suite passed on node and failed hosted. The `LIKE` pattern limit
([#1655](https://github.com/substrat-run/substrat/issues/1655)), the SQL limits
([#1786](https://github.com/substrat-run/substrat/issues/1786)), the bound `fetch`
([#1291](https://github.com/substrat-run/substrat/issues/1291)) and the worker import lint
([#2245](https://github.com/substrat-run/substrat/issues/2245)) each exist for one of them. A
connector cannot be run, mocked or tunnelled locally.

## 4. Direction

### 4.1 Three concepts

1. **Scope.** The data. One database, one consistency domain, one unit of isolation.
2. **Module.** The one unit of code anybody writes. It declares entities, operations, events,
   permissions, migrations and schedules, and it may declare a connection and a network part. An
   engine is a module published for reuse. A connector is a module with a network part.
3. **App** (today's vertical). What is deployed: modules at pinned versions, surfaces, and scope
   types ([#2993](https://github.com/substrat-run/substrat/issues/2993)).

A rule attaches to a property, not to a noun. A published module evolves additively. A module
composed by another states whether it is composed by call or by event. Neither needs a separate
word for the thing it applies to.

### 4.2 Two places, one bridge

- **In the scope:** transactional, no network, no credential.
- **In a stateless worker:** network through the allowlist, one credential per call, no storage of
  its own.
- **The bridge is always the same.** Inward, an operation invoked as a principal under declared
  grants. Outward, an event or a platform intent from the outbox.

This is how K-62, platform intents and D-64's landing already work. The direction is to make it
the only shape, so that "where does this code go" has one answer: code that touches data goes in
the scope, and code that touches the outside goes in a worker.

### 4.3 Placement is a registration fact

A network part speaks one contract, D-73's. Where it runs is recorded in its registration.

| Placement | When |
|---|---|
| The app's own worker | the app's author wrote the network part |
| Run by the platform, as its own script | the platform's own connectors, and code from a third party |
| A mock profile answering from recorded calls | local runs, CI, previews |
| A developer's machine, through a tunnel | debugging against a preview; never production |

**In process in the control plane is an interim placement, not a fifth row.** Step 1 of §6 leaves
the platform's connectors where they run today and changes only what they are handed. It ends
connector by connector, when step 5 gives that connector a script of its own. If D-73's pilot
finds the hop costs too much for some connector, that connector stays in process, and §4.6 does
not hold for it.

**Who may see the credential decides the placement.** A credential entered on the dashboard does
not reach a vertical's code for a first-party connector today, because the platform makes the
call. Moving that call into the app's worker would hand the token to the app's author, which is a
step back for an app its tenant does not own. So the app's worker is the placement only for a
network part the app's author wrote.

### 4.4 One version rule

> Code you import, you pin. A service the platform runs for you is versioned per major and patched
> in place within it. Nothing else changes under you without a push of your own.

**"You" is the app's owner,** the party that pins and pushes.

- A module, an engine included, is pinned in the app's `package.json` and bundled at build.
- A network part the platform runs has a major in its registration and its script name. A minor or
  a patch replaces it in place, and so reaches every app on that major at once. A new major runs
  beside the old one, which is retired on a stated date.
- A contract between the platform and an app is additive within a version, as an engine surface is.
- An app's scopes move together when its owner promotes (K-33).

**The rule does not cover a tenant that installed a listed app, and today it is not true for
one.** The publisher's promote changes the code serving that tenant's scopes with no push of the
tenant's own. That is what marketplace-publish.md §5.1 promised would not happen. Whether an
installer gets the rule, or the stated contract becomes "the publisher promotes and every install
follows", is question 6 in §7. This RFC does not answer it. §5.1 and K-33 are reconciled by that
answer.

### 4.5 Local runs the same contract

`substrat dev` runs a network part in process through the contract the platform uses, holds its
outbound calls to the declared hosts, and answers from a mock profile unless told otherwise. A live
call goes through the platform's proxy, so the credential stays on the platform (connector-scripts.md
§4). The transport is already a parameter (vertical-connectors.md §9).

### 4.6 The control plane shrinks

This is the end state, reached connector by connector at step 5 of §6 (§4.3). The control plane
keeps the directory, the custody of credentials and the orchestration, and runs no provider code.

A change to a connector is then no longer a control-plane deploy. It does not follow that it
reaches fewer tenants: a patch replaced in place reaches every tenant on that major (§4.4). Two
things narrow. What a faulty change can take down is one connector's script, not the worker that
holds every tenant's directory. And what can arrive unasked is a minor or a patch, since a breaking
change waits for a new major.

## 5. What gets worse

A direction with no cost was not looked at closely. These are the costs.

| What gets worse | Why |
|---|---|
| A fix goes from one deploy to many pushes | Today one control-plane deploy fixes a connector for every tenant. A data part bundled with the app is upgraded by each app when a provider changes a field. This is the price of nothing changing under an app unasked. |
| Several versions live at once | Today there is one version of each connector in production. Pinning gives a matrix to test and support, and old majors to keep until they are retired. |
| "Patched in place" can still break somebody | A patch meant to be harmless can change behaviour an app came to depend on. A fully pinned engine has no such case. |
| The contract is rigid | With a `HostAdmin` in reach, a new need is one pull request. After, it is a general role in a contract that only grows. |
| Operations spread out | Connector code, logs and state are in one place today. After, they are in several scripts and scopes, and a trace does not cross the dispatch hop. |
| Local emulation is a second implementation | It can drift from the hosted one, which is the problem it was built to end. More layers also slow the dev loop. |
| Mock profiles go stale and hold customer data | A recording passes after the provider changed. A recording of real calls is sensitive material. |
| A tunnel reaches a laptop | Preview data and a credential arrive on a developer's machine. No such surface exists today. |
| A sweep per connection is harder than one per scope | One poll is handed to several scopes, which may run different app versions, and some may land while others fail. |
| One word does not remove the rules | "Engine" carries star topology and an additive surface. A module with five flags is not simpler than three concepts. |
| The transition adds paths before it removes any | Stopping half-way leaves more than there is today. Each step in §6 has to remove something. |

**A data part in the scope lowers one wall.** A connector today writes only through operations
under declared grants. A module in the scope has `ctx.sql` on the same database as the app's own
tables; that modules leave each other's tables alone
([D-28](../decisions/D-028-engine-compatibility-surface-pinned.md)) is held by boundary-lint, not by the
kernel.
So a bundled data part is for the app's own code and the platform's. A third party's connector
keeps landing through the app's operations.

## 6. Phasing

Worth doing now, because each removes more than it adds:

1. **One connector contract, in process.** Move the first-party connectors onto
   `ConnectionContext` and call them through the caller the vertical-defined ones use. Add a sweep
   role per connection first, so a rate-limited provider is not polled once per scope. Removes
   `HostAdmin` from provider code and one of the three implementations.
2. **A local run and mock profiles in `substrat dev`,** with the allowlist applied. No production
   risk.
3. **The version rule written once.** It waits on question 6: marketplace-publish.md §5.1 and K-33
   are reconciled by that answer, not by this step.

Only on a named need, because this is where §5 bites:

4. **A connector's data part as a module,** for the app's own code and the platform's. A declared
   mirror (external key, cursor, reconcile of deletions) follows two or three written by hand.
5. **Placement per registration,** with a script per major for a network part the platform runs.
   This is the step that moves a platform connector out of the control plane (§4.3, §4.6).
6. **A spike: no network in scope code, as a mechanism.**
   [D-70](../decisions/D-070-a-store-driver-s-code-runs-in-its-own-loaded-isolate-outside-the-verifier-with-no-network.md)'s
   loaded isolate is a candidate. Its likely price is that every `ctx.sql` crosses an isolate
   boundary, which would spend the synchronous SQLite that makes a scope fast. It is measured
   before anything is designed on it, and
   [D-61](../decisions/D-061-do-originated-egress-is-observed-and-never-refused-d-46-s-limit.md) argues the
   other way.

## 7. Open questions

1. **Does a connector module follow the engine rule?** It never imports the app, and cooperates
   through events and `EntityRef`s. Proposed: yes, since that is what makes it reusable.
2. **Is one word worth it?** If "module" replaces "engine" and "connector", which rules and which
   lints keyed on `engines/*` and `connectors/*` move, and does a reader have fewer things to learn
   or the same number under other names?
3. **Partial fan-out.** When one poll feeds several scopes and some fail to land, what is retried,
   and where is the cursor kept?
4. **Mock profiles.** Where is a recording stored, who may read it, and how is it scrubbed?
5. **How long an old major lives,** and who is told when it is retired.
6. **Installs of a listed app.** Is "the publisher promotes and every install follows" the stated
   contract, or should an install be able to stay on a major (a script per major, and the existing
   adopt-serving hop to move a scope between them)? If the first, what replaces §5.1's promise to an
   installer: notice before a promote, the code-only or schema-change badge and the rewind K-33
   already has, or nothing? §4.4's rule is scoped to the app's owner until this is answered.

## 8. Not measured

- The hop a connector script adds. D-73's pilot exists to measure it.
- The load every tenant's connector calls put on the control plane.
- Whether step 6 is possible on the platform today.
