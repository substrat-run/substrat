---
status: proposed
layer: plan
description: "One target model for apps, the code they ship and how they depend on each other: five concepts (scope, module, app, store, dependency), one door, one edge between apps, one version rule. It combines two proposals, sets them against the repository, names what gets worse and what is uncertain, and proposes an order. It decides nothing."
---

# RFC: one model for apps, the code they ship and how they depend

**Status: proposed.** This combines two proposals. One is about which code exists, where it runs
and how its version is fixed. The other is about how apps hang together: dependencies, people,
master data, stores and processes. It decides nothing, adds no decision record and amends none.
Seven records it rests on were proposed when it was written. They were ratified on 2026-11-23,
D-61 with its clause on platform code narrowed and D-73 as a contract with placement left to its
pilot
([K-58](../decisions/K-058-a-call-from-the-platform-to-a-vertical-carries-an-ed25519-envelope-and-a-deployed-vertical-holds-public-keys-only.md),
[K-62](../decisions/K-062-an-operation-does-not-await-an-outside-call-inside-its-transaction.md),
[D-61](../decisions/D-061-do-originated-egress-is-observed-and-never-refused-d-46-s-limit.md),
[D-64](../decisions/D-064-a-vertical-may-define-its-own-connector-and-it-runs-in-the-vertical-s-worker.md),
[D-70](../decisions/D-070-a-store-driver-s-code-runs-in-its-own-loaded-isolate-outside-the-verifier-with-no-network.md),
[D-71](../decisions/D-071-a-store-object-a-deletion-has-fenced-refuses-what-it-left-in-flight.md),
[D-73](../decisions/D-073-a-connector-is-its-own-deployable-unit-with-one-call-contract.md)),
in phase 0 of §8.

## 1. Problem

The base model is small and it holds: a scope is one database, the app runs inside it, and the
platform routes requests and holds the secrets. What grew around it grew one decision at a time.
A builder, and a reviewer, now meet:

- **eight names for code somebody ships**: engine, module, vertical, plugin, first-party connector,
  vertical-defined connector, store kind, extension;
- **five places that code runs** (§4.1) and **six ways a version is fixed** (§4.2);
- **several separate declarations between two apps**: `calls` and `peers`, exported and consumed
  events, `provides` and `requires`, `delegations`, and where an app takes its people from;
- **a local run that is a different topology** from the hosted one (§4.3).

There are several ways to do nearly everything. The goal is a model with one.

## 2. The target

**A tenant and its apps.** A tenant has a number of apps. An app is what is deployed: a set of
modules at fixed versions. The code calls it a vertical. A CRM is an app, a plugin for it is
another, and the auth server that signs people in is a third. None of them is special to the
platform.

**Five concepts.** Scope, module, app, store and dependency.

**Three places inside an app.**

- **The scope** is the data: one database, one transaction at a time, one unit of isolation. The
  modules' operations run there, and every permission is checked there. An app often has many
  scopes, one per project say, and a home scope for what concerns the whole tenant.
- **The worker** is the app's code outside the scope. It has no state of its own, takes HTTP,
  composes answers, and is the only part that calls anything else.
- **The store** is data that belongs to a scope and lives in an object the platform runs: a graph,
  files, a search index.

**One kind of code.** Everything anybody writes is a module. It declares entities, operations,
events, permissions and migrations. An engine is a module published for reuse. A connector is a
module with a network part. An app's author writes the model and the modules; the entry and the
wiring to the platform are generated.

**One edge between apps.** Between two apps there is a dependency and nothing else. Both sides
declare it. It says which contracts are used and how: as the app or as the signed-in person, with
or without personal data.

**One door.** Everything between apps passes it. Every call carries a signed envelope naming the
calling app and who it acts for, and the receiver checks for itself. A read is made directly. A
write in another app is queued, because two apps are always two transactions.

**People have one owner.** An app owns the people, not the platform. That app is the master. It
decides who exists, who is blocked and which base roles each has. Other apps ask the master and
keep the answer briefly. A person has one id across the apps that share a master.

**Data has one owner.** Every entity has a master: the module where it is created and removed.
Other apps point at it, keep their own data beside it, and may hold copies they only read. When
the master merges or erases a record, every holder of a copy is told and has to confirm.

**One version rule** (§6).

**A smaller platform.** The router dispatches and signs envelopes. The control plane keeps the
directory and the credentials and runs sweeps and delivery, and runs no provider code (§5.9). What
runs on a developer's machine speaks the contract the hosted platform does.

