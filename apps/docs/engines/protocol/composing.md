---
description: "Registering the protocol engine and supplying the templates it deliberately ships none of, wrapping instantiation in your own operations, and the completion guard in both its forms."
---

# Composing & extending

## Using it as-is

```ts
host.registerModule(protocolModule);
```

Then supply template content — the engine ships none.

## Wrapping it with vertical logic

The registered operations are default bindings over exported in-scope functions. Your own
operations call them in the same transaction, and you own the permission check:

```ts
import { instantiateProtocol, PROTOCOL_PERM } from '@substrat-run/engine-protocol';

host.defineOperation('cykel/start-condition-report', async (ctx, input) => {
  assertAllowed(await ctx.check(PROTOCOL_PERM.create));
  return instantiateProtocol(ctx, {
    templateKey: 'condition-report',
    entity: input.bike, // any EntityRef — the vertical owns the vocabulary
  });
});
```

The vertical declares the `protocol → <parent>` entity relation in *its* manifest — the engine
can't know whether protocols hang off work orders, bikes, or apartments — and supplies the
template content.

## The completion guard — two forms

"Obligatorisk för status" (a work order can't complete until its protocol is signed) is the
canonical cross-engine requirement, and there are two ways to wire it.

### Composed, in code

```ts
import { requireSigned } from '@substrat-run/engine-protocol';

host.defineOperation('acme/workorder-complete', async (ctx, input) => {
  assertAllowed(await ctx.check(WORKORDER_PERM.complete));
  requireSigned(ctx, input.order, 'self-inspection-electrical'); // throws if not signed
  return completeWorkOrder(ctx, input);
});
```

The work-order engine knows nothing of protocols, the protocol engine checks its own tables,
and the *vertical* wires the two — star topology intact. The `requireSigned` call site **is**
the compliance gate.

### Declared, in the manifest

```ts
guards: [{
  before: 'bike-shop/close-repair',
  predicate: 'protocol/all-signed',
  config: { templateKey: 'condition-report', entityType: 'bike', entityIdFrom: 'bikeId' },
}]
```

Same rule, but it appears in the **reviewable manifest diff** — dropping a compliance gate
becomes visible rather than a deleted line in a handler.

Prefer the declarative form when the rule really is "this operation is blocked until X".
Prefer the composed form when the vertical needs to name a moment it actually owns — a bike
shop's *pickup*, where the customer accepts the report, is more than the engine's transition,
and a guard on `workorder/close` would describe it wrongly.

## Configuration

**There is none at registration time.** `ModuleRegistration` has five fields —
`manifest`, `migrations`, `operations`, `consumers`, `predicates` — and none is config. There
is no `createProtocolModule({...})` factory and no `config` field on the manifest.

*Configuration is dynamic; composition is code.*

This engine shows the two sanctioned alternatives better than any other:

| You want | Use |
|---|---|
| a parameterised rule | **`guards[].config`** — declared in the vertical's manifest, kernel-opaque, parsed by `allSignedGuardConfig`. Its `entityIdFrom` late-binds into your vocabulary. |
| tenant-specific content | **runtime data** — `defineTemplate` puts templates in the tenant's own scope. Which protocols exist is data, not config. |
| only part of the engine | `withdraws` in your manifest, then re-offer behind your own operation |
| different behaviour around a transition | your own operation calling the in-scope function |
| the engine off for a tenant | revoke the `protocol` entitlement |

The template mechanism is the lesson worth generalising: content that varies per tenant is
**data in the scope**, not options in a constructor. An engine with a `templates:` config
array would need a redeploy to add a checklist; `defineTemplate` needs an operation call.

### Adding data to a protocol

Never add a column upstream. A vertical needing extra fields adds **its own side table keyed
by the engine's instance id**. Another module's tables are private; the stable surface is
entity ids, `EntityRef`s, and event payloads.

## Reaching the outside world

Nothing in this engine talks to anything external, and it never will: module code may not
`fetch`, and connectors handle the outside world.

The external signing flow is split across that boundary deliberately:

1. Your vertical calls `requestSignatures(ctx, { instanceId, method: 'scrive', parties })`.
   That freezes the content, computes the hash **once**, writes a request row per party, and
   emits a fat `protocol.signatures-requested` carrying everything a connector needs to
   dispatch — the hash, the parties, the content ref. All inside your transaction.
2. An **executor** outside the scope picks that event off the outbox and makes the HTTP call.
   It holds platform authority, which module code must never have.
3. Days later the provider reports a signature, and something invokes
   `recordSignature(ctx, { requestId, signatory, signedAt, contentHash, evidenceRef })`.

::: info Step 3 has a caller now
Both kernel gaps this section used to name are closed, so all three steps run end to end:

- the **inbound authority seam** exists. `getConnectorScope(connectionId, scopeId)` opens a
  scope stub whose authority is the connection's own grants, narrowed by construction to that
  tenant and vertical — so a provider's callback acts *as the connection* rather than as a
  person it cannot name ([#97](https://github.com/substrat-run/substrat/issues/97)).
- the **ingress** exists, as a capability URL the platform mints per dispatch and mounts on
  the control plane, with a poll floor underneath it: no callback URL configured means
  reconciliation is poll-only, which is complete and merely slower
  ([#96](https://github.com/substrat-run/substrat/issues/96)).

The [Scrive connector](/connectors/scrive) is the worked example — `reconcileScriveDispatch`
reads the provider's result and calls step 3 across that seam. Two caveats travel with it,
both outside this engine: the consuming vertical must schedule the reconciliation poll, and
BankID-to-sign is off on the testbed account, so the real signing round-trip is still
unverified.

`recordSignature` remains reachable by **no human role** in any demo, which is the design and
not a gap: `protocol:record-signature` is a key a *connection* holds.
:::

A worked example of steps 1 and the shape of 3:
[Meridian's anställningsavtal](/verticals/meridian#a-document-the-anstallningsavtal).

### The shape to copy

The engine defines what evidence *is* and what must be true of it — the hash matches the
frozen content, the signatory matches the request, the timestamp is the provider's. A
connector supplies the evidence. What the engine does **not** do is pretend an asynchronous,
non-principal signature fits a synchronous, principal-shaped operation: that assumption is
what left the freeze window open, and the correction was a new noun (the signature request),
not a better comment.
