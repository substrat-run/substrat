---
id: K-50
date: 2026-10-13
layer: kernel
title: "A hosted scope store's lifecycle is driven by the platform, from its own record"
status: accepted
aliases: []
amends: ["K-49"]
tracking: ["#2207", "#2210", "#2211"]
---

# K-50 — A hosted scope store's lifecycle is driven by the platform, from its own record

**In a hosted deployment the control plane drives everything the platform does to a scope's stores.** That covers export, snapshot, fork, restore, import, reap and wipe, subject erasure, the size meter, and replaying erasures after a copy. The control plane reaches the store script through the dispatch namespace. The vertical's worker does not drive any of it, and `CloudflareScopeHost` does not drive it from ambient `SUBSTRAT_STORE_*` bindings. The vertical comes from the directory's scope record. The version is one resolution that the router and the control plane share: the version the scope's deployment runs. That is the serving pointer's version only when the pointer's ref is the scope's own `serving_ref`; the bound version when the scope has no `serving_ref`; and otherwise unknown, which fails closed. The bindings and kinds come from that version's reviewed manifest record. Nothing about stores is wired into the vertical's worker, so a deployed vertical with no control plane needs no record of its own. The vertical never holds a raw store namespace. It keeps one door, `getScopeStore`, and a call through it takes the router hop K-49 describes. The vertical's `/internal/scope-store-*` routes are not part of a hosted release. The host-side lifecycle stays for the pure adapter and for dev, where the host process is the platform.

The owner chose this direction and ratified it with K-49 on 2026-10-15.

The interim injection of a `SUBSTRAT_STORE_<BINDING>` `durable_object_namespace` into the serving upload is removed before the first kind is registered (#2210). The guard becomes "a hosted serving upload carries no `SUBSTRAT_STORE_*` binding, whatever is registered". The prefix is reserved: a vertical-declared name that starts with it is refused at push and at upload. Both signers, the router for a vertical's call and the control plane for the reserved operations, sign one envelope. Its MAC covers the version, the audience (`caller` or `platform`), the object name, the operation, a digest of the body, the issue time and a nonce. The store checks all of them, and the first name it accepted, before the kind's code runs. Those checks run in a store entry module the platform supplies, which the kind cannot replace. The kind supplies only the class behind it. The kind's class shares the object's storage, so whether it can rewrite the remembered name is held by the registration review until a platform mechanism isolates it (RFC Q3). Signing keys are scoped per store script and per audience. Store script names are injective, and their name space is reserved against vertical script names.

The lifecycle fails closed:

- A scope is unrouted, then its stores are wiped, then its storage is deleted. A failed or undecidable wipe stops the delete.
- No operation (push, bind, promote, rollback, re-upload) changes a scope's resolved set of (binding, kind) while objects of the old set may exist, unless the old binding stays reachable. The recommended answer is that the lifecycle reaches the vertical-wide union of every (binding, kind) any version has declared (RFC Q5).
- A restore imports only bindings the destination declares with the same kind. It then re-erases the union of the target's and the source's tombstoned subjects. An unknown source never refuses the restore: it is reported as `storeErasureIncomplete` with `storeErasureSourceUnknown`.
- Subject erasure never destroys a key while a store that may hold the subject has not answered. On the host, no control plane and no configured vertical means `unavailable` (503). On the control plane, "cannot tell" means "may hold", gated on the registered kinds. A bind that races an erase either sees it or fails.
- A store that cannot report its size is not recorded as `0`.

The rules are L1–L20 in [the RFC](../rfc/scope-stores.md) §10.7.

## Why

A deployed vertical's host has no control plane. The store path on main therefore reads its vertical from a host option, and the lifecycle stack reads its kind from another one that only tests set. Running that path hosted would mean writing the kind and the vertical into the vertical's environment next to the raw namespace. The vertical's code would stay in the trust path: it would hold a namespace that reaches every object, and it would state the identity its object names are built from. It would also need vertical routes that the router hop deletes again. The control plane already holds the authoritative records: the scope row it writes at provisioning and moves at bind, and the version manifest it accepted at push against `STORE_KINDS` (D-63). #2254 already drives the reserved operations from those records. This record makes that the decision. It names what is still open there and orders it before #2210:

- the router and the control plane resolving different versions, the router reading a serving pointer for a scope that does not run it, and the sweeper reading a null version id as no stores;
- a name-only MAC with an unsigned audience, and first-name memory only in a fixture;
- the platform transport not yet the default, and the stale guard with no reserved prefix;
- wipe and erase failing open on what they cannot resolve;
- no unroute before wipe;
- bindings a later version drops;
- store script names that are not yet shown injective.

The import check ahead of the restore and the snapshot's replay report are already done on #2254. The argument and the migration path are [the RFC](../rfc/scope-stores.md) §10.
