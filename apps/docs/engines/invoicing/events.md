# Events

This engine is mostly a **sink**. Lines arrive by event, never by call — which is why the
consumed side is the more interesting half.

```ts
events: {
  emits: [
    { type: 'invoicing.underlag-updated', schemaVersion: 1 },
    { type: 'invoicing.underlag-exported', schemaVersion: 2 },
  ],
  consumes: [
    { type: 'workorder.completed', schemaVersion: 1 },   // the original producer
    { type: 'commerce.order-placed', schemaVersion: 1 }, // added for the shop vertical
  ],
}
```

## Consumed

| Event | From | Handler behaviour |
|---|---|---|
| `workorder.completed` | the work-order engine | append lines, `source_type: 'workorder'` |
| `commerce.order-placed` | the shop vertical | append lines, `source_type: 'order'` — **only if `paymentMethod === 'invoice'`** |

Each has its **own** consumer with its **own** Zod view of the payload. Zero imports from
either producer — the engine has never heard of the packages that emit these.

Adding the second was a **purely additive change**: a new `consumes` entry, a new parser, a
new handler. No migration, no permission, the `workorder.completed` path untouched. That's
engine reuse across verticals, demonstrated rather than asserted.

The mechanics — replay guard, find-or-create, dead-lettering — are in
[Domain model & invariants](./model#snapshot-not-join).

## Emitted

| Event | v | piiClass | Payload |
|---|---|---|---|
| `invoicing.underlag-updated` | 1 | none | `{ underlagId, addedLines, source: EntityRef }` |
| `invoicing.underlag-exported` | **2** | none | `{ underlagId, number, total: Money }` |

`invoicing.underlag-exported` is the natural hook for the next step in a vertical: an
accounting connector that turns the frozen basis into a real invoice. See
[Composing](./composing#reaching-the-outside-world).

## Versioning

::: warning `underlag-exported` is at schemaVersion 2 — a replace, not a dual-emit
v1 carried `total` as a bare amount string with no currency — an amount that isn't an amount,
on the one event an accounting connector consumes. v2 makes it `Money`. If you consume this
event, read `total.amount` and `total.currency` rather than the old string.

This is not an exception — it is the rule, and the reason generalises to **every** engine
here:

**Consumer dispatch keys on event `type` alone.** The `schemaVersion` in a manifest's
`consumes` is discarded at registration; the dispatch query is `WHERE o.type = ?`. So
emitting v1 and v2 together would deliver *both* to every consumer of the type — and for an
export event, that means a connector could invoice the same basis twice, silently.

A clean replace fails **loudly** instead: a v1 consumer's strict parse rejects v2 and
dead-letters, which is visible. Loud beats silent when the alternative is double-billing.
:::

The rest of the rule holds unchanged everywhere: payload fields are frozen once shipped, new
fields are optional and additive, and rename/remove/retype means a version bump. Only the
deprecation window is gone — a bump is a replace on every engine, not just this one, until
dispatch routes on `(type, schemaVersion)`. That is wanted and postponed, not abandoned:
[#128](https://github.com/substrat-run/substrat/issues/128) holds the scope.
