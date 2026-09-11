# 1. Why a substrate at all

Every piece of business software for a specific trade — a field-service app, a workshop
system, a clinic's booking tool — is mostly the same software. Not in the part anyone
pays for, which is the vocabulary and the screens and the pricing. In the part underneath:
tenancy, roles, permission checks, an audit trail, migrations, deploys, backups, an
invite flow, a way to run a copy of production without touching production.

That underneath is perhaps 80% of the code and nearly all of the risk. It is also the
part that is wrong in almost every such system, in the same few ways, and the ways are
not subtle:

- **A missing `WHERE tenant_id = ?`.** One forgotten clause, and a query reads another
  customer's rows. The type checker cannot see it, the tests do not have two tenants in
  them, and the failure is silent until it is a disclosure.
- **A permission check that was never written.** The handler that lists is guarded; the
  handler that exports is not, because it was added in a hurry six months later.
- **An audit trail that is a `log.info` call.** It is complete exactly as long as
  everyone remembers to write one, which is to say it is not complete.
- **State machines enforced by convention.** A row goes from `draft` to `invoiced`
  because every code path happens to move it that way — until one does not.

Each of these is an instance of the same thing: an invariant the system *depends on*,
enforced by a person remembering. The remedy is not better discipline. It is moving the
invariant somewhere discipline is not required.

## The bet

Substrat's bet is that this substrate is worth building once, properly, and that
"properly" means **the runtime refuses**, not that the docs advise.

So: a kernel owns tenancy, permissions, events, migrations and the transaction boundary,
and it owns them in a way module code cannot opt out of. There is no `WHERE tenant_id`
to forget, because a handler's `ctx.sql` is already inside one tenant's database and has
no syntax for reaching another. There is no un-audited mutation, because the event is
written in the same transaction as the row and the envelope is stamped by the kernel, not
supplied by the caller. There is no unchecked operation, because a check that was never
called leaves a trail of its own.

That is the claim [Why runtime enforcement?](/guide/why-substrat) argues at length. This
book takes it as given and shows the machinery.

## The three layers

<LayerStack />

Read it bottom-up.

**The kernel** owns what must never be wrong. It provides an `OperationContext` — `sql`,
`emit`, `check`, `link`, `grant`, `now` — and nothing else. It knows no domain entities
at all: it has never heard of a work order or an invoice, and could not be made to
special-case one.

**Engines** own invariants inside a domain. The work-order engine knows that a completed
order cannot go back to scheduled, that every state change emits an event, that an
exported billing basis is immutable afterwards. There are seven of them, each headless —
no screens, no vocabulary, no opinion about what you call things.

**Verticals** own everything a user touches: the words, the roles, the prices, the
screens, the workflow. A vertical composes engines the way an application composes
libraries, except that the library's invariants are enforced from below rather than
trusted.

The line between the bottom two bands and the top one is the interesting one, and it is
drawn where it is on purpose. Below it, change is slow, reviewed, and versioned, because
being wrong there is expensive. Above it, change is fast — a vertical is exactly the kind
of code an agent or a small team can write quickly, because the expensive mistakes are
not available to make. You cannot skip a state. You cannot forget a check and have
nothing notice. You cannot read another tenant.

That is the actual product: not "AI writes your app", but *a place where AI writing your
app is not reckless*. [Where AI mistakes stop](/guide/ai-guardrails) is that argument
with the specific failure modes named.

## What this costs you

It is worth being blunt about the shape of the trade, because it is a real one.

**You give up arbitrary data access.** A handler reads and writes through `ctx.sql`,
inside one scope, and nothing else. No connection pool, no second database, no `fetch` to
a sibling service. If your design needs a handler to read across tenants, the design has
to change; the runtime will not bend.

**You give up cross-module joins.** Another module's tables are private — not "please
don't", but a linted, reviewable boundary. A vertical that wants extra fields on an
engine's entity keeps its own side table keyed by the engine's id, and never a column
upstream.

**You give up synchronous everything.** Effects that are not scope-local — sending mail,
calling a provider, writing tenant-wide directory state — do not happen inline inside
your transaction. They are asked for, and effected out of band. Chapter 5 is largely
about this.

In exchange, a class of bug becomes structurally unavailable rather than merely rare, and
you get the operational half — audit, snapshots, previews, migrations, backout — as
properties of the substrate rather than as projects.

## What is not in the box

Substrat is not a BaaS, not an ORM, and not a low-code builder. It does not generate your
UI, though it will generate your API client. It has opinions about tenancy and none about
CSS.

It is also not finished. [What Substrat doesn't have (yet)](/guide/what-substrat-lacks)
is the current list, and this book flags the relevant gaps where they arise rather than
saving them up.

## Two pictures, one system

There are two ways to look at what follows, and you need both.

The layer stack above is *what the code is* — which package owns which concern, which
direction dependencies point. It is the picture you need when deciding where a change
belongs.

The other picture is *how it runs*: a request arriving at a hostname, resolving to a
tenant and a scope, reaching a database that holds that scope's data and no one else's.
That is the next chapter, and it is the one that makes the rest of the book legible.

---

**Next:** [Tenants, scopes, and one database each →](/book/02-tenants-and-scopes)
