---
id: K-49
date: 2026-10-12
layer: kernel
title: "A scope store is a platform-run object per scope, reached by its own door"
status: accepted
aliases: []
amends: []
tracking: ["#2207"]
---

# K-49 — A scope store is a platform-run object per scope, reached by its own door

**A scope store is a platform-run object, one per (tenant, vertical, scope, binding), and the vertical reaches it through `getScopeStore`.** The vertical declares `runtimeNeeds.scopeStores: [{ binding, kind }]`. `binding` is the SCREAMING_SNAKE name `tenantStoreNeed` already uses. `kind` is a literal union starting at `graph`, with no default. The platform runs the kind's script. The vertical does not. This record covers scope-grain stores: a kind declares its grain, and tenant-level store instances are a proposed alternative in `docs/rfc/store-instances.md` ([#2303](https://github.com/substrat-run/substrat/pull/2303)).

`getScopeStore(principal, tenantId, scopeId, binding)` returns a `StoreStub<Catalog>` with `tenantId`, `scopeId`, `subjectKind` and `invoke(operation, input)`. It does not take `InvokeOptions`; passing them is an error. `ScopeStubOptions` stays observers and carries no authority, which is why this is a door and not a field on `getScope`. The door checks the (tenant, scope) pair against the directory as `getScope` checks it (K-3), and that the binding is declared. It does not check a permission. The operation that calls does. An undeclared binding is refused. The platform builds the object name `<tenantId>/<vertical slug>/<scopeId>/<binding>` and is the only code that does. The vertical names a binding, not an object. The vertical's worker holds neither the store namespace nor the signing key. A call leaves as `fetch` of `store.substrat.internal`. The router, identified by the `OUTBOUND_POLICY` it set, signs the name and addresses the store script. A direct binding remains for local development and tests and is not an isolation boundary.

The wire is one envelope over the object's `fetch`: `{ operation, input }` in, `{ result }` or `{ error: { code, status, body } }` out. `StoreError` extends `SubstratError` with a closed code taken from the status; the store's own code and body ride in extensions. Names under `substrat.*` are reserved. The store accepts them only for the platform's signature. The vertical's stub does not send them. The platform calls `substrat.export`, `substrat.import`, `substrat.size`, `substrat.wipe` and `substrat.erase`. Export and import speak `scopeDumpTable`. `substrat.erase` takes `{ subjectId }` and is the kind's answer to subject erasure ([#2068](https://github.com/substrat-run/substrat/issues/2068), [D-45](./D-045-subject-erasure-is-scoped-to-the-stores-that-exist-the-spine.md)). A hosted kind implements it before it stores tenant data. The store is meant to remember the first name it accepts and refuse a later name; the spike does not yet show this. It does not run the kernel and does not call `ctx.check`. After a restore and after a snapshot, the platform runs `substrat.erase` again for every subject whose key row has `shredded_at` set. The unread backup file is the remaining limit. The host records the call on the request already open — binding, operation name, outcome, duration, not the input — without the vertical passing an observer. A call with no request is not logged. An operation name is a fixed label of at most 64 characters.

## Why

On a script two callers share, the caller who chooses the name addresses the other caller's object. The platform hop is what stops one tenant of a vertical addressing another: the signer is not in the vertical's worker. The spike's signature check did not bind the name to the object addressed. Remembering the first name is the intended control and is not yet exercised. Local miniflare showed the cross-script binding, the envelope, SQLite across a restart, and the same envelope for the operations the Python object implemented (`size` and `wipe`; export and import were not in that probe). It did not show a dispatch-namespace upload. The argument is [the RFC](../rfc/scope-stores.md). Registration, pinning and the one script per (kind, vertical) are [D-63](./D-063-a-store-kind-is-platform-code-registered-and-pinned-like-a-connector.md).
