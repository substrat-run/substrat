# Composing & extending

## Using it as-is

```ts
host.registerModule(invoicingModule);
```

Then **emit the events it consumes** — that's the whole integration. There is no wiring step
between the work-order engine and this one, because there is no connection between them: one
emits, the kernel journals, this one consumes.

To make a vertical's own domain billable, emit a `commerce.order-placed`-shaped event from
your operation. You never import this engine to do it.

## Extending it

**By event, not by call** — and that is the shape, not a shortfall.

There are **no in-scope functions** ([surface](./surface#in-scope-functions)), because this
engine being the only writer of its rows is what makes `exported` immutable. So the
wrap-the-function pattern the by-call engines offer does not apply here: you cannot wrap
`export` in your own vocabulary, and you cannot export a basis and write to your own tables
in one transaction. You extend invoicing by changing **what you emit**, and you read its
answers back through `invoicing/list` / `invoicing/get` or by consuming
`invoicing.underlag-updated`.

What that looks like:

| You want | Use |
|---|---|
| billing from a new domain | emit an event; add a consumer upstream — the `commerce.order-placed` path is the worked example |
| the basis on your own screens | `invoicing/list` / `invoicing/get`, or consume `invoicing.underlag-updated` — never a read of this engine's tables |
| extra fields on an underlag | your own side table keyed by the underlag id — **never** a column upstream |
| to hide export from most roles | keep `invoicing:export` off the role; it's already a separate key |
| the engine off for a tenant | revoke the `invoicing` entitlement — but read the caveat in [surface](./surface#entitlement) first |

## Configuration

**There is none.** `ModuleRegistration` has five fields and none is config; there is no
`createInvoicingModule({...})` factory and no `config` field on the manifest. An engine cannot
be told anything at registration time.

*Configuration is dynamic; composition is code.*

The one behaviour you might reasonably want to configure — *"only invoice-payment orders
bill"* — is **hard-coded** in the `commerce.order-placed` consumer:

```ts
if (p.paymentMethod !== 'invoice') return;
```

A vertical that settles differently can't change that rule; it would emit a different event or
carry a different `paymentMethod`. Whether that belongs in the engine at all is a fair
question — it is a business decision living in shared machinery, which is exactly what the
engine/vertical line is supposed to keep out.

## Reaching the outside world

Nothing in this engine talks to anything external, and it never will: module code may not
`fetch`, and connectors handle the outside world.

**`invoicing.underlag-exported` is the seam.** Its consumer is by design an accounting
connector (Fortnox/Visma-class) that turns the frozen basis into a real invoice. That the
event exists, carries `Money`, and fires exactly once per export is the whole contract.

The immutability invariant exists *for* this seam: a connector must be able to trust that what
it read can't change underneath it, and that exporting twice is impossible.

### So how would Stripe attach?

Not to this engine, and the answer depends on who's paying whom:

| Case | Bucket | Where it lives |
|---|---|---|
| A tenant's customer pays a card/Swish charge | **connector** | the integrations hub — a capability tenants use |
| Substrat charges its own tenants | **adapter** | infrastructure the kernel consumes, swappable behind a pure interface |

Fortnox lands in *both* buckets depending on the same question: a connector when it's a
tenant's bookkeeping, an adapter when it's the platform's own invoicing rail.

A connector is a **fourth bucket** — not kernel, not engine, not vertical. It lives in the
integrations hub, and the hub itself is kernel-owned while the connectors in it are not. The
test that decides it: *effects on the outside world are connectors.*

::: warning Connectors are not built yet
The connector interface, connection store, token refresh, webhook ingress, and per-tenant
connection config are **planned, not implemented** — there is no connector code in the repo.
The `_substrat_outbox` is real and transactional, but it drains only to in-process consumers;
there is no external sink and `drained_at` is written nowhere.

Today, "export to Fortnox" in the demos is a **file-write stub**. This engine is pre-shaped
for a seam that doesn't have a floor under it yet — which is deliberate sequencing, but don't
read `underlag-exported` as something you can wire Stripe to this afternoon.
:::

Note also what *doesn't* belong behind that seam: reskontra and avisering (ledger, dunning)
stay out of the engine entirely. The basis goes out; the bookkeeping stays in the bookkeeping
system.
