---
id: D-63
date: 2026-10-12
layer: plan
title: "A store kind is platform code, registered and pinned like a connector"
status: accepted
aliases: []
amends: []
tracking: ["#2207", "#2210", "#2297"]
---

# D-63 — A store kind is platform code, registered and pinned like a connector

> **Ratified 2026-10-15, amended.** The proposal of 2026-10-12 pinned a kind to "an exact release" and did not say what identifies one. The ratified text says it: the sha256 of the release bundle and the source commit the bundle was built from. It also says who publishes, what the canary asserts, where a rollback goes, and which module names a release may use. The proposal on [#2298](https://github.com/substrat-run/substrat/pull/2298) to stop pinning releases was considered and is not accepted as written (see Why).

**A store kind is platform code. It is registered in this repo, and a release of it runs only once this repo pins it.** The registration names the kind, the script, the class and the operation catalog. A release is identified by two values: the sha256 of the release bundle, and the source commit the bundle was built from. Both are recorded in the registration, or in an allowlist file the registration names. The bytes do not have to live in this repo, and they may be published to the platform before the pin lands. The platform runs a release only once its sha256 and its source commit are pinned here by a reviewed change. A review of that change is the review of what the platform will run for every tenant. It has to show the envelope, the reserved operations (including `substrat.erase`), and no per-object state at module level. The kind's own suite lives in its repo and runs against the same envelope. This repo's contract suite runs against a trivial test kind and does not import a real one.

**A release is published by a person.** Publishing takes a staff credential held by a human. The CI and automation service token does not publish a release. A rollout starts with a canary, and the canary calls every reserved operation, `substrat.erase` included, and asserts its answer before the rollout continues. A failed canary, and a rollback, return to the immediately previous good release. The module names in a release bundle are validated, and the names the platform's entry module imports are reserved, so a release cannot ship a module under one of them.

Until a kind is registered, a push that declares `scopeStores` is refused, by the CLI's push check and again by the control plane. A declaration the platform cannot run is not stored as if it could.

**One script per (kind, vertical), upgraded in place.** A later release replaces that script. The objects keep their storage, and the kind migrates its schema when an object wakes. A script per version would be a new namespace and an empty object, so that model is rejected. A script shared by every vertical is also rejected for the first hosted kind: a kind the platform did not write cannot be assumed to keep module-level state out, and a tenant that exhausts an isolate should restart that vertical's objects only. Who uploads the script, and what a failed upload does to the push, is [#2210](https://github.com/substrat-run/substrat/issues/2210). `substrat dev` runs the runner and does not upload one.

The local runner is the kind's. Substrat defines the interface — address, envelope, reserved operations, start and stop — and owns no external process in the adapter. Hosted deploy, snapshot and metering ([#2210](https://github.com/substrat-run/substrat/issues/2210), [#2211](https://github.com/substrat-run/substrat/issues/2211), [#2212](https://github.com/substrat-run/substrat/issues/2212)) consume this and do not change it.

## Why

[#2207](https://github.com/substrat-run/substrat/issues/2207), and the note on it of 2026-10-11: a kind is registered rather than owned, the isolate default is decided before any tenant data is stored, erasure has an answer before a hosted store ships, and the kind ships its own runner. The addressing half, and why the host owns the object name, is [K-49](./K-049-a-scope-store-is-a-platform-run-object-per-scope-reached-by-its-own-door.md). The evidence for the shared script is [the spike](../../spikes/scope-store-binding/FINDINGS.md).

A kind's code runs in one script for every object of its (kind, vertical), across every tenant of that vertical. Until a kind cannot affect data outside the object it serves by construction — a separate script per tenant, no outbound access, and verification of the envelope outside the kind's reach — the review of a release is the control that stands between that release and every tenant it serves. The sha256 names the bytes that run. The source commit names the code a reviewer reads. A person publishing, a canary over every reserved operation, and a rollback to the last good release keep a reviewed release from reaching tenants by any other path. This decision is to be revisited when that isolation exists.

**Considered: unpinned releases (D-64 as proposed on [#2298](https://github.com/substrat-run/substrat/pull/2298)).** It would register a kind once, name no release in this repo, and let anyone the registration allows to publish ship a release, with the control plane recording the sha256 of the bytes it receives. It is not accepted as written, for three reasons. The credential it names for publishing, staff, includes the automation service token, so a release could reach every tenant without a person acting. The sha256 is computed server-side from the bytes the control plane was handed, so it records what arrived and is no provenance. And without a pin, no reviewed change in this repo stands behind a release, while that review is the only control until the isolation above exists. The other half of that proposal, the envelope with one Ed25519 private key per audience and a store script that holds public keys only, is accepted in principle. It is not decided here: it gets its own record once the envelope pull requests ([#2293](https://github.com/substrat-run/substrat/pull/2293), [#2294](https://github.com/substrat-run/substrat/pull/2294), [#2295](https://github.com/substrat-run/substrat/pull/2295)) are final.
