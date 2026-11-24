---
id: D-75
date: 2026-11-24
layer: plan
title: "Five concepts and one glossary: scope, module, app, store and dependency"
status: accepted
aliases: []
amends: []
tracking: []
---

# D-75 — Five concepts and one glossary: scope, module, app, store and dependency

> **Accepted 2026-11-24**, as the last item of phase 0 of
> [one-model-for-shipped-code.md](../rfc/one-model-for-shipped-code.md) ("the words are fixed",
> §5.1). It fixes the words the platform uses outward. It renames nothing in code.

**Five concepts carry the model: scope, module, app, store and dependency.** A rule attaches to one
of them, or to a property one of them has, and not to a noun of its own. The eight names for shipped
code that the RFC counted (§1) reduce to these five.

## The five

- **Scope.** The unit of data, isolation and permission. A scope is one database that runs one
  transaction at a time. It belongs to one tenant and one app. A module's operations run in it, and
  every permission is checked in it. A scope has a declared type and may have a parent
  ([K-64](./K-064-a-scope-has-a-declared-type-and-may-have-a-parent-and-nothing-crosses-a-scope-s-boundary-inside-its-transaction.md)).
  The **home scope** is the type that holds what concerns a whole tenant within one app.
- **Module.** The one kind of code anyone writes. A module declares entities, operations, events,
  permissions and migrations, and its operations run in a scope. An **engine** is a module published
  for reuse. A **connector** is a module with a network part, and the network part runs outside the
  scope.
- **App.** What is deployed: a set of modules at fixed versions, served from one script per major
  ([K-65](./K-065-one-version-rule-an-install-follows-its-app-within-a-major-and-a-breaking-change-is-a-new-major-served-beside-the-old.md)).
  An app has scopes, a **worker** (its code outside the scopes, which holds no state of its own and
  is the only part that calls anything else) and stores. A **plugin** is an app with a dependency on
  its host. The code calls an app a *vertical*.
- **Store.** Data that belongs to a scope and lives in an object the platform runs, such as a graph,
  files or a search index. A store is backed by a **driver**, the code the older records call a
  *kind*. A driver is registered in this repository, and a release of it runs only once a person on
  the platform's staff has approved its uploaded bytes
  ([D-65](./D-065-a-store-driver-release-runs-after-a-person-approves-its-uploaded-bytes.md)). No
  store is shared between apps (K-64).
- **Dependency.** The one edge between two apps. Both apps declare it. It names the contracts one app
  uses of the other, and how: as the app or as the signed-in person, and with or without personal
  data. Everything that crosses it passes the door. Taking people from a master is a dependency
  ([K-63](./K-063-a-tenant-s-people-are-owned-by-one-app-and-its-plugins-keep-the-master-s-answer-for-a-bounded-time.md)).

## Words that support them

- **Tenant.** The customer business. It holds apps and their scopes, and it is the isolation
  boundary between customers.
- **Door.** The one way into an app or a scope. A call through it is to carry a signed envelope that
  the receiver checks for itself
  ([K-58](./K-058-a-call-from-the-platform-to-a-vertical-carries-an-ed25519-envelope-and-a-deployed-vertical-holds-public-keys-only.md)).
  That is phase 1's target. Until an environment's down-channel is `signed-only`, the router's
  shared secret
  ([K-27](./K-027-the-router-presents-a-shared-secret-and-the-vertical-verifie.md)) still admits a
  call.
- **Contract.** What an app offers across a dependency: operations, events or an entity's lifecycle.
  It is versioned per major (K-65).
- **Master.** The app or module that owns a fact: the people of a tenant (K-63), or an entity, which
  is created and removed only there.
- **Major.** The version boundary inside which everything changes only additively (K-65).

## Names that are retired

| Old name | Now |
|---|---|
| vertical | app. The code keeps *vertical* |
| engine | a module published for reuse |
| first-party connector, vertical-defined connector | a connector: a module with a network part, whoever wrote it. Where it runs is a registration fact ([D-73](./D-073-a-connector-is-its-own-deployable-unit-with-one-call-contract.md)) |
| plugin | an app with a dependency on its host |
| store kind | driver |
| extension | only what [K-56](./K-056-a-runtime-installed-extension-acts-only-as-a-capability-the-vertical-mints-for-it.md) means: something a person installs at runtime, acting only through a capability the app mints for it. A separately deployed addition is a plugin |

**The rename is outward only.** Text written for a reader outside this repository says *app*: the
docs site, the dashboard, the console, the CLI's messages and the scaffold's README. Package names
(`@substrat-run/vertical-host`), manifest fields, directory names (`demos/`, `engines/`,
`connectors/`), code identifiers and the decision records keep *vertical*, *engine* and
*connector*. Existing outward pages change when they are next edited. Nothing enforces this yet.

## Why

**Eight names for shipped code meant a rule attached to a noun.** Whether something was an engine,
a connector or a plugin decided which lints, directories and review rules applied, while what
mattered was a property: published for reuse, has a network part, depends on a host. Naming the
property puts the rule where the property is.

**"App" is the word a customer already uses.** *Vertical* describes a market, not a deployed
thing, and every page that says it has to explain it first. A rename in code would touch packages,
manifests and lints for no gain to a reader, and the RFC priced it so (§5.1).

## Not done here

A lint that refuses *vertical* in outward text, and a sweep of existing outward pages. The
platform guide's planned "Extensions" section describes separately deployed additions, which this
record calls plugins, and is renamed when that page is next edited.
