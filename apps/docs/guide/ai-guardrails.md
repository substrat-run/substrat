---
description: "Nothing here claims an agent cannot write a bug — only that one class of bug is unreachable rather than discouraged. The six guards a change passes through, in the order they fire."
---

# Where AI mistakes stop

Nothing on this page claims an agent cannot write a bug. It claims that one **class** of
bug — the catastrophic, silent, cross-tenant kind — is unreachable rather than discouraged,
and that a second class — the small, confident, inconsistent kind — has something
independent watching for it.

This is the enforcement half of building on Substrat with an agent. The ergonomic half —
bring-your-own-model, the markdown docs slice, the manifests an agent reads — is on
[Building for AI agents](/guide/ai-agents).

## The structural insight

<BlastRadius />

Analyses of AI-generated apps keep finding the same list: missing row-level security,
broken auth boundaries, no tenant isolation, no audit trail. Prompting a model to "be
secure" measurably does not fix it, which is why the split above is architectural rather
than instructional. The long form of that argument is
[Why runtime enforcement?](/guide/why-substrat).

::: tip Defaults, not configuration
The subtler failure than *no enforcement* is enforcement you can misconfigure. There is no
API that returns another scope's data with the wrong flag set — the API for reaching a
scope *is* the isolation mechanism. There is no "remember to log this" — the event envelope
is stamped kernel-side on every `emit`, and tenant, scope, actor and time are not
parameters. The permission checker's secure default is deny; the permissive one is exported
as `UNSAFE_allowAllChecker`, where the name is the warning.
:::

## Six guards, in the order they fire

These are not layers of a diagram. They are stages a commit passes through in time, each
one able to stop it, and the point of the sequence is that a mistake surviving one guard
meets the next.

<GuardPath />

Guard 01 is the figure above and needs no more room. The rest of this page is the five
that do.

## Guard 02: the layer rules

Every other guardrail in Substrat fails **loud**: branded IDs at compile time, Zod at the
boundary, `getScope` closed on a mismatched `(tenant, scope)`. The layer rules are the ones
that fail **silently**, which is why they need a linter rather than a convention.

**Module code** is everything reachable from a `ModuleRegistration` — operations and
consumers. Composition roots (`server.ts`, `seed.ts`, `worker.ts`) are harness and exempt.

| Rule | What it enforces |
|---|---|
| **R1** star topology | an engine never imports another `@substrat-run/engine-*` |
| **R2** no raw access | no `better-sqlite3`, no adapters, no `node:*`, no `cloudflare:workers` — data access is `ctx.sql` only |
| **R3** no network | module code never calls `fetch()` or imports an HTTP client |
| **R4** spine is sacred | module code never *writes* `_substrat_*` tables (reads are fine — timelines are projections) |
| **R5** tables private | module code never references another module's tables in SQL |
| **R6** one clock | time comes from `ctx.now()`, stable for the whole invocation |
| **R7** no bare catch | an engine error is caught only inside `ctx.atomic` — a bare `catch` commits the engine's partial writes |

Table ownership is **derived, never declared** — a table belongs to whichever module's
`CREATE TABLE` migration created it. There is deliberately no manifest field for it,
because a second source of truth would drift and wave a real violation through.

R5 and R6 have an explicit, reviewable opt-out (`boundary-lint-allow R5` … `boundary-lint-end R5`)
for a one-time extraction handoff and for code that must read the real clock. There is no
escape hatch for R1–R4, and deliberately none for R7 — a hatch there would only ever be used
to silence the rule. The full reference is [`boundary-lint`](/reference/boundary-lint).

::: warning A green light it had not earned
Exit codes are load-bearing: `0` clean, `1` violations, and **`2` the linter could not do
its job** — no module code found, or no engines resolved, so an R5 pass would trivially
succeed. A linter that passes by finding nothing is worse than no linter, so it fails
loudly instead.
:::

## Guard 03: three marks, or it is not generated

A derived file is worth nothing if a reader cannot tell it apart from one a person
maintains — and worth less than nothing if it *says* it is generated while nothing re-emits
it. So a generated file carries all three of:

1. **The filename** — a `.generated.ts` suffix (or, for a document, a `<!-- GENERATED … -->`
   first line). This is the signal a reviewer reads in a diff without opening the file.
2. **A header naming the producer and the source** — so "where does this come from" is
   answered in the file itself.
3. **A `--check` re-emit in CI.** This is the only one that enforces anything. "Do not edit"
   is a request; the gate is what makes it true.

`src/migrations.generated.ts` carried the comment for a year with no gate, and a hand-edit
to shipped SQL passed every check in the repo. The gates that exist today: `lint:model`,
`lint:permissions`, `lint:migrations`, `lint:api`, `lint:client`, `lint:conformance`,
`lint:tests`,
`lint:boundaries`, `lint:decisions`, `lint:playbook`, `lint:docs`, `lint:llms`,
`lint:agent-rules`, `lint:launch`, `lint:plugin`, `lint:pins`, `lint:connector-grants`,
`lint:deps` and `lint:scaffold`.

**The one exception, stated rather than hidden:** a file generated from a *remote* source
cannot be re-emitted hermetically in CI, so it gets marks 1 and 2 plus a `GENERATED_AT`
stamp instead of mark 3. An in-repo source with no gate is a defect, not a style.

## Guard 04: two descriptions that are allowed to disagree

This is the quiet one, and it may be the most valuable thing here. Models are fantastic and
*inconsistent*: they do not fail loudly, they make many small mistakes. You cannot prompt
that away, so the architecture has to catch it.

