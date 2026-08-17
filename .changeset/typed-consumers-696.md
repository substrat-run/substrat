---
"@substrat-run/kernel": minor
---

Consumers can be typed against the engines a vertical composes.

Composing an engine by **calling** it is checked end to end. Composing it **by
event** was three plain strings and an `unknown`: `consumers` keyed by `string`,
`ConsumerHandler` handed a `DomainEvent` whose `payload` is `unknown`, and every
consumer hand-writing the shape it was given as an all-optional cast, because it
was guessing.

A module may now declare the engines it composes and get three things the
compiler enforces: **payloads typed** from the producer's own declaration, an
event type **no declared engine emits** rejected, and — via `consumersFor` — a
**half-handled completion group** rejected.

```ts
consumers: consumersFor<[ProtocolEvents]>()({
  'protocol.signed': async (ctx, event) => { … },
  'protocol.countersigned': async (ctx, event) => { … },
})
```

Omit the second and it does not compile: *Property `"protocol.countersigned"` is
missing*. That is the defect this exists for. Protocol events are named after the
signature **kind**, while the fact consumers want — the thing is finished — rides
on whoever signs **last**, so a two-party contract completes as a
*countersignature*. A vertical handling only `protocol.signed` left every
multi-party contract `pending` for ever while the engine held the document
`signed`. Nothing could say so: the key was a `string`.

`completionGroups` is what carries that. It names events that report the same
fact by different routes, and handling one member demands the rest.

**Additive (D-28).** The type parameter defaults to `[]`, and with no declared
engines `consumers` is exactly what it always was — `Record<string,
ConsumerHandler>` with an `unknown` payload. Every existing engine and vertical
compiles untouched; the full monorepo typecheck is unchanged.

**Deliberately vertical-facing only.** An engine consuming a sibling's event must
not reach for these types: R1 (star topology) forbids the import, and the
defensive parse is what lets a consumer ride out #128's dual-emit window.
`engine-invoicing` consuming `workorder.completed` through its own Zod view is
the correct shape and stays so. The asymmetry is the point — the same event is
typed for a vertical and parsed by an engine.

**The types are for the compiler, not the boundary.** A consumer still validates
with its own Zod parse. Importing a producer's validator is what turns version
skew into a crash instead of a tolerated absence.

Types only — no runtime change. `consumersFor` returns its argument.

Also: `packages/kernel` gained a `tsconfig.test.json`, because its `tsconfig.json`
includes only `src` and nothing in `test/` was typechecked at all. Turning that on
immediately surfaced a latent strictness error in `secret-box.test.ts`, fixed
here. The compile-time suite in `test/typed-consumers.test.ts` is the feature: a
type-level constraint fails *permissively*, so a decorative constraint is
indistinguishable from a working one unless something asserts it bites.
