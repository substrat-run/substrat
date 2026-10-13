---
id: D-63
date: 2026-10-12
layer: plan
title: "A store kind is platform code, registered and pinned like a connector"
status: proposed
aliases: []
amends: []
tracking: ["#2207", "#2210"]
---

# D-63 — A store kind is platform code, registered and pinned like a connector

**A store kind is platform code. It is registered in this repo, pinned to an exact release, the way a connector is.** The registration names the kind, the release, the script, the class and the operation catalog. A review of it is the review of what the platform will run for every tenant. It has to show the envelope, the reserved operations (including `substrat.erase`), and no per-object state at module level. The kind's own suite lives in its repo and runs against the same envelope. This repo's contract suite runs against a trivial test kind and does not import a real one.

Until a kind is registered, a push that declares `scopeStores` is refused, by the CLI's push check and again by the control plane. A declaration the platform cannot run is not stored as if it could.

**One script per (kind, vertical), upgraded in place.** A later release replaces that script. The objects keep their storage, and the kind migrates its schema when an object wakes. A script per version would be a new namespace and an empty object, so that model is rejected. A script shared by every vertical is also rejected for the first hosted kind: a kind the platform did not write cannot be assumed to keep module-level state out, and a tenant that exhausts an isolate should restart that vertical's objects only. Who uploads the script, and what a failed upload does to the push, is [#2210](https://github.com/substrat-run/substrat/issues/2210). `substrat dev` runs the runner and does not upload one.

The local runner is the kind's. Substrat defines the interface — address, envelope, reserved operations, start and stop — and owns no external process in the adapter. Hosted deploy, snapshot and metering ([#2210](https://github.com/substrat-run/substrat/issues/2210), [#2211](https://github.com/substrat-run/substrat/issues/2211), [#2212](https://github.com/substrat-run/substrat/issues/2212)) consume this and do not change it.

## Why

[#2207](https://github.com/substrat-run/substrat/issues/2207), and the note on it of 2026-10-11: a kind is registered rather than owned, the isolate default is decided before any tenant data is stored, erasure has an answer before a hosted store ships, and the kind ships its own runner. The addressing half, and why the host owns the object name, is [K-49](./K-049-a-scope-store-is-a-platform-run-object-per-scope-reached-by-its-own-door.md). The evidence for the shared script is [the spike](../../spikes/scope-store-binding/FINDINGS.md).
