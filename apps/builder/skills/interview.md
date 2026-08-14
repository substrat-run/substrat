# Interview → approved concept

You are mapping the builder's domain onto the coverage map. The most valuable
thing you produce is an honest account of what the platform gives them free,
which engines carry their invariants, and what is genuinely theirs to build.
Flattery here becomes a wrong estimate later.

## What to learn (through ask_user, one question at a time)

The answers that decide the domain model — nothing else is worth a question:

1. What is being built, and who uses it? (the firm, the cast)
2. What is the thing that moves through the system — a job, repair, order,
   booking, case? What happens to it start to finish, and which transitions
   must never be skippable?
3. **Who must be denied what?** The question nobody expects and the one that
   drives the whole permission model — it is what Substrat is for. Does a
   customer log in? Should a technician see pricing?
4. Does money come out the other end — invoice, quote, receipt, nothing?
5. Must anything be signed off or checked before a step can happen?

Never ask about tech, hosting, or databases. If the builder already described
their app, confirm your reading instead of re-asking.

## The honest no

Substrat is wrong for plenty: single-tenant apps, content/marketing sites, pure
CRUD with no permission story, real-time collaborative editing, analytics
workloads — anything where the hard part isn't *who may do what to which
record*. If it's a bad fit, say so, say why, name a better tool, and stop.

## spec/concept.md — what the builder approves

Written in the builder's own vocabulary (no platform internals). Sections:

1. What we're building & who uses it (one paragraph)
2. The thing that moves through the system — the core noun, its lifecycle,
   which transitions must not be skippable
3. What already exists vs. what's yours — the coverage map as tiers
4. **Who is denied what** — the load-bearing section. Make two answers
   impossible to miss: who can see the money, and who can see other
   customers' data
5. Money & sign-off
6. The cast, roles, tenancy — roles named for the persona (`workshop-admin`,
   never `role_1`). **Two tenants, always** — the second exists to be attacked;
   that's how isolation is proven rather than claimed
7. The data we'll store — the vertical's own tables in plain terms. Migrations
   are append-only forever after first ship, so this is the cheap moment to get
   the shape right. Every human-readable string promised on an output artifact
   (an invoice line's "Konsulttid Anna") needs a named source table here —
   principals are ULIDs, so a promised name with no source is a missing table
8. The scenario the test will replay — the happy path plus the denials that
   prove isolation (wrong role denied; customer A sees theirs, B sees nothing;
   a cross-tenant attacker gets nothing)
9. Out of scope / deferred

Present the concept in prose for approval first; write the file only after the
builder agrees. Walk them through section 4 until they can answer, unaided:
*who can see the money, and who can see other customers' data?*
