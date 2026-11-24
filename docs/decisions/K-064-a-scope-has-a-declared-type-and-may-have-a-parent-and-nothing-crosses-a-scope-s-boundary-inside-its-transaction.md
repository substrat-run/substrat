---
id: K-64
date: 2026-11-24
layer: kernel
title: "A scope has a declared type and may have a parent, and nothing crosses a scope's boundary inside its transaction"
status: accepted
aliases: []
amends: ["K-49"]
tracking: ["#2992", "#2993", "#2994", "#2995", "#2996"]
---

# K-64 — A scope has a declared type and may have a parent, and nothing crosses a scope's boundary inside its transaction

> **Accepted 2026-11-24**, from the maintainer's answers in phase 0 of
> [one-model-for-shipped-code.md](../rfc/one-model-for-shipped-code.md), which settles
> [K-53](./K-053-a-tenant-level-store-is-a-named-instance-that-a-tenant-s-verticals-connect-to-explicitly.md)
> and the scope-types tracking issue #2992 together as one question (§7.1, §7.2, §5.8). It answers
> #2992's five questions and **supersedes K-53**. Nothing in it is built.

**One rule holds the rest together: nothing crosses a Durable Object's boundary inside a
transaction, and everything that crosses one passes the door.** A call into another scope, or into a
store, is made from host code, between two transactions, and it carries a signed envelope naming
the calling app and the actor. The receiver checks for itself. That envelope is
[K-58](./K-058-a-call-from-the-platform-to-a-vertical-carries-an-ed25519-envelope-and-a-deployed-vertical-holds-public-keys-only.md)'s,
extended (below). This is
[K-62](./K-062-an-operation-does-not-await-an-outside-call-inside-its-transaction.md)'s rule applied
to the platform's own objects as well as to outside services.

**A vertical declares types of scope.** Each type has its own modules, migrations, roles, permission
keys and stores, and the declaration says which types may be children of which (#2993). The home
scope of the one-model RFC is one such type, not a special case. A vertical that declares no types
has one, and behaves as every vertical does today. A scope of one type carries no tables of another,
and an operation another type declares cannot be called on it.

**A scope may have a parent.** The directory records the link, a child is provisioned through a
platform intent beside `provision-sibling`, and the link is what a child's reach and lifecycle are
judged by (#2995). A parent reaches its child only through the door, as the requesting person or, where
the child admits it, as the app. It never reaches around the child's own check. There is no
`ctx.scope(id).invoke()` inside an operation. A parent that needs an ordered exchange with a child
commits its intent first, host code makes the call, and a second operation records the outcome. A
store call to a sibling scope (#2407) is not allowed. Reach follows the parent link.

**A module operation does not call its store inside its transaction** (#2996, one-model §7.2). The
operation checks a permission key declared per store operation, and commits an attempt or mints a
narrow, short-lived capability. Host code makes the store call through the router, and the router
refuses it without that proof. A second operation records the result. This amends
[K-49](./K-049-a-scope-store-is-a-platform-run-object-per-scope-reached-by-its-own-door.md): its door
checks the (tenant, scope) pair and the declared binding, and once this is built it also requires the
proof an operation's check produced. Phase 1's spike (a call from inside a scope to its store) may
reopen this for reads only. A write always goes this way.

**The caller travels in the envelope.** #2994's signed caller assertion becomes two signed claims:
the calling app and the actor. K-58's envelope does not carry them today. `substrat-wire/1` has
fifteen fields in a closed table, and its `issuer` names only `router` or `platform`. Two amendments
are owed, each a record of its own, before any receiver relies on either claim:

- **K-58**, for a new version of its envelope that adds the calling app and the actor as signed
  fields, with the (issuer, kind) pairs that carry them. Proposed as [K-66](./K-066-the-wire-envelope-s-second-version-names-the-calling-app-its-scope-and-the-actor-and-the-router-signs-only-what-it-verified.md).
- **[K-52](./K-052-the-scope-store-envelope-is-ed25519-per-audience-and-an-object-is-bound-to-its-name-by-its-id.md)**,
  so that a store call carries the actor too, and a store can tie a session to a person. Proposed as
  [K-67](./K-067-a-store-call-s-second-envelope-version-names-the-actor-and-the-router-names-a-person-only-after-verifying-their-token.md).

Until then, nothing in this record that reads the calling app or the actor is built.

**K-53 is superseded: there is no store that several apps of a tenant write to.** Data has one
owner. A tenant-wide data layer over a tenant's apps, K-53's requirement, takes one of two forms,
chosen when the first such layer is built:

- **An app that owns it.** Other apps read it directly through a contract, and write through a
  queued request that the owning app runs in its own transaction.
- **A projection the platform derives from the apps' exported events.** It is read-only and can be
  rebuilt, and every fact in it still has one owner.

A store that one app needs at tenant level lives in that app's home scope. Every store driver is
scope-grain, the registered graph driver included (D-67), so no driver declares a grain. Two parts
of K-53 stand unchanged: a store is backed by a **driver**, the word the code has used since #2324,
and what the platform does to a store (export, wipe, erasure) stays the control plane's, as
[K-50](./K-050-a-hosted-scope-store-s-lifecycle-is-driven-by-the-platform-from-its-own-record.md) holds.

## Why

**A transaction cannot span two objects, so waiting on one inside it buys nothing.** The child's
commit and the parent's are separate whether or not the parent waits. Waiting adds coupled latency
(the parent's queue stands still while the child answers), a deadlock when two scopes call each
other, and a call that bypasses egress. Committing the intent first gives the ordering #2995 and
#2996 wanted, without pretending to an atomicity that does not exist.

**Domains have units of different shapes.** A clinic and a patient record, an application and a
project: each needs its own access list, its own lifecycle and its own erasure, and that is what a
scope already is. Declaring types makes the scope the general mechanism for it. The alternative the
RFC leaned to, splitting such a unit into its own app, puts a versioned contract, two deploys and two
router hops between parts that always ship together.

**A store several apps write to is a database shared between apps versioned apart.** Nobody owns
its invariants, its schema couples apps that release separately, and an erasure or a permission has
no single owner to answer for it. What is given up is a write across apps inside the request a
person waits on. It becomes "accepted, with a request id", which an interface can wait on. That
costs latency, not correctness.

## Not built

All of it: scope types, the parent link and its intent, the proof the router requires for a store
call, the calling app and the actor as signed claims (with the amendments to K-58 and K-52), and either
form of a tenant-wide data layer. Scope-grain stores, the driver rename and K-49's door as it stands today are unchanged by it.

## Revisit

This record is revisited if the phase 1 spike shows a store read from inside a scope is cheap and
passes a policed path, if a product needs a synchronous write across apps that a queued request
cannot serve, or if verticals and modules merge so that the line between a scope type and an app
moves.
