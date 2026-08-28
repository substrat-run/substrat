---
description: "One vertical, end to end, as whole files rather than excerpts: a one-line brief, the interview's answers, the approved concept, the declared model, what is derived from it, and the business logic that is all you write. The todo app, because the domain costs a reader nothing."
---

# Walkthrough: the todo app

This page shows the whole process once, on the smallest app anyone could ask for — *"I want
to create a todo app"* — using **complete files from the repository** rather than excerpts.
An excerpt of generated code is unconvincing, because the reader assumes the messy parts
were cropped. Every block below is the file as it sits in `demos/todo/` at the version of
these docs, pulled in at build time; nothing is retyped for the page.

Todo was chosen for the reason a todo app is usually a bad demo: the reader spends zero
attention on the domain, so the *process* is the only thing on the page. Every other
[demo vertical](/verticals/) makes you learn field service or bike repair first.

The chain is five files and one derivation step:

| step | file | who writes it |
|---|---|---|
| 1. The brief | `spec/prompt.md` | the customer, in one line |
| 2. The interview | `spec/answers.md` | the customer, answering the builder |
| 3. The concept | `spec/concept.md` | the builder; approved before any code |
| 4. The model | `spec/model.ts` | the builder — what exists, declared once |
| 5. What is derived | migrations, manifest, permissions, API, client | nobody — re-emitted, and gated |
| 6. The business logic | `src/module.ts` | the builder — the only code that is *about* todo |

Read it top to bottom. The point is at the end: the last file is the whole of the
application code, and none of the tenancy, permissions or audit it runs under appears in it.

## 1. The brief

The prompt is one line, deliberately. A real brief is underspecified, and everything that
follows was either asked for in the interview or assumed by the builder and written down in
the concept's Assumptions section — never silently.

<!--@include: @/../../demos/todo/spec/prompt.md{3,}-->

## 2. The interview

The [design skill](/guide/agent-plugin) asks the questions the brief left open, in two rounds
of a few each, recommending an answer to every one. Here every recommendation was accepted
as offered, which is what a builder should expect for an app this plain.

<!--@include: @/../../demos/todo/spec/answers.md{3,}-->

## 3. The concept

The interview produces a **concept** — the design document the customer approves before a
line of code is written. It is written for the customer, in their vocabulary, and it is the
contract every later step is checked against: the cast in §6 becomes the seed, the scenario
in §9 becomes the test, and the assumptions in §10 are the decisions taken on the customer's
behalf, listed so they can be reversed while reversing is cheap.

Notice §3. Accounts, invitations, isolation between accounts, a permission check on every
operation and an audit trail are listed under *free from the platform*. What is left under
*yours to build* is lists, items and sharing — and that is the whole build.

<!--@include: @/../../demos/todo/spec/concept.md{3,}-->

## 4. The model

The approved concept becomes one TypeScript module declaring **what exists**: the entities
and their fields, the operations over them, and the permission each operation checks. It is
TypeScript rather than a schema language because the compiler checks the joins between those
three things — an operation naming an entity that does not exist, an `entityIdFrom` naming
no output field, a payload carrying an `erasable` field — and those joins are where the
defects live. [The model](/concepts/model) explains each declaration; this is what a
complete one looks like.

Two lines carry the permission model. `parents: ['owner']` on `list` is the edge the
permission walk follows, so "your lists" is a fact the kernel can prove rather than a filter
the code has to remember. And `permission: { key: 'list:manage', entity: 'list', idFrom:
'listId' }` on `rename-list` declares that the check is *on that list*, which the
[conformance kit](/reference/contract-tests) then drives against the handler.

<<< @/../../demos/todo/spec/model.ts

## 5. What is derived

From `spec/model.ts`, without another line being written:

- **The migrations** — `src/migrations.generated.ts`, the `CREATE TABLE` for each entity and
  the indexes behind each declared sort and filter, re-emitted by `pnpm lint:migrations`.
- **The manifest** — assembled from the model's two halves at mount time: the permission
  registry, the entity relations the permission walk follows, the events each operation
  emits, the paged lists.
