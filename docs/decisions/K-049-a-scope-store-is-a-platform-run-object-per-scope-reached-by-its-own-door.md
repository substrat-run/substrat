---
id: K-49
date: 2026-10-12
layer: kernel
title: "A scope store is a platform-run object per scope, reached by its own door"
status: proposed
aliases: []
amends: []
twin: D-63
tracking: ["#2207"]
---

# K-49 — A scope store is a platform-run object per scope, reached by its own door

**A scope store is a platform-run object, one per (tenant, vertical, scope, binding), and the vertical reaches it through `getScopeStore`.** The vertical declares `runtimeNeeds.scopeStores: [{ binding, kind }]`. `binding` is the SCREAMING_SNAKE name `tenantStoreNeed` already uses. `kind` is a literal union starting at `ontomate`, with no default. The platform runs the kind's script. The vertical does not.

`getScopeStore(principal, tenantId, scopeId, binding)` returns a `StoreStub<Catalog>` with `tenantId`, `scopeId`, `subjectKind` and `invoke(operation, input)`. It does not take `InvokeOptions`; passing them is an error. `ScopeStubOptions` stays observers and carries no authority, which is why this is a door and not a field on `getScope`. The (tenant, scope) pair is checked against the directory as `getScope` checks it (K-3). An undeclared binding is refused. The host builds the object name `<tenantId>/<vertical slug>/<scopeId>/<binding>` and is the only code that does. The vertical names a binding, not an object.

The wire is one envelope over the object's `fetch`: `{ operation, input }` in, `{ result }` or `{ error: { code, status, body } }` out. `StoreError` extends `SubstratError` with a closed code taken from the status; the store's own code and body ride in extensions. Names under `substrat.*` are reserved. The vertical's stub refuses them. The platform calls `substrat.export`, `substrat.import`, `substrat.size`, `substrat.wipe` and `substrat.erase`. Export and import speak `scopeDumpTable`. `substrat.erase` is the kind's answer to subject erasure ([#2068](https://github.com/substrat-run/substrat/issues/2068), [D-45](./D-045-subject-erasure-is-scoped-to-the-stores-that-exist-the-spine.md)); a hosted kind implements it before it stores tenant data, and what it deletes is specified with that issue. The object does not run the kernel and does not call `ctx.check`. The operation that called already did. The host records the call on the invocation already open: binding, operation name, outcome, duration. Not the input.

## Why

[spikes/scope-store-binding](../../spikes/scope-store-binding/FINDINGS.md). On a script two callers share, the caller who chooses the name addresses the other caller's object. One script per vertical stops that and does not stop one tenant of the same vertical addressing another, which is why the host owns the name. A signature over that name, under a key the vertical does not hold, refuses a caller who can see the binding anyway. Local miniflare showed the cross-script binding, the envelope, SQLite across a restart, and the same envelope in a Python Durable Object. It did not show a dispatch-namespace upload. The argument is [the RFC](../rfc/scope-stores.md). Registration, pinning and the isolate split are [D-63](./D-063-a-store-kind-is-platform-code-registered-and-pinned-like-a-connector.md).
