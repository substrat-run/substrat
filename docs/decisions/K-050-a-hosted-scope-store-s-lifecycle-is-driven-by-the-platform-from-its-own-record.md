---
id: K-50
date: 2026-10-13
layer: kernel
title: "A hosted scope store's lifecycle is driven by the platform, from its own record"
status: proposed
aliases: []
amends: ["K-49"]
tracking: ["#2207", "#2210", "#2211"]
---

# K-50 — A hosted scope store's lifecycle is driven by the platform, from its own record

**In a hosted deployment the control plane drives everything the platform does to a scope's stores.** That covers export, snapshot, fork, restore, import, reap and wipe, subject erasure, the size meter, and replaying erasures after a copy. The control plane reaches the store script through the dispatch namespace. The vertical's worker does not drive any of it, and `CloudflareScopeHost` does not drive it from ambient `SUBSTRAT_STORE_*` bindings. The vertical and its version come from the directory's scope record. The bindings and kinds come from that version's reviewed manifest record. Nothing about stores is wired into the vertical's worker, so a deployed vertical with no control plane needs no record of its own. The vertical never holds a raw store namespace. It keeps one door, `getScopeStore`, and a call through it takes the router hop K-49 describes. The vertical's `/internal/scope-store-*` routes are not part of a hosted release. The host-side lifecycle stays for the pure adapter and for dev, where the host process is the platform.

The owner has chosen this direction. This record carries it with K-49 for ratification.

The interim injection of a `SUBSTRAT_STORE_<BINDING>` `durable_object_namespace` into the serving upload is removed before the first kind is registered (#2210). The guard becomes "a hosted serving upload carries no `SUBSTRAT_STORE_*` binding, whatever is registered". Both signers, the router for a vertical's call and the control plane for the reserved operations, sign one envelope. Its MAC covers the version, the audience (`caller` or `platform`), the object name, the operation, a digest of the body, the issue time and a nonce. The store checks all of them, and the first name it accepted, before the kind's code runs.

The lifecycle fails closed:

- A wipe runs before every deletion of a scope's storage. A failed or undecidable wipe stops the delete.
- A restore imports only bindings the destination declares with the same kind. It then re-erases the union of the target's and the source's tombstoned subjects. An unknown source never refuses the restore: it is reported as `storeErasureIncomplete` with `storeErasureSourceUnknown`.
- Subject erasure never destroys a key while a store that may hold the subject has not answered. On the host, no control plane and no configured vertical means `unavailable`. On the control plane, "cannot tell" means "may hold", gated on the registered kinds.
- A store that cannot report its size is not recorded as `0`.

The rules are L1–L15 in [the RFC](../rfc/scope-stores.md) §10.7.

## Why

A deployed vertical's host has no control plane. The store path on main therefore reads its vertical from a host option, and the lifecycle stack reads its kind from another one that only tests set. Running that path hosted would mean writing the kind and the vertical into the vertical's environment next to the raw namespace. The vertical's code would stay in the trust path: it would hold a namespace that reaches every object, and it would state the identity its object names are built from. It would also need vertical routes that the router hop deletes again. The control plane already holds the authoritative records: the scope row it writes at provisioning and moves at bind, and the version manifest it accepted at push against `STORE_KINDS` (D-63). #2254 already drives the reserved operations from those records. This record makes that the decision. It names what is still open there — a name-only MAC with an unsigned audience, first-name memory only in a fixture, the platform transport not yet the default, the stale guard, an import check, and the snapshot's unreported replay — and orders the open items before #2210. The argument and the migration path are [the RFC](../rfc/scope-stores.md) §10.
