# 7. Engines, verticals, composition

Chapter 1 named the three layers. This chapter is the middle and top ones in working
detail: what belongs in an engine, what belongs in a vertical, and the rules that keep
seven engines from becoming forty-two pairwise integrations.

## An engine is an invariant with no vocabulary

There are seven: work orders, invoicing, booking, protocols, invites, metering, absence.
Each one is headless. No screens, no words a user reads, no opinion about what you call
things.

What an engine owns is the set of statements that must never be false:

- a completed work order cannot return to scheduled;
- an exported invoice basis is immutable afterwards;
- a protocol entry is append-only;
- every mutation emits an event;
- every operation checks a permission.

The test for whether something belongs in an engine is not "is it reusable". It is: **would
it be a bug in any vertical for this to be violated?** Pricing is not that — one customer
rounds differently. State transitions are.

## A vertical is everything a person touches

Vocabulary, roles, pricing, screens, workflow, the shape of the API its own app calls. A
vertical composes engines the way an application composes libraries, except the library's
invariants are enforced from below rather than trusted.

The repo carries nine demo verticals, and two are the reference implementations because
they are different shapes:

- **`demos/callout`** — an engine-composing workflow: a vertical that orchestrates the
  work-order engine inside its own operations.
- **`demos/todo`** — a record app with user-initiated sharing and **no engine at all**. Not
  every vertical needs one, and pretending otherwise leads to engines that exist to be
  composed rather than to hold an invariant.

## Star topology: engines never call each other

<BlastRadius />

No engine imports a sibling. None. Composition happens through three kernel-mediated
channels:

1. **Opaque refs** — an attachment contract binds to `(entityType, entityId)` without
   knowing what the entity is.
2. **Events** — an engine reacts to another's schema-versioned events. The invoicing engine
   consumes `workorder.completed` *and* `commerce.order-placed` — two different domains —
   without importing a single type from either producer.
3. **Vertical-owned orchestration** — a synchronous flow needing two engines is wired in the
   vertical, where the glue is visible and editable.

The arithmetic is the argument: compatibility stays at *N* kernel contracts instead of *N²*
engine pairs, and each engine versions independently.

There is a corollary test worth remembering: **if two engines need chatty synchronous
communication, they are one engine drawn wrong.** That is why "work orders + time
reporting" is one engine rather than two that call each other constantly.

And if a vertical finds it must *fork* an engine, the engine drew its line wrong. That is a
bug report about the engine, not a fork to maintain.

## By call, or by event — and it is a fact about the exports

An engine is composed in one of two modes, and which one it is determines its whole shape.

### By call (work orders, protocols, booking)

Operations are thin: the permission check, plus one exported in-scope function. All the
logic lives in composable exports, so a vertical wraps them inside its **own** transaction:

```ts
// in the vertical's operation, same transaction, own permission check
assertAllowed(await ctx.check('fsm:complete-job'));
await ctx.atomic(() => completeWorkOrder(ctx, { orderId, billable }));
await ctx.sql.exec('UPDATE fsm_jobs SET closed_at = ? WHERE order_id = ?', [ctx.now(), orderId]);
```

One transaction, both writes, atomic. The vertical extends by composition and never by
forking. Note the `ctx.atomic` from chapter 4 — it is what makes catching that engine call
safe.

### By event (invoicing)

The vertical **emits**, the engine consumes, and the vertical reads results back through
the engine's own operations or by consuming its events into a side table keyed by the
engine's id.

There are deliberately **no in-scope exports**. That is not an omission — the engine being
the only writer of its rows is what keeps immutable-after-export safe from a half-finished
caller. If a vertical could call in mid-flow, the invariant would depend on the caller
finishing.

Which mode an engine is, is a fact about its exports. State it in the engine's header, so
an absence reads as intent rather than as something nobody got round to.

## Another module's tables are private

Not "please don't" — a linted boundary with a reviewable escape hatch.

