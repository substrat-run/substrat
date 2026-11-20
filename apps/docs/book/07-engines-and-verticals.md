# 7. Engines, verticals, composition

Chapter 1 named the three layers. This chapter is the middle and top ones in working
detail: what belongs in an engine, what belongs in a vertical, and how they cooperate
inside one scope. The other boundary, between apps that each own a scope, changes the
transaction and the identity, and it is chapter 8.

## An engine is an invariant with no vocabulary

There are nine in the repository: work orders, invoicing, booking, protocols, invites,
metering, absence, notifications and assistant, the last two the newest. Each engine is
headless: the vertical supplies the screens and the words people read.

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

The repo carries eight demo verticals, one of them a plugin of another (chapter 8).
Two of them are the reference implementations. They answer different questions, and they
are references *because they are used*. A demo nobody runs rots, however complete it looks.

- **`demos/todo`: the shape.** A record app built forward from its declared model, with
  per-list sharing by email, including with someone who has not joined yet, revoke, and a
  React app that tells a 403 from an empty list. It is also the app a plugin takes its
  people from (chapter 8). It has **no engine at all**. Not every vertical needs one, and pretending otherwise leads to
  engines that exist to be composed rather than to hold an invariant. It is what a scaffolded
  project's docs point at.
- **`demos/ticket0`: a deployed vertical.** A support desk that runs in production. It composes
  the metering engine by call, runs sandbox-clean on the hosted runtime, sends and receives mail
  through a relay, answers with a model around its operations (chapter 4), and ships through a
  CI push. It is the one to read for how a real vertical meets the platform.

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

### By call

Work orders, protocols, booking, metering, notifications and assistant use this shape.
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

## Notifications: an occasion becomes a durable send

Notifications is a useful example of composition by call. The vertical knows **why**
someone should hear something: a repair was assigned, a booking moved, a document needs
attention. The engine knows how to apply preferences and record delivery. The platform
knows how to send email.

<CommunicationFlow kind="notifications" />

The vertical calls `notify(ctx, …)` with a topic, recipients, a template and a
`dedupeKey` naming the occasion. From an event consumer, use the event id. The engine
records one delivery per occasion, topic, person and channel, applies mutes unless the
topic is required, and renders the vertical's words. A missing template variable throws
and rolls back the transaction. HTML variables are escaped.

Each send is a transactional email intent. A rollback leaves nothing to send; a commit
leaves durable work for the platform. The outcome returns as `email.sent`, `email.refused`
or `email.dead-lettered`, and the engine settles its delivery record from those events.
The vertical needs the platform's `emailSender` grant: without it, a recorded request
later settles refused. A configured MailSender can route through the tenant's mailbox.

The dedupe guarantee covers the engine's delivery rows. **Email transport is still
at-least-once**: if the provider accepts a message and recording that outcome fails,
a later attempt can send it again. This is the transaction boundary from chapter 5
made visible in a feature people use.

A person can take any topic that is not required as a **daily digest** instead of one
mail per occasion. The engine holds each rendered message, records its delivery as skipped
with the reason `digest`, and a schedule sends each person one mail of everything held for
them once their oldest held message is a day old: oldest first, at most fifty per mail, each
person on their own clock. It composes no English of its own. A digest of one message is that
message, and a digest of several puts each under its own subject. A mute still wins, at hold
time and again at send time.

That schedule meets a limit from chapter 5 head-on: a scope may hold only so many platform
requests waiting for the drain. So a pass sends to at most the room left, and keeps a
reserve for mail that must not wait. A backlog drains across passes instead of meeting the
cap.

The engine is published to npm and used by Handlebar. Email is still its only channel. The
[notifications reference](/engines/notifications/) has the calling shape and prerequisites.

## Assistant: the conversation record and the run are separate

The newest engine is **assistant**. It owns
threads, an append-only numbered conversation log, a lease allowing one run to write,
and the state of tool calls and approvals. A host owns the model loop and the tools.

That split makes the difficult part easier to reason about. Calling a model may be slow
and involve a network; chapter 4's scope transaction is the wrong place to wait for it.
The host makes short calls into the engine to record progress, then does the slow work
outside. The numbered log lets a disconnected client resume after its last event.

<CommunicationFlow kind="assistant" />

A person holding `assistant:use` starts a turn. The host uses `assistant:run` to take
the run lease and append assistant events. That key belongs to a system principal and
is refused in human roles and entity-grant shapes. A replaced run cannot keep writing;
every assistant-side write checks its lease. Another person's thread reads as nonexistent unless the
caller has the separate audit permission, which widens reads only.

For a tool call gated on approval, the request binds the approver, thread, call, step,
operation, exact input, deployed version, expiry and one-time value into a digest.
The person approves what they were shown. Before executing, the host calls
`claimExecution` with the operation, version and input it is about to use. Changed input,
a changed deploy, an expired approval or an already claimed call is refused.

This is a **single claim to execute**, not a transaction covering any external tool.
If a host crashes after claiming and before recording the result, the engine cannot
prove whether an external effect happened. Host integration must account for that
failure boundary. The assistant's approval also does not supply permission to an
unrelated app: a tool's target still has to authorize the operation it receives.

The status matters as much as the design. The engine is published to npm, and its first
user is the platform itself: the builder studio keeps every turn of a project in an
assistant thread, so a failed, stopped or unwatched turn leaves a record rather than a log
line. **No demo vertical composes it yet.** The screen half exists separately as
`<sub-assistant>` (chapter 9), which draws a conversation from any source with the right
shape. There are no branches, human participants, support handoff or memory yet. See the [assistant reference](/engines/assistant/) for the implemented
contract.

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

**Next:** [Apps made of other apps →](/book/08-apps-made-of-apps)