## 3. Two flows

**A read across apps, as the person.** A person opens a customer in a CRM and wants the
customer's vehicles, which a plugin owns. The CRM's worker reads the customer from its own scope
and calls the plugin as that person, having exchanged the person's sign-in for a short-lived token
valid only at the plugin. The plugin checks the person's own permissions and answers with what
they may see. The CRM does not need the plugin's rules, and the plugin does not need to trust that
the CRM checked. The call is made from the worker and never inside an operation: otherwise the
CRM's scope stands still while the plugin answers, and two apps calling each other can lock.

**A write across apps, through a queue.** When the CRM wants the accounting app to do something,
its operation saves its own change and a request in one transaction. If the change rolls back
there is no request. The platform delivers it, and the accounting app runs its own operation in
its own transaction. The client is answered one of three ways: done, accepted with a request id,
or failed. There is never a shared transaction. If the receiver fails, the first change stands,
and the flow has to handle that.

## 4. Today

### 4.1 Where code runs

| Place | What runs there | Record |
|---|---|---|
| Inside a scope's Durable Object | the kernel, the engines and the vertical's modules, on one SQLite database | [K-28](../decisions/K-028-workers-for-platforms-fits-the-architecture-unchanged-a-user.md): a vertical does not talk to a Durable Object, it is one |
| The vertical's worker | the HTTP surface, sign-in, host code, the vertical's own connectors, a call made between two transactions | D-64, K-62 |
| The control plane | the directory, sweeps, the intent drain, uploads, and every first-party connector, in process | `apps/control-plane/src/connectors.ts` |
| A platform script in the dispatch namespace | a store driver per (driver, vertical); one connector, as a pilot in the test environment | [D-63](../decisions/D-063-a-store-kind-is-platform-code-registered-and-pinned-like-a-connector.md), D-73 |
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

### 4.2 How a version is fixed

| What | Mechanism | Who decides when it moves |
|---|---|---|
| Published packages and engines | npm semver; a vertical names them in its `package.json` and the platform bundles them at build ([D-66](../decisions/D-066-projects-use-github-or-artifacts-and-the-platform-builds-every-release.md)) | the vertical |
| A vertical's versions | each push is an immutable version; a prod promote re-uploads it onto one serving script, and every scope on it migrates in place ([K-33](../decisions/K-033-verticals-serve-in-place-from-one-stable-script-per-version-.md)) | the vertical's owner |
| Previews and forks | an archive script per version, against a copy of the data ([preview-and-snapshots.md](../architecture/preview-and-snapshots.md)) | the owner |
| First-party connectors | whatever the control plane was last deployed with | the platform, for every tenant at once |
| Store drivers | the driver is registered in this repository; a release runs once a person has approved it in the control plane, where its bytes are stored by driver and sha256 (D-63, [D-65](../decisions/D-065-a-store-driver-release-runs-after-a-person-approves-its-uploaded-bytes.md)) | the platform |
| Event payloads | `schemaVersion`; a change replaces, it is never emitted twice ([K-39](../decisions/K-039-payload-changes-are-loud-failure-replaces-until-dispatch-rou.md)) | the emitting engine |

**Two documents disagree.** [marketplace-publish.md](../architecture/marketplace-publish.md) §5.1 says
an installed instance pins its version and a publisher cannot force an upgrade. K-33 serves a
vertical from one script, and the code agrees with K-33: `runningVersionOf`
(`packages/control-plane-api/src/platform-scope-stores.ts`) answers the serving script's version
for a scope on it. A promote reaches every install. *Resolved by
[K-65](../decisions/K-065-one-version-rule-an-install-follows-its-app-within-a-major-and-a-breaking-change-is-a-new-major-served-beside-the-old.md):* §5.1 now says an install follows within a major.

### 4.3 What runs locally

A vertical runs on node against the SQLite adapter, with `@substrat-run/dev-issuer` for sign-in
([running-locally.md](../../apps/docs/guide/running-locally.md)). `substrat dev` wraps the project's
own `dev` script and adds a request trace. There is no router, no egress policy and no dispatch on
a laptop. A vertical-defined connector runs only in its tests
([vertical-connectors.md](../architecture/vertical-connectors.md) §9), and mock profiles are a later
phase of [connector-scripts.md](./connector-scripts.md) §4, not built.

