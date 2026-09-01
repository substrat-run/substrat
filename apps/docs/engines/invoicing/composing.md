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
answers back through `invoicing/list` / `invoicing/get` — with
`invoicing.underlag-updated` as the notification that there is something new to read.

What that looks like:

| You want | Use |
|---|---|
| billing from a new domain | emit an event this engine already consumes — the `commerce.order-placed` path is the worked example. A genuinely new event *type* means adding its consumer to `invoicingModule`, in this engine; there is nothing to wire on your side |
| the basis on your own screens | `invoicing/list` / `invoicing/get` — never a read of this engine's tables |
| to know the moment it changes | consume `invoicing.underlag-updated`. It is a change notification (`{ underlagId, addedLines, source }`), not a snapshot: project it into a side table keyed by the underlag id, and read `invoicing/get` when you need the whole basis and its total |
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

::: info The seam is built; an accounting connector is not
The [connector seam](/connectors/) is real and running in production — `registerConnector`
binds a handler to an event type, the per-tenant connection store holds the credential sealed
at rest, delivery is at-least-once with retry and a dead letter, and a provider's write-back
comes home through the inbound authority seam. The [Scrive connector](/connectors/scrive) uses
all four.

What is missing is an **accounting** connector. Nothing consumes
`invoicing.underlag-exported` today — no Fortnox, no Visma, no Stripe — so the event fires,
carries its `Money`, and reaches no bookkeeping system until somebody writes the consumer. The
engine is pre-shaped for a connector it does not yet have, which is deliberate sequencing; it
is not an invitation to read `underlag-exported` as something already wired to Stripe.
:::

Note also what *doesn't* belong behind that seam: reskontra and avisering (ledger, dunning)
stay out of the engine entirely. The basis goes out; the bookkeeping stays in the bookkeeping
system.
