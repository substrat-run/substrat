---
"@substrat-run/engine-absence": minor
"@substrat-run/engine-booking": minor
"@substrat-run/engine-invites": minor
"@substrat-run/engine-invoicing": minor
"@substrat-run/engine-metering": minor
"@substrat-run/engine-protocol": minor
"@substrat-run/engine-workorder": minor
---

Every engine now publishes its event map, and its own emit sites are checked
against it.

The kernel half of this shipped in 0.0.1 of the typed consumer seam —
`EventContract`, `ConsumersOf`, `consumersFor` and the `completionGroups`
machinery that makes a half-handled completion group a compile error naming the
event that was missed. It had **zero implementors**: no engine exported a
contract, so the mechanism existed and was switched off everywhere. A vertical
writing `consumersFor<[…]>()` had nothing to put in the brackets.

All seven engines now export one, covering all 46 emit sites:

```ts
import { type ProtocolEvents } from '@substrat-run/engine-protocol';

consumers: consumersFor<[ProtocolEvents]>()({
  'protocol.signed': async (ctx, event) => { … },        // payload typed
  'protocol.countersigned': async (ctx, event) => { … }, // omit and it does not compile
})
```

**The emit side is welded to the map, which is the part that keeps it honest.**
`ctx.emit` takes `payload: unknown`, so an event map declared beside the emit
sites would be checked by nobody and could rot silently into a lie a vertical
compiles against. Each engine exports an `emit<Engine>Event` helper that pairs
the event type with its declared payload, and every emit site in that engine goes
through it. Three things are now compile errors inside the engine: an event type
the map does not declare, a payload field the map does not declare, and a
declared field the emit drops.

**`protocol.signed` and `protocol.countersigned` are two payload types, not
one.** They share a named `ProtocolSignatureBase`, and `signedBy` genuinely
differs — on the countersignature it is re-pointed at the primary signatory and
is nullable, while the party who just signed arrives in `countersignedBy`. A
shared type would hide exactly the confusion the split exists to prevent.

**engine-absence turned out to have the same defect shape, unfiled.**
`cancelAbsence` and `expireStaleRequests` both write `status = 'cancelled'` and
emit *different* event types — `absence.cancelled` and `absence.expired`. One
fact, two routes. It is the more dangerous of the two, because the second route
has no caller: a date-triggered sweep. A consumer handling `absence.cancelled`
looks correct in every hand-written test and strands every auto-expired request
in production, where the sweep is the only thing that emits. That pair is now a
declared completion group.

The other five engines declare **no** completion group, and each says why in its
`events.ts`. A group is for events reporting one fact by different routes;
booking's four terminal transitions share a consequence but are four different
facts, and grouping them would force three no-op handlers on every reader to buy
nothing. The absence is a decision, not an omission.

**Additive, and vertical-facing only.** Nothing existing had to move: an engine
consuming a sibling's event keeps `ConsumerHandler` and its own Zod view, because
R1 (star topology) forbids the import and the defensive parse is what lets it
ride out #128's dual-emit window. `engine-invoicing` consuming
`workorder.completed` is unchanged, and its suite is what says that must keep
compiling. The asymmetry is the point — the same event is typed for a vertical
and parsed by an engine.

**Types only, no runtime change.** `emit<Engine>Event` forwards to `ctx.emit`
unchanged; the runtime contract is still the fat payload and the consumer's own
Zod parse.

Each engine gains a `test/events.test.ts` that is the feature rather than a test
of it. A type-level constraint fails *permissively*, so a decorative constraint
is indistinguishable from a working one if you only compile the happy path: every
`@ts-expect-error` is load-bearing in the inverted direction, and each negative
has a positive twin through the same path, because "wrong shape is rejected" and
"right shape is accepted" both pass against a deleted mechanism.