**Every defect worth catching is two descriptions disagreeing.** Once the implementation is
derived from the model, the code is a *function of* the model and can no longer contradict
it. So the second description has to be the tests — and they are only a second description
if they were written from somewhere else. That makes the direction load-bearing:

> **Code comes from the model. Tests come from the concept.**

The concept is the human-approved prose (`spec/concept.md`); the model is the typed
declaration (`spec/model.ts`). Two independent derivations of the same intent, and the
disagreement between them is the entire product.

A suite written *after* the handlers can only agree with whatever got built. It will pass,
it will look thorough, and it will ratify a wrong model perfectly and forever. That is the
failure mode every AI-generated test suite has, and almost nobody names it.

The mechanical rule that keeps it honest: **literal inputs, literal outputs, import nothing
from `spec/`**. A test that builds its input from the schema it is meant to judge *cannot*
disagree with that schema — it is the mirror again, one level down. `pnpm lint:tests`
enforces it.

Two consequences worth stating plainly:

- **The build may not edit its own oracle.** Tests are written and approved first; the
  build's job is to make them pass.
- **If the concept doesn't say what should happen, that is a gap in the concept.** The agent
  says so and stops, rather than inventing an answer and thereby making it agreed.

## Guard 05: the two human checkpoints

Two things stay under human review even in a fully agent-driven shop:

1. **Schema migrations.** The blast radius of a bad migration is data, not pixels.
   Migrations are plain, reviewable SQL, journaled per module and append-only — a shipped
   version is never edited. The agent writes them; a person approves them.
2. **Permission definitions.** Permissions are declared with human-readable descriptions,
   and every decision carries a proof path, which makes "who gains what, where" a diff
   rather than an archaeology project. `pnpm lint:permissions` renders each vertical's
   `PERMISSIONS.md` from the same `MODULES` and `ROLES` the seed exports, and CI re-emits
   with `--check`, so a widened role cannot merge without appearing in the diff.

Both are still a *human* reading a diff. CI going red is what makes the reading
unskippable; it is not itself the approval.

Everything else — screens, workflows, operations, reports — iterates at agent speed with
contained blast radius: the worst a bad operation can do is fail inside its own scope,
audited.

## Guard 06: a running copy of production to be wrong in

Reviewing a migration diff is a human checkpoint. Clicking a URL on the pull request and
*watching that migration run against a copy of the real data* is what makes the checkpoint
honest.

Open a PR and the platform forks the production scope, binds the version that PR just
pushed, gives it its own hostname, and posts the URL on the PR; closing the PR reaps it.
Successive pushes to the same PR roll their migrations **forward on one copy**, exactly as a
real upgrade would. When a bind crosses a migration-digest boundary the pre-migration data
is snapshotted first — and the digest comparison is the gate, not a flag someone remembers
to pass, so the safety net is on precisely when it matters and absent on a code-only rebind.

*Version 2 landing on version 1's live data is the single most common way a generated app
dies.* This is the machinery that makes it survivable. See
[Environments & previews](/guide/environments-and-previews).

## The receipt the guards leave behind

The six guards above are a commit's problem. This one is a reader's: every guard above is
invisible from the outside, and none of them leaves anything a person who does not have the
repo can look at. A scope *is* a Durable Object with its own SQLite, so another tenant's row
is not absent-by-predicate but absent-by-construction — the strongest claim here, and the
hardest one to show anybody. A buyer cannot see an absence, and an auditor cannot file one.

`pnpm lint:conformance` renders a `CONFORMANCE.md` beside each package's `PERMISSIONS.md`.
Where the permission snapshot is a statement of intent, this is what is asserted against it,
and the two halves are deliberately not mixed:

1. **Kernel-enforced properties**, cited **once** — cross-tenant addressing failing closed,
   the envelope stamped kernel-side, a narrowed grant that does not widen — each naming the
   contract-suite test that verifies it against *both* adapters.
2. **That app's own entity checks**, covered and uncovered **by name**. An operation that
   should check per-entity but checks at the node passes for anyone holding the key anywhere
   in the scope, with every test green; only a behavioural pair separates the two, and the
   pair is generated from the declaration rather than written by hand.

The count discipline is the design. The tempting version multiplies every endpoint by every
tenant and reports a four-figure assertion count — but cross-tenant isolation is one kernel
fact, and restating it per endpoint measures the same thing repeatedly. An auditor who
notices that discounts the whole document, which leaves it worth less than the absence it
replaced. So the kernel section carries no per-app number at all.

It is a statement of what is asserted, not a record that it passed. CI going red is what
makes it true — the same standing `PERMISSIONS.md` has.

## Where this is honest about itself

- **An agent can still write a bug.** The guards make one class unreachable and give a
  second class something independent watching. They do not make generated code correct.
- **The egress sandbox has a documented hole.** Outbound traffic is bounded by a
  [declared per-version allowlist](/concepts/platform) enforced at the egress seam, but
  Durable Object subrequests are a known gap. Don't call it airtight; it isn't yet.
- **A red build is not an approval.** Both checkpoints are still a human reading a diff.
  CI going red is what makes that reading unskippable — it is not itself the sign-off.
- **Enforcement is a slow argument.** It asks a buyer to follow a claim about runtime
  architecture before they can price it. Guard 07 makes the claim legible and citable; it
  does not make it fast. An inherited certification is the version a procurement officer
  prices in one sentence, and it isn't there yet.
- **A receipt is not an audit.** `CONFORMANCE.md` is generated from the repo's own
  declarations and verified by the repo's own tests. That is exactly as much independence as
  a self-signed statement has — which is more than nothing, and less than a third party.

The rest of what is missing is on
[What Substrat doesn't have (yet)](/guide/what-substrat-lacks).
