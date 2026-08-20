# Lifecycles

An entity with a `status` column has a state machine. Before #844 that machine was written
down twice: once as the column's enum, and once as guards scattered through the operations
that move it.

```ts
// the enum, in entities.ts
status: z.enum(['planned', 'in_progress', 'completed', 'closed']),

// the machine, in index.ts — six call sites, held to that enum by nothing
requireStatus(row, 'planned', 'in_progress');
```

A **lifecycle** is that machine, declared once, beside the entities and operations it
already draws on.

```ts
import { defineLifecycles } from '@substrat-run/contracts';

export const workorderLifecycles = defineLifecycles(
  workorderEntities,
  workorderOperations,
)({
  workorder: {
    field: 'status',
    initial: 'planned',
    states: {
      planned: {
        on: { 'workorder/start': 'in_progress' },
        allow: ['workorder/assign', 'workorder/report-time', 'workorder/report-material'],
      },
      in_progress: {
        on: { 'workorder/complete': 'completed' },
        allow: ['workorder/report-time', 'workorder/report-material'],
        extensible: true,
      },
      completed: { on: { 'workorder/close': 'closed' } },
      closed: { terminal: true },
    },
  },
});
```

## `on` and `allow` are different things

`on` is an **edge**: the operation moves the entity to the named state.

`allow` is a **precondition**: the operation is legal in this state and changes nothing.

The distinction is not cosmetic, and it came from counting. Of the nine `requireState` call
sites in the booking engine, several gate operations that move no state at all — attaching
a note to a reservation checks that it is `held` or `confirmed` and leaves it exactly where
it was. A format with only edges would have described the majority of those guards as
transitions, and the emitted diagram would have grown a self-loop for every note anyone can
write.

**Absence means "not governed", never "forbidden".** `workorder/get` appears nowhere above
because no state gates a read. A lifecycle describes which mutations a state admits; an
operation it has never heard of is simply not its business.

## What the compiler checks

The declaration is checked against the two things it names, which is the whole reason it is
TypeScript rather than a schema file:

| You write | It is checked against |
|---|---|
| `field: 'status'` | the entity's own fields |
| a state name | the values that field can hold |
| `initial` | the declared states |
| an edge target | the declared states |
| an operation id | the module's declared operations |

Two of those bite in both directions. A state the column cannot hold is refused — and so is
a value the column *can* hold that the machine has never heard of, which is where an entity
goes to get stuck. Add a fifth value to the enum and forget the machine, and the build
fails.

::: tip Why one check runs at runtime
A `states` object carrying a key the enum does not have compiles clean however the
constraint is written — TypeScript applies no excess-property check when a value satisfies a
generic constraint. That check therefore runs at module load, where it can actually bite. A
check that reads like it works and does not is worse than an absent one.
:::

## What a lifecycle cannot say {#what-a-lifecycle-cannot-say}

The omissions are the design. There are no actions, no effects, no `context`, no parallel
regions, no timers and no expression language.

An edge names the operation that performs it and stops. The operation keeps its body, its
permission check, its writes and its events. The moment an edge can carry a condition, this
is BPMN in TypeScript — [the tarpit](/guide/comparisons) the platform named in the same
breath as adopting durable execution.

**Durable execution is a separate concern.** Retries, sleeps and fan-out are the outbox and
the sweeper, not this. A lifecycle says which states exist and which operation moves between
them. It never says *when*, and it never runs anything.

**Guards are not declared here either.** A guard is wired in the manifest as
`{ before, predicate, config }` and evaluated by the kernel inside the guarded operation's
own transaction. Every edge names its operation, so a guard on the operation already *is* a
guard on the edge — the emitters join the two rather than making anyone write it twice.

## Substates

A state marked `extensible: true` admits vertical substates: `in_progress` refines into
`awaiting_parts` or `pending_customer_approval` without the engine learning either word.
Transitions *within* an engine state are the vertical's; transitions *between* engine states
stay the engine's, so no substate path can skip `completed`.

An invariant-bearing state declares nothing. `completed` and `closed` carry billing
consequences, and the absence of the flag is how they say so.

## What it is used for

**Enforcement.** `assertTransition` replaces every hand-written guard and throws the
platform's own `conflict` with `reason: 'invalid_transition'` — which is also how two demos
that were throwing a bare `Error`, and returning a 500 where every engine returns a 409,
came back onto the contract.

**Review.** `pnpm lint:model` re-emits the machine into `model.json`, and CI re-emits with
`--check`. A redirected edge or a state that stops admitting substates has to appear in a PR
diff, the same way [`lint:permissions`](/concepts/permissions) makes a widened role appear
in one. Widening a state machine is no less consequential than widening a role, and until
now it was a one-line change to an `if`.

**Derivation.** The machine emits to an [XState v5](https://stately.ai/docs) config —
states, edges, nested substates, `type: 'final'`, and guards joined in from the manifest.
That is a one-way emit for diagrams and for a test oracle: XState's `transition()` is a pure
function, so it can confirm the emitted machine and the engine's own guard agree on every
state/event pair without XState ever leaving devDependencies.

::: warning The emitted machine is not a source
Editing it in a visual editor and reading it back would make that editor a second authoring
surface. Anything checked in belongs behind a `--check` re-emit, so an edit goes red rather
than becoming the truth.
:::

## Adopting one

1. Declare it in a file that imports the entities and the operations — not in `entities.ts`,
   which the operations already import and which would close the loop into a cycle.
2. Replace each hand-written guard with a call naming the **verb** rather than re-deriving
   the set of states that permits it.
3. Export an emitted model so `lint:model` picks it up:

```ts
export const workorderModel = emitModel(workorderEntities, { lifecycles: workorderLifecycles });
```

Adopted: `engine-workorder`, `engine-booking`, `engine-invoicing`, `demos/manyfold`,
`demos/shop`.

Booking is worth reading as the harder example: seven states, three operations that are
`allow` rather than edges, a state reachable by lapse rather than by transition, and a
transition performed by composition. It needed no addition to the format.

Two are deliberately not adopted:

- **`engine-protocol`** gates content mutation, not just transitions, and each of its
  refusals carries its own reason — `content_frozen`, `wrong_status`, `already_voided`.
  Routing those through `assertTransition` would flatten three useful answers into one
  vaguer one. It needs the `transitionFor` treatment below, applied case by case.
- **`engine-absence`** has a machine (`requested → approved | rejected | cancelled`) and no
  entity to hang it on: its registry declares `absence_leave_types` and nothing else, so
  `absence_requests` is not a declared entity. Registering it comes first.

## When the module has a better reason than "invalid transition"

`assertTransition` is the default. Where a module's own refusal says more, ask the
declaration the *legality* question with `transitionFor` and keep your own reason:

```ts
if (!transitionFor(invoicingLifecycles.underlag, underlag.status, 'invoicing/export')) {
  throw conflict('immutable_after_export', `underlag ${underlag.number} is '${underlag.status}' …`);
}
```

The declaration stays load-bearing — it is still the single description of what is legal —
and the caller still hears the invariant that actually stopped them.