Engine data is reached through the engine's exported in-scope functions. The stable surface
is entity ids, `EntityRef`s, and event payloads. A vertical needing extra data on an engine
entity adds its **own side table keyed by the engine's id**, and never a column upstream.

One-time extraction handoffs — a genuine migration where the data must move once — use an
explicit `boundary-lint-allow R5` … `boundary-lint-end R5` block. That is a reviewable
escape hatch rather than an absent rule, which is the right shape: rules with no hatch grow
workarounds that are worse than the hatch.

## Engine surfaces evolve additively

Three rules, and one of them has teeth that surprise people.

**New operation inputs are optional, with behavior-preserving defaults.** Adding a required
input is a breaking change to every existing caller.

**Permission keys are never renamed.** A rename silently removes authority from everyone
who held the old key.

**Emitted event payload fields are frozen once shipped.** Rename, remove or retype means a
`schemaVersion` bump — and chapter 5 explains why a bump is a *replace* with no dual-emit
window available.

### The gate that makes a break red

There is one call site of every engine that used to be invisible to the compiler: the
scaffold template. It imports the engines, so it is a real call site — and nothing compiled
it, so a non-additive change could merge, release, and reach `npm create substrat` broken.

That is now closed. `tools/template-sync.mjs` materializes the template into
`packages/template-check`, a workspace member holding `workspace:*` links, so `typecheck`,
`test` and `boundary-lint` all reach it with no new command to remember. A non-additive
engine surface is now red **in its own PR**, against the workspace.

There is a second, separate gate — `pnpm lint:scaffold` — that runs the same scaffold
against the **published registry**, post-release and weekly, never on a PR. The distinction
is the whole point: between a merge that adds a surface and the release that publishes it,
the template legitimately runs ahead of npm. Being ahead of the registry is a pass on the
PR gate and a legitimate red on the release one.

## The runtime half: parse on the way out

A type-checked seam is not enough, because a vertical compiled against engine 0.3 and
*running* against 0.4 has no compiler in the room.

So a value crossing the engine seam is `.parse`d by the schema the engine publishes — on
the way **out** as well as in. And a read names its columns rather than using `SELECT *`,
which would pin the published shape to whatever the physical table currently holds.

Without this, the failure is not a throw. It is a field that moved, read as a different
field, rendering **wrong data on a screen**. Silently. That is why the parse is unconditional
including on bulk reads: dev-only validation is absent exactly where version skew lives.

Two helpers in `@substrat-run/contracts` do the work — `returns(schema, surface, value)` and
`columnsOf(schema)` — and an engine binds them to its own name in one line
(`engineSeam('engine-workorder')`). Every engine is converted, each with a `test/seam.test.ts`
that moves its tables underneath it and asserts a throw rather than wrong data.

The `SELECT *` half is mechanical: boundary-lint **R8** fires on a star read anywhere in an
engine's module code, with the same reviewable allow-block hatch for a maintenance read whose
row never leaves the engine. The `returns()` half is still convention — proving a
row-returning export is parsed needs a type checker the linter deliberately does not carry —
so a new engine is expected to do that half itself. Said plainly rather than implied.

## Declaring, not writing

A vertical increasingly does not hand-write its manifest. It declares entities, operations
and permissions once in a typed module, and the manifest's entity fragments, permission
list, event list and DDL are **derived** from that declaration.

The compiler checks the joins: a parent naming no entity, an `entityIdFrom` naming no output
field, a payload carrying an `erasable` field are compile errors rather than runtime
surprises. `pnpm lint:model --check` gates the emitted `model.json` the way
`lint:permissions` gates the permission surface.

The browser client is generated from the same declaration — entity interfaces, paths,
methods, request bodies, the paged link walk. What stays hand-written beside it is only what
the model does not declare: which principal a request is made as, and the error envelope the
vertical chose in its own `app.onError`.

[The model](/concepts/model) is that story in full, and it is the page to read before
building anything.

---

**Next:** [The life of one deploy →](/book/08-one-deploy)
