---
'@substrat-run/contracts': minor
'@substrat-run/model-emit': minor
'@substrat-run/engine-workorder': minor
---

An entity's state machine is declared in the model (#844).

Six entities across four engines and two demos carry a `status` enum, and every one of
them described its transitions a second time — as hand-written guards in operation bodies,
held to the enum by nothing. `engine-workorder` restated the machine at six call sites;
`engine-booking` does not even hold the state *set* in one place, writing its seven values
out twice as two independent `z.enum` literals.

`defineLifecycles(entities, operations)` is that machine, declared once. The compiler
checks it against both things it names: a state the column cannot hold, a value the column
*can* hold with no state declared for it, an edge to nowhere, or an operation the module
does not declare are all refused. `assertTransition` replaces the hand-written guards and
throws the platform's own `conflict` with `reason: 'invalid_transition'`.

**What it deliberately cannot say.** No actions, no effects, no `context`, no parallel
regions, no timers, no expression language. An edge names the operation that performs it
and stops; the operation keeps its body. Durable execution stays where it is. Guards stay
in the manifest where K-38 put them — every edge names its operation, so the emitters
*join* guards onto edges rather than making anyone declare them twice.

Two things this unblocks. `extensible` is K-17's `extensibleStates`, which kernel-design
§7.5 has specified since July while `substates` appeared in zero `.ts` files — there was no
state-machine declaration for the mark to live on. And a widened state machine now lands in
a reviewed artifact: `pnpm lint:model` emits the machine into `model.json` (now including
`engines/*` that opt in via `src/model.ts`), and CI re-emits with `--check`, so a
redirected edge has to appear in a PR diff the way a widened role already does.

`model-emit` gains `emitXState`, a one-way render to an XState v5 config — for diagrams,
and as a test oracle, with `xstate` never leaving devDependencies.

`engines/workorder` is the adopter, behaviour unchanged. Booking, protocol, invoicing,
manyfold and shop are the queue.

This **reverses a published position** (K-40): `apps/docs/concepts/model.md` listed state
machines under *Prose* and said *"if you find yourself inventing a way to declare a state
transition, the boundary has slipped."* The boundary had not been holding — it was being
redrawn at every call site.