### 4.4 Where the repository is further along than the proposals

- **People.** An app can already take its people from another app
  ([dependent-people.md](./dependent-people.md)). The contract is `identity.person@1`, and it is a
  question: the dependent asks the master who a sign-in is, keeps the answer 300 seconds, and lets
  nobody in when the master does not answer. The master can call its plugin as the signed-in
  person, with a token the auth server exchanged
  ([#3161](https://github.com/substrat-run/substrat/issues/3161)).
- **Sign-in** is out of the apps. They are OIDC clients, and the auth server is itself a vertical
  ([vertical-auth-detach.md](../architecture/vertical-auth-detach.md)).

### 4.5 Where the distance is greatest

1. Between two apps there are separate declarations where the target has one dependency.
2. A store is reached from host code through a door that checks the (tenant, scope) pair and the
   declared binding, and no permission
   ([K-49](../decisions/K-049-a-scope-store-is-a-platform-run-object-per-scope-reached-by-its-own-door.md)).
   One driver is registered and no release of it is approved.
3. The platform's connectors run in the control plane with a `ScopeHost` whose `HostAdmin` reaches
   every tenant ([connector-scripts.md](./connector-scripts.md) §1).
4. A process that waits over time does not exist. No code in the repository uses a workflow engine.

Of the 136 decision records, 16 are proposed. Four accepted records point another way than this
target and are taken up where they bite: K-33 (one serving version per vertical), K-39 (a changed
event replaces the old one), K-49 (the store's door is in the host) and
[K-53](../decisions/K-053-a-tenant-level-store-is-a-named-instance-that-a-tenant-s-verticals-connect-to-explicitly.md)
(stores at tenant level). K-64 superseded K-53 and amended K-49 on 2026-11-24.

## 5. The changes, one at a time

Each states what it is, what it gives and what it costs.

**5.1 Five concepts and one glossary.** Engine and connector become kinds of module, and a plugin
becomes an app with a dependency on its host. A rule then attaches to a property, not to a noun.
*Costs:* the lints and directories keyed on `engines/` and `connectors/` are reviewed, and a module
with five flags is not simpler than three concepts. Renaming vertical to app in code is expensive
and buys little: change the word outward and leave the code. *Decided in [D-75](../decisions/D-075-five-concepts-and-one-glossary-scope-module-app-store-dependency.md):*
the five concepts, their definitions and the retired names, with the rename outward only.

**5.2 One door with one envelope.** Every call into a scope carries K-58's signed envelope with the
app and the actor, and a deployed vertical holds public keys only. One check, one stamp in the
history and one log, whoever calls. *Costs:* a transition in three states on the platform's most
sensitive path, which cannot be done half-way.

**5.3 A generated entry.** The entry is generated from the model and the modules, by a generator
that ships with the kernel version the vertical pinned. Less code per app, a protocol change is a
new push, and the same entry runs locally and hosted. The entry generator and a model's generator
are one chain under the rules for generated files, never two generators that do not know each
other. *Costs:* freedom. A vertical doing something unusual needs room in the generator or a
declared HTTP route of its own.

**A platform entry already exists, and the generated entry sits beside it.** The uploader puts a
platform-authored entry module in front of every pushed vertical's bundle
(`tools/platform-entry-emit.mts`, gated by `lint:platform-entry`,
[#1893](https://github.com/substrat-run/substrat/issues/1893)). It carries the invocation stamp, the
wire-signing gate and its nonce store, and it supplies a sweeper to a vertical that declares
schedules and exports none ([#1902](https://github.com/substrat-run/substrat/issues/1902)). So there
are two shapes for code the app's author does not write, and which one a piece takes is a choice,
not a consequence of D-61:

- **Written into the upload by the platform.** It is the same for every vertical at the platform's
  current version, whatever the vertical pinned. This fits what the platform has to own: verifying
  the envelope and stamping the request.
- **Generated from a package the app imports at a pinned version.** It moves when the app pushes.
  This fits the wiring that depends on the app's own model and modules, and it is what replaces the
  hand-written entry.

The proposal is that the generated entry replaces the vertical's hand-written one and does not
absorb the platform entry, which stays in front. D-61's clause that no platform-authored code is
injected into a customer's bundle is written about Durable-Object egress. Read as a general rule
it contradicts the platform entry, which is shipped, so phase 0 narrowed its wording to a wrapper
over `fetch` when it ratified the record.

**5.4 One dependency in place of the separate declarations.** `substrat push` reads it and checks
it against installed consumers, and an install binds the two apps. Properties are set per contract
inside the dependency, since one pair of apps already has both calls as the app and calls as the
person. *Costs:* a migration of every manifest, a period where both spellings work, and a
dependency graph the platform keeps consistent per tenant, which it does not do today.

**5.5 People are owned by a master.** Built in a first form (§4.4). What remains: a declaration
`substrat push` reads, the binding at install, an erasure at the master that reaches every
dependent, and where names and addresses live (§7.4). *Costs:* the master is a point everything
depends on. If it is down longer than the answer lives, every dependent closes.

**5.6 Calls as the person, in both directions.** A plugin cannot read the master's data as the
person today (dependent-people.md §5.3), and a peer call names a vertical, not a scope in it
(`packages/contracts/src/peer-transport.ts`). Most real cases need both. *Costs:* a token exchange
per receiver, and a new kind of trust: the calling app holds the person's refresh token while the
session lives. The history has to show which app made a call before this is used widely.

**5.7 Master data and entity contracts.** A contract carries lifecycle events, a paged list for
start-up and a sequence number per entity. A consumer that does not handle merge and erasure is not
installed. *Costs:* the most discipline of anything here. Every consumer handles gaps, order and
late delivery. Personal data in copies needs the export rule changed, and two versions of one event
cannot be emitted side by side today (K-39).

**5.8 Storage belongs to a scope.** A store is reached only after an operation has checked the
permission. What concerns the whole tenant moves to a home scope. *Costs:* how an operation reaches
its store is not settled (§7.2), the home scope may be a bottleneck (§7.7), and K-53 is accepted, so
a record that replaces it has to say how its requirement is met: several apps writing to one store
while a user waits. *Decided in [K-64](../decisions/K-064-a-scope-has-a-declared-type-and-may-have-a-parent-and-nothing-crosses-a-scope-s-boundary-inside-its-transaction.md):* K-53 is
superseded. A tenant-wide data layer is either an app that owns it or a projection derived from the
apps' events, and the form is chosen when the first one is built.

**5.9 One connector contract, and placement as a registration fact.** A network part speaks one
contract, D-73's. Where it runs is recorded in its registration.

| Placement | When |
|---|---|
| The app's own worker | the app's author wrote the network part |
| Run by the platform, as its own script | the platform's own connectors, and code from a third party |
| A mock profile answering from recorded calls | local runs, CI, previews |
| A developer's machine, through a tunnel | debugging against a preview; never production |

**Who may see the credential decides the placement.** A credential entered on the dashboard does
not reach a vertical's code for a first-party connector today. Moving that call into the app's
worker would hand the token to the app's author, a step back for an app its tenant does not own.

**In process in the control plane is an interim placement, not a fifth row.** Phase 1 leaves the
platform's connectors where they run and changes what they are handed. It ends connector by
connector, when one is given a script of its own. If D-73's pilot finds the hop costs too much for
some connector, that connector stays in process and the control plane still runs its code.

*Costs,* once connectors move out: a hop per call nobody has measured, several versions live at
once, and operations spread over more scripts. A change is then no longer a control-plane deploy,
but it does not reach fewer tenants: a patch replaced in place reaches every tenant on that major.
What narrows is what a faulty change can take down, and what can arrive unasked.

**5.10 One version rule.** §6.

**5.11 Commands with three outcomes, and processes.** A command answers done, accepted with a
request id, or failed, declared from the start so an operation can later become a process without
breaking a caller. A query always answers directly. Processes are a layer of their own (§7.6).
*Costs:* the three outcomes are cheap now and expensive later. The process layer is the largest
single build in the target and has no first user.

**5.12 Tracing and a local run.** A W3C trace id follows a call through the router, egress, calls
between apps and connector calls. `substrat dev` runs network parts through the hosted contract,
holds them to the declared hosts and answers from recorded calls. Each difference between local
and hosted was found so far after a suite passed on node and failed hosted
([#1655](https://github.com/substrat-run/substrat/issues/1655),
[#1786](https://github.com/substrat-run/substrat/issues/1786),
[#1291](https://github.com/substrat-run/substrat/issues/1291),
[#2245](https://github.com/substrat-run/substrat/issues/2245)). *Costs:* local emulation is a second
implementation that can drift, and a recording of real calls can hold customer data.

**5.13 Plugins.** A plugin is an app that depends on its host. The host declares what can be
extended: entity contracts, events and places in the interface. A synchronous hook, where a plugin
may stop the host's write, is not allowed in a first version. *Costs:* a script per plugin, and a
host that stops knowing its plugins by name, which the reference pair does not do yet.

## 6. One version rule

> Code you import, you pin. What the platform or another app runs for you is versioned per major
> and changes additively within it. A breaking change is a new major that lives beside the old one
> until a stated date.

**"You" is the app's owner,** the party that pins and pushes.

- A module, an engine included, is pinned in the app's `package.json` and bundled at build.
- A network part the platform runs, a store driver, and a contract another app serves each have a
  major. A minor or a patch replaces it in place, and so reaches everyone on that major at once.
- An app has one serving version (K-33). It carries a contract's old and new major during a
  transition.

**A tenant that installed a listed app is the open case.** Today the publisher's promote changes
the code serving that tenant's scopes with no push of the tenant's own, which
marketplace-publish.md §5.1 promised would not happen. The proposed answer is §7.5: an install
follows the publisher within a major. *Decided in K-65*, which rewrote §5.1 and amended K-33: one
serving script per major, a schema-change update that applies on its own, an old major kept at least
90 days after the next, and a breaking promote of a listed app refused within its major.

*Costs:* old majors are kept alive, tested and retired on a date somebody answers for. Additive is
a promise that can be broken by mistake.

## 7. Where the answer is not given

For each: the alternatives, what this RFC leans to, and what would settle it.

**7.1 One app or two: scope types against dependencies.** Scope types
([#2993](https://github.com/substrat-run/substrat/issues/2993)) give a parent and child scopes with
their own modules, roles and stores. That is a second mechanism beside dependencies. The other
view is that whatever does not share a transaction is its own app, which is one mechanism but puts
a versioned contract, two deploys and two router hops between parts that always ship together. The
target's home scope is already a second sort of scope. *Lean:* two built-in sorts, a home scope and
an instance scope, and no child scopes. Split an app in two when a second consumer of the inner
part exists, since a contract cut from one case is seldom right. *Against:* a seam nothing enforces
tends to leak, and splitting later costs more. *Decided in K-64:* declared scope types, of which
the home scope is one, and a parent link. A call into another scope goes through the door from host
code, never inside a transaction.

**7.2 How an operation reaches its store.** `ctx.store` inside the operation is the simplest code.
Against it: a call from a Durable Object does not pass egress, the scope's queue stands still
while the store answers, and K-62 says an operation does not await an outside call in its
transaction. The alternative is that the operation checks the permission and mints a narrow,
short-lived capability, and the host makes the call, with the router requiring the proof before it
signs. That keeps the kernel's check and a line in the history with no network in the scope, at the
price of two steps and no read from the store mid-logic. Neither gives one transaction across the
database and the store. *Lean:* the proof, with moderate confidence. A spike showing a call from
inside the scope works and does not stall the queue would change it. *Decided in K-64:* the proof,
with the phase 1 spike allowed to reopen it for reads only.

**7.3 What guarantees a revocation.** A push from the master is fast but can be dropped. An answer
that expires needs no delivery guarantee but is never faster than the expiry. *Lean:* the expiry is
the guarantee and the push is the fast path, with the auth server's sessions revoked at the block
so a session never outlives its token. The number is less certain: 300 seconds may be too long for
some apps and should be settable per dependency, at the cost of more questions to the master.
*Decided in [K-63](../decisions/K-063-a-tenant-s-people-are-owned-by-one-app-and-its-plugins-keep-the-master-s-answer-for-a-bounded-time.md):* the expiry is the guarantee, 300 seconds is the
default, and a dependency may set a shorter time, never a longer one.

**7.4 Where people and their details live.** An app owns them, or the tenant directory does (one
copy, a stronger guarantee, and no reason left for a product to be the master). *Lean:* an app,
as the code does. The answer is kept once per vertical and tenant, not once per scope
([K-22](../decisions/K-022-the-membership-seam-is-a-connector-and-orgid-becomes-a-brand.md) turned
copies per scope down for membership). For names and addresses, the built contract carries
neither, so each plugin will cache them where no erasure reaches. *Lean:* the platform-held profile
copy of dependent-people.md §5.2, the only alternative where erasure can be shown. Decide it before
a second plugin exists. *Decided in K-63:* an app owns the people, and names and addresses come from
the platform-held profile copy, which the platform erases when the master erases the person.

**7.5 Who decides when an install changes version.** Every install stays on its version: safest
for the installer, but it needs a serving script per version, which K-33 gave up because a Durable
Object's data belongs to its script. Every install follows the publisher: what happens today, and a
publisher can change code that runs on a tenant's data unasked. *Lean:* an install follows within a
major, with notice and the code-only or schema-change badge K-33 already has. A breaking change is
a new major in its own script, and the installer moves there with the adopt-serving hop K-33
already has. Less certain: how often a new major is needed. If often, that hop is an everyday
routine, and it is not proven as one. *Decided in K-65*, as leaned.

**7.6 The process engine: when, and on what.** For building now: the contract's shape reaches every
client. For waiting: nothing uses one, the one written need
([#3289](https://github.com/substrat-run/substrat/issues/3289)) is met by K-62's committed attempt,
and it would be the largest new surface while the aim is to remove things. *Lean:* the three
outcomes now, the engine at the first flow that waits on a person or a time across two apps.

*What it runs on.* Cloudflare Workflows is the default candidate, not an engine of our own. It is a
layer above the scopes, not in place of them. An instance holds how far a flow has got. Every
domain fact stays in a scope, where a row, its event and its check commit in one transaction. A step
is one scope operation, called with an idempotency key made from the instance and the step. A wait
on a person is a wait for an event, and a wait on a time is a sleep. Two wider uses are not
proposed: Workflows as the store of current state, and Workflows as the way every command runs. A
step does not commit with the outbox, most commands answer directly, and the pure SQLite host (dev,
CI, self-host, escrow) has no Workflows. So the engine is a kernel contract with two
implementations, as the scope host is today: Workflows when hosted, and a step journal on SQLite
with an alarm for the pure host.

Cloudflare's documentation for Workers for Platforms lists Workflows among the bindings a user
Worker can carry. That was not tried here. What is not known is how an instance behaves when the
platform changes the script under it. A push only uploads an archive script; it is a production
promote that replaces the serving script in place (K-33), so an instance started on one version
wakes on another version's code. A preview runs on an archive script against a copy that must
stay inert ([#2005](https://github.com/substrat-run/substrat/issues/2005)). Phase 1's spike tests
both, and the candidate stays or is dropped on the rule §8 gives for that spike. Also uncertain is
who a step acts as after a long wait. *Lean:* it runs as the app, and a step needing a person's
right is an approval step a person takes.

**7.7 The home scope as the one place for tenant data.** It takes one call at a time, so everything
tenant-wide queues. Nobody knows the limit until it is measured. *Lean:* shrink what has to live
there (people stay in the directory's answer, a person's projects are a read across scopes) and
remove storage per tenant only after measuring.

**7.8 Permissions that depend on another app.** "Who may see the customer may see its vehicles"
works for one record and not for a list of a thousand. Copy the access facts (fast, and a copy of
access data to revoke), filter at the source (one truth, a call per page, hard paging), or turn the
question round: the host lists what the person sees and asks the plugin for those. *Lean:* the
third first, the second when a plugin needs a list of its own.

**7.9 A plugin's interface.** Deployed, a host and its plugin are two origins with two sessions.
The host draws the plugin's features itself (works today; the host must know every plugin), the
plugin ships an interface mounted in an isolated frame with a narrow capability per frame (K-56),
or the plugin ships components built into the host (best experience; the plugin's code in the
host's origin). *Lean:* the frame for plugins a customer builds, the first for plugins built
alongside the host. It is settled with a real plugin, not on paper.

**7.10 Previews when apps depend on each other.** A fork or a preview is never an end of an edge
between apps today ([cross-vertical-events.md](../architecture/cross-vertical-events.md)). The
preview talks to the other app's production version read-only, gets a fork of the other app too, or
is answered from recorded calls. *Lean:* recorded calls first, then read-only. It is settled before
any app is split in two.

## 8. Order

Four phases in sequence, a storage track beside them, and a list that waits on need. Each phase
removes something, and none rests on a record that is not decided. The phases are not dated.

**Phase 0: decisions.** Nothing is built. The seven proposed records are ratified or withdrawn, D-71
among them because the storage track needs it. *Done for the seven on 2026-11-23:* all were
ratified. D-61's clause on platform-authored code was narrowed to a wrapper over `fetch`, since read
as a general rule it contradicted the platform entry that is shipped (§5.3). D-73 was ratified as a
contract, with placement in a script of its own left to its pilot. What remains of phase 0 follows.
dependent-people.md becomes a decision: done on 2026-11-24, as K-63. K-53 and the scope-types tracking issue
([#2992](https://github.com/substrat-run/substrat/issues/2992)) are settled together, being one
question: done on 2026-11-24, as K-64, which supersedes K-53. The version rule is written once,
with the answer to §7.5: done on 2026-11-24, as K-65. The words are fixed: done on 2026-11-24, as
D-75.

*Three questions remain open,* raised on 2026-11-24 by an addendum that takes the model as the
source of an app's code: a modelling tool keeps the model, and a generator writes the vertical's
declarations, its rules and its migrations from it.

1. **The generation target.** Does a generator write against the typed API, or against a declared
   surface that the platform loads, so that written code can fill only the obligations the surface
   declares? *Answered in [D-76](../decisions/D-076-a-generator-writes-typed-typescript-and-the-platform-refuses-a-release-whose-re-emitted-surface-differs-by-a-byte.md):* typed TypeScript, against the same API
   a hand-written app uses.
2. **The surface check.** Does the platform refuse an app whose emitted surface does not match its
   model revision, or does that stay a check in CI? A check inside the bundle is not a boundary
   against the app itself (D-61's reasoning), so a refusal compares what a push emits. *Answered
   in part by D-76:* the platform's build re-emits `model.json`, `openapi.json` and `PERMISSIONS.md`
   from the app's **source revision** and refuses a release where any differs by a byte. That holds
   the files to the source, not the source to the model: if the model moves on and the generated
   source does not, the check still passes. Whether a release is also checked against its **model
   revision**, by regenerating the source from it, is still open.
3. **The model's boundary.** [model-phase-plan.md](./model-phase-plan.md) says the model gets no
   richer vocabulary and points at written code instead. The addendum puts rules in the model. Where
   the line runs now is open.

The generated entry ([#3378](https://github.com/substrat-run/substrat/issues/3378)) waited on the
first, because it has to be the last link of the same generation chain, not a second generator
beside the model's. D-76 answers it. The model-revision half of the second question and the third
question remain. *Done when* no coming build rests on a proposed record, and these three are
answered.

**Phase 1: one door.** The platform's connectors move onto the shared contract and stay in
process, with a sweep role per connection first, so a rate-limited provider is not polled once per
scope. The entry is generated. K-58's envelope rolls out. A trace id follows calls. `substrat dev`
runs network parts locally with recorded answers. Three spikes run meanwhile: Cloudflare Workflows
in Workers for Platforms (below), a call from inside a scope to its store, and no network in scope
code as a mechanism. *Removes* `HostAdmin` from provider code, one of three connector
implementations, the vertical's hand-written entry (not the platform entry of §5.3, which stays)
and the shared secret between router and vertical
([K-27](../decisions/K-027-the-router-presents-a-shared-secret-and-the-vertical-verifie.md)). *Done
when* no provider code reaches `HostAdmin` and every vertical runs a generated entry.

*The Workflows spike* runs on a script uploaded the way the uploader uploads a vertical. It is done
when it has answered five questions:

- **Binding.** Can the uploader bind a Workflow class to a script in the dispatch namespace? Does an
  instance started from it reach the scope's operations through the same door as any other call?
- **Waking.** The case that motivates the engine runs the other way. An event committed in a scope's
  outbox has to wake the instance waiting for it. That event may be another vertical's, arriving
  through cross-vertical delivery ([cross-vertical-events.md](../architecture/cross-vertical-events.md)).
  Who delivers it: a consumer in the scope, or the dispatcher calling the instance's event API? Is
  that delivery at least once, and is a repeat harmless? What happens to an event that arrives
  before the instance reaches its wait?
- **A promote with instances in flight.** A push only uploads an archive script; a production
  promote replaces the serving script in place (K-33), so the spike promotes, not only pushes. Does
  a sleeping or waiting instance resume on the promoted code? What does a completed step's recorded
  result mean to code that renamed, removed or reordered steps? Can an instance stay on the version
  that started it, or must it be drained before a promote that changes its steps?
- **A preview.** Does an instance started on a preview's archive script stay tied to that script and
  its copy? Are its steps inert like every other door on a copy (#2005)? What happens to its
  instances when the preview is deleted, or when its data is carried onto a new version
  ([#1710](https://github.com/substrat-run/substrat/issues/1710))?
- **Cost.** What does an instance that sleeps or waits for weeks cost?

This is the one rule for whether Workflows stays the default. It stays only if the spike shows all
four of the following:

- The uploader binds a Workflow class to a script in the dispatch namespace, and an instance
  started from it runs scope operations through the same door as any other call.
- An event committed in a scope reaches the instance waiting for it, through a deliverer the spike
  names. Delivery is at least once, a repeat is harmless, and an event that arrives before the wait
  is not lost.
- An instance in flight behaves predictably across a production promote. It either resumes on the
  promoted code with defined results, or it is held on its version or drained first.
- An instance started on a preview stays tied to the archive script and its copy, and its steps are
  inert there.

Otherwise, Workflows is no longer the default, and that includes a question the spike cannot
answer. The engine is then the step journal in the scope on both hosts.

**Phase 2: one edge.** The dependency enters the manifest and replaces the separate declarations.
Push and install check against consumers. A peer call can name a scope, and calls as the person
work in both directions. The three outcomes become convention. Two decisions are taken here,
because the first plugin needs them: §7.9 and §7.10. *Done when* a plugin is installed and bound
to its host with no hand-written wiring, and the old spellings are gone.

**Phase 3: master data.** The person contract is finished: the profile copy, an erasure that
reaches every dependent, and a history showing which app acted. The block gets its fast path.
Entity contracts arrive with lifecycle events and a paged list. *Done when* a person erased at the
master is shown to be gone from every dependent.

**Beside them: storage.** First, a store driver in operation, which needs D-70 and D-71
settled in phase 0 and a release approved. Then store calls are allowed while a vertical serves a peer call,
and the door starts requiring a proof. A vector index follows
[K-57](../decisions/K-057-a-semantic-index-is-scope-local-a-semantic-read-is-declared-eventual-an-external-index-only-as-a-store-driver.md)
when an app needs one. The home scope is measured, and only then is storage per tenant removed.

**Waiting on a named need.** The process engine, at the first flow that waits across two apps.
Connectors in scripts of their own, when the pilot has measured the hop. A connector's data part
as a module, after two or three mirrors written by hand, and only for the app's own code and the
platform's: a module in the scope has `ctx.sql` on the same database as the app's tables, and that
modules leave each other's tables alone
([D-28](../decisions/D-028-engine-compatibility-surface-pinned.md)) is held by boundary-lint, not by
the kernel. Derived permissions for lists, and more than one master.

**Least certain in the order.** Phase 1 gives nothing a customer sees. The connector contract and
tracing are independent of the rest and can run beside phase 2. The envelope and the generated
entry come before the dependency, which builds on a call carrying app and actor. If a plugin is
urgent, build it on what exists, with the host drawing its interface, and move it to the
dependency in phase 2.

## 9. What gets worse

| What gets worse | Why |
|---|---|
| A fix goes from one deploy to many pushes | Today one control-plane deploy fixes a connector for every tenant. A part bundled with the app is upgraded by each app. |
| Several versions live at once | Pinning gives a matrix to test and support, and old majors to keep until they are retired. |
| "Changes additively" can still break somebody | A change meant to be harmless can alter behaviour an app came to depend on. |
| Contracts are rigid | With a `HostAdmin` in reach, a new need is one pull request. After, it is a role in a contract that only grows. |
| The master is a point of failure | Every dependent closes when it does not answer. |
| Copies have to be kept in step | People and entities are held in more places, and erasure has to reach each. |
| Operations spread out | Code, logs and state sit in several scripts and scopes. |
| The transition adds paths before it removes any | Stopping half-way leaves more than there is today. |

## 10. Not verified, not measured

- The proposal on dependencies is carried here as its synthesis states it. Its own text was not at
  hand.
- Nothing was run. "Built" means the repository's documents and code say so.
- Not measured: the hop a connector script adds, the response time of a call between two apps
  through the router and egress, and the home scope as a bottleneck.
- Not known: how a Workflow instance in flight behaves when a promote replaces its script in place,
  and in a preview, and how an event committed in a scope reaches an instance waiting for it.
  Cloudflare documents the binding for a user Worker, and it was not tried. Also not known: whether
  no network in scope code can be a mechanism on the platform today.
