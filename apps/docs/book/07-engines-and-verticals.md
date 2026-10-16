# 7. Engines, verticals, composition

Chapter 1 named the three layers. This chapter is the middle and top ones in working
detail: what belongs in an engine, what belongs in a vertical, and how they cooperate.
There are two boundaries to keep in view: modules sharing one scope, and apps with
separate scopes. Crossing the second boundary changes the transaction and the identity.

## An engine is an invariant with no vocabulary

There are nine in the repository: work orders, invoicing, booking, protocols, invites,
metering, absence, notifications and assistant. Notifications arrived in the week of
5–11 October; assistant's first implementation landed on 15 October 2026. Those two
packages are not yet published to npm. Each engine is headless: the vertical supplies
the screens and the words people read.

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

The repo carries seven demo verticals. Two of them are the reference implementations. They
answer different questions, and they are references *because they are used*. A demo nobody
runs rots, however complete it looks.

- **`demos/todo`: the shape.** A record app built forward from its declared model, with
  per-list sharing by email, revoke, and a React app that tells a 403 from an empty list. It
  has **no engine at all**. Not every vertical needs one, and pretending otherwise leads to
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

## Between verticals: a call asks, an event announces

Imagine one tenant running a CRM and a board-room app. The board-room needs to show
current customer information, and to react when the CRM records a new customer. Both
apps belong to the same tenant, but each owns a separate scope database. Installing
them together does not create a shared transaction or grant access to each other's SQL.

There are two ways across that boundary:

| What the board-room needs | Mechanism | What it receives |
|---|---|---|
| An answer now: “show me this customer's current details” | A **peer call** from host code | The target operation's result, or its refusal |
| To request an operation from inside its own transaction | A **queued peer call**, written as a platform intent | A request id now; an outcome after delivery |
| To maintain its own view of facts the CRM publishes | An **event import** | Exported history, then subsequent events, from its saved position |

A call chooses an operation. An event announces a fact that has already committed.
Both use the platform's identity for an app. Neither makes the caller the signed-in
person, and neither lets two databases commit atomically.

### Follow one peer call

The board-room's server asks the CRM for `customer/get`. Three decisions happen in
different places, which is why “I declared the other app” is only part of the setup.

<CommunicationFlow kind="peer" />

First, the **caller** declares `substrat.calls: ['acme/crm']` in its package manifest.
This says where its host code intends to call. It grants nothing in the CRM.

Second, the **platform** identifies the caller from the dispatch and resolves a CRM
instance in the same tenant. It does not trust an identity or a tenant id supplied in
the request. With one eligible primary, active instance, the choice is automatic.
With several, a team admin must bind the target on the calling app's page. That choice
belongs to that particular caller instance. An unavailable bound target refuses;
the platform never silently substitutes another. Previews and forks cannot participate.

Third, the **target** declares that the board-room is a peer and may call that operation.
`peersDeclaredBy(crmOperations, { 'acme/board-room': ['customer/get'] })` derives the
permission keys from the operation declaration. The target seats those grants as
`vertical:acme/board-room`, and the operation performs its ordinary permission checks.
The declaration and its keys appear in `PERMISSIONS.md` for review.

The resulting audit actor is `{ vertical, scope }`: this app, from this instance.
The board-room still owns the decision about which of its users may trigger the call.
A peer grant does not automatically narrow itself to that user's CRM permissions.

Host code uses `peerClient('acme/crm').invoke('customer/get', input)`. An operation,
consumer or schedule cannot use that network path from inside its scope. It instead
writes a `peer-invoke` platform intent with `ctx.requestPlatform`, in the same transaction
as its own rows. Rollback removes the request too. After commit, the platform delivers
it at-least-once, using the request id as the idempotency key. The returned id is an
enqueue receipt; read the platform-request journal for the outcome.

There is a timing detail worth making explicit: **a queued call resolves its target
when it executes**. If an admin changes the binding between enqueue and delivery,
the queued call goes to the newly selected instance. A workflow that spans both apps
must represent pending, successful and failed work in its own records; there is no
distributed rollback if the second app refuses.