- **`PERMISSIONS.md`** — the human checkpoint: every key, what it means, and which role
  holds it, rendered by `pnpm lint:permissions` and checked in, so a widened role cannot
  merge without appearing in the diff.
- **`model.json`** — the model as data, for tools that do not run TypeScript; gated by
  `pnpm lint:model --check`.
- **The HTTP surface** — each operation's `http: { method, path }` becomes a route, its
  input schema becomes the request validation the host applies before the handler runs, and
  `openapi.json` with a Scalar page is served from the same catalogue (`pnpm lint:api`).
- **The browser client** — `app/src/api.generated.ts`: typed methods for every operation,
  the entity interfaces, the paged `Link` walk (`pnpm lint:client`).
- **`CONFORMANCE.md`** — the receipt saying which declared entity checks the kit drives
  against the running handler, and which it cannot, by name (`pnpm lint:conformance`).

Each of those carries the three marks a [generated file](/guide/agent-rules) must: the
`.generated` suffix or a `GENERATED` first line, a header naming the producer and the
source, and a `--check` re-emit in CI. The third is the only one that enforces anything.

## 6. The business logic

What is left is the one file that is *about* todo: what it means to share a list, and who
may do what to one. Every handler opens with the check its declaration promised, and
the `satisfies` clause at the bottom is what makes a handler that disagrees with its
declaration — or one declared and not implemented — a compile error naming the method.

Sharing is the part worth reading twice. `share-list` is one `ctx.grant` and `revoke-share`
is one `ctx.revoke`: the kernel narrows `list:contribute` onto *this* list for *this*
person, re-checks that the caller holds it there, and records it transactionally with the
operation. Nothing else in the app has to remember that Björn may touch this list — the
grant is the fact, and every check reads it.

<<< @/../../demos/todo/src/module.ts

## What this shows, and what it does not

**What it does not show.** Todo composes **no engine**. Its `defineOperations` takes no
engine argument, and that is a fact about the app rather than an omission: nothing here has
an invariant beyond "you cannot touch a list nobody shared with you", and that one is the
platform's own. So this page shows the model → code pipeline and not engine composition,
which is a large part of what a real vertical does. For that, read
[Callout](/verticals/callout) — a work order that composes the [workorder](/engines/workorder/)
and [protocol](/engines/protocol/) engines inside its own transaction.

**What it does show.** Here is the smallest app anyone could write, and it is already
multi-tenant, permission-checked on every operation, and audited on every change — and none
of that appears in the code above. "A todo app makes the platform look like overkill" is
true only if you show the app. Show what you did *not* write and it is the point.

## The honest comparison: Wasp

Wasp's `TodoAppTs` is the same app, and it is worth putting next to this one because Wasp is
good and the difference is real.

**On line count, Wasp wins.** `main.wasp.ts` is about 30 lines, `schema.prisma` a dozen,
`actions.ts` 34, `queries.ts` 13 — under a hundred lines to Substrat's roughly 800 across
`model.ts` and `module.ts`. Their terseness is genuine, and this page is not structured as
though it were not. A good part of the difference is that Substrat's two files carry the
things Wasp leaves to convention: which permission each operation checks, what each mutation
emits, what is personal data, how a list is paged.

**The axis where Substrat is different is what a handler looks like.** Wasp's update action
is this:

```ts
return context.entities.Task.updateMany({
  where: { id: args.id, user: { id: context.user.id } }, // forget this and anyone edits anything
  data: { isDone: args.isDone },
});
```

The ownership clause is the whole access control, it is restated in every handler, and
nothing in the framework notices if one of them drops it — the types stay perfect. Their
schema even has `userId Int?`, so a task can exist with no owner at all.

In todo the same edge is `parents: ['list']` in the model plus one
`ctx.check(perm, entityRef)` at the top of each handler, declared once rather than remembered
per handler — and the declaration is what the conformance kit drives, so a handler that
checked the node instead of the entity goes red in CI rather than shipping. That is not a
claim that Substrat's code is shorter. It is a claim about where the mistake can live.