The tenant can switch a peer off on the receiving scope. The next call is refused,
and re-provisioning or restoring an old backup cannot quietly restore that authority.
This is a pause in permission, not a missing installation. The dashboard keeps those
states distinct. The [peer-call reference](/guide/architecture#calling-another-vertical-the-peer-door)
has the complete declarations and a runnable two-app example.

### Follow one exported event

Suppose the board-room keeps a count of customer records created in each business
category. The CRM can publish a deliberately non-personal fact for that purpose.
It must not put a name, email address or other personal data in that event and merely
label it `none`. The classification is a promise made by the producer, not a sanitizer.

The producer declares the event type it **exports** and the permission needed to read
it. The consumer declares the producer, type and `schemaVersion` it **imports**, and
registers an import handler. It parses the payload with its own schema and updates
its own tables. An ordinary emitted event with no export declaration stays local.

<CommunicationFlow kind="events" />

The important new object is the **watermark**: the last position reached in the
producer's event stream. It lives in the consumer's database, beside the data derived
from that stream. The platform asks for that position, reads exported events after it
through the producer's own code, and delivers the batch through the consumer's peer door.

Authority is checked in **both directions**. The consumer needs the export's read key
in the producer's scope. The producer needs the receiver's declared peer authority
to enter its import handler. The handler acts as the producing app and its checks
are real. The platform transports the fact; it does not waive either app's checks.

Each handler's writes and its delivery-journal row commit together in the receiving
scope. Only after processing the batch does the consumer advance its watermark.
A repeated delivery finds that journal row and skips the handler. This gives one
committed effect per event and module during ordinary delivery, even when transport
repeats. It does not extend the producer's transaction into the consumer.

Now the failure cases follow from where that bookmark lives:

| Situation | What happens |
|---|---|
| The consumer is installed later | It starts at the beginning of the retained exported history. |
| Either peer is switched off | The edge pauses; the watermark holds and the backlog waits. |
| Delivery cannot reach a deployment | The edge reports failure; the platform can try again from the held position. |
| A handler throws | Its writes roll back, a dead letter is recorded, and later events can proceed. Waiting does not retry that handler. |
| The consumer is restored to an earlier point | Its data and watermark rewind together; delivery catches it up. |
| An operator explicitly replays a range | Delivery records for that range are archived and cleared; handlers run again and can emit new effects. |

Only `piiClass: 'none'` events cross this stream. Erasure in the producing scope
cannot reach a copy a different app derived. A governed peer read is the path for
current personal information; persisting its result creates a separate responsibility
in the receiving app. Producer actor and authorization records do not travel in an
exported envelope either. The import retains source identity, and `causedBy` lets a
cause walk say where the chain continues in the other app.

Delivery matches **type and schema version**. A mismatch is withheld and dead-lettered
without exposing the payload to the handler. Classified, undecodable and over-hop-limit
events are also withheld, and the watermark moves past them. This differs from a
paused edge, which holds its position. A chain can cross at most eight vertical boundaries,
so two apps cannot keep generating work for one another forever.

### Prompt delivery, and the limits of the promise

The hosted transport is implemented. A routed response that committed exported events
can raise an export flag; the router returns the response and kicks a platform pull.
The worker's `kickFlags` helper wires this alongside the platform-intent flag from
chapter 5. Kicks are coalesced per producer with a five-second window and a trailing
pass to catch work committed during a burst. The scheduled sweep remains the backstop.

An event committed by a schedule, a peer call or another import has no routed response
to flag, so it waits for the sweep. “Usually seconds” is useful; “every event immediately”
would be an incorrect guarantee.

The current event-stream resolver still requires each end to be its vertical's unique
primary instance in that tenant. **The instance binding for peer calls does not also
bind an event stream.** Two eligible installs leave an unresolved edge.

The dashboard and console show edge health: caught up, behind, paused, unresolved or
unavailable. They also expose replay and skip. A replay deliberately runs handlers again,
so it requires an acknowledgement of that consequence; it is not an ordinary retry.
CI checks exported schemas, and a promote dropping or re-versioning an export used by
another app requires acknowledgement. That protection does not yet cover an individual
scope's `bindScopeVersion` change. These are deployed-code contracts, not just TypeScript
imports between packages in one build.

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

As of this edition, the engine is used by Handlebar and remains unpublished to npm.
It supports email, with no digest or other channel yet. The
[notifications reference](/engines/notifications/) has the calling shape and prerequisites.

## Assistant: the conversation record and the run are separate

The new engine is named **assistant**. Its first implementation landed on
15 October 2026, after the three complete weeks reviewed for this edition. It owns
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

The status matters as much as the design: the engine is in the repository, is not
published to npm, and **no vertical composes it yet**. A shared assistant UI, a hosted
runner and acting across products as the user are follow-on work, not capabilities
this package alone delivers. There are no branches, human participants, support handoff
or memory yet. See the [assistant reference](/engines/assistant/) for the implemented
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

**Next:** [The life of one deploy →](/book/08-one-deploy)
