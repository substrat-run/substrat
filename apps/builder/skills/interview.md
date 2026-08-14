# Substrat knowledge — interview → approved concept

You are mapping the builder's domain onto what already exists. The most valuable
thing you produce is an honest coverage map: what the platform gives them free,
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

## The coverage map — four tiers

**Tier 0, the kernel — always, free.** Tenancy (a scope = one isolated
database; cross-tenant access has no API), permissions (roles, grants,
entity-narrowed grants, every decision carries a proof path), events + audit
(every mutation emits a kernel-stamped event; origin fields cannot be
mislabeled), migrations (journaled per module). This is usually most of what
the builder would otherwise get wrong — say so plainly, even when no engine fits.

**Tier 1 — engines you compose** (imported; their in-scope functions run in
YOUR transaction):

- `engine-workorder` — a job whose lifecycle cannot skip states, plus time and
  material reporting. Operations `workorder/get|list|assign|start|report-time|
  report-material|complete|close`. There is deliberately **no `workorder/create`
  operation**: creation is the in-scope function `createWorkOrder(ctx, …)`,
  because the vertical must price and label the job first.
- `engine-protocol` — checklists/inspections: templates, responses, signatures.
  Contributes the `protocol/all-signed` guard predicate, so an operation can be
  declared blocked until a protocol is signed.
- `engine-booking` — reservations. Owns exactly one invariant: concurrent
  allocations never exceed a resource's capacity over any overlapping interval.
  States `held → confirmed → in_service → completed` (+ `expired`, `cancelled`,
  `no_show`); holds carry an expiry. `join`/`leave`, `availability()`, `move`,
  typed `SlotUnavailable`. Knows nothing about pricing, opening hours,
  recurrence, or timezones — all vertical policy. `booking:hold` and
  `booking:confirm` are separate permissions, so an approval workflow is a
  grant shape, not custom logic.
- `engine-invites` — joining an org you are not in. Identifiers are stored
  hashed and never returned (the surface can never answer "is this person on
  the platform"), and an invitation confers nothing until accepted. Use it
  before hand-rolling any invite flow.
- `engine-absence` — leave/absence: an append-only entry ledger over an opaque
  subject ref, balance-as-of-date as a pure fold, per-leave-type balance floor,
  and the request approval state machine as the only mint for bookings and
  reversals ("Hugo came back" is a compensating entry, never an edit). Knows
  nothing about who a subject is, weekends, holidays, accrual formulas, or what
  a leave type means — all vertical policy. Dates are inclusive calendar days.
- `engine-metering` — usage-based billing's quantity side: configured meters
  (counters sum; gauges sample and carry forward), append-only entries with
  idempotent ingest keyed by (meter, dedupe key), and a period-close whose
  horizon no new entry may land behind. Owns quantities, never prices — no
  currency, rates, or plans; the vertical prices the fat
  `metering.period-closed` event and can feed invoicing with it (the
  `timesheet.period-closed` hand-off shape).

**Tier 2 — engines you feed by event** (no import; you emit, they consume):

- `engine-invoicing` — invoice basis + lines, immutable after export. Consumes
  `workorder.completed`, `commerce.order-placed`, and `timesheet.period-closed`.
  Its consumer find-or-creates the customer's open basis and appends — the
  monthly-accrual model, free. Ignores orders with `paymentMethod !== 'invoice'`.
  **No tax/VAT concept** — say so before an EU builder discovers it.

**Tier 2b — connectors** for anything off-box (module code may not touch the
network): the platform reaches third parties through connector handlers that
run outside the scope transaction, with retry/timeout/dead-letter policy.
`connector-scrive` (Scrive eSign / Swedish BankID, driven by
`protocol.signatures-requested`) exists today. Never conclude an integration is
impossible because module code can't fetch — connectors are the answer.

**Tier 3 — yours**: vocabulary, price list, screens, roles, and any domain the
engines don't own. If the core noun isn't job/inspection/booking-shaped, most
of the app is Tier 3 — a normal, supported outcome, not a failure.

This inventory can go stale; the engines are self-describing. After
`pnpm install`, ground truth is `node_modules/@substrat-run/<engine>/dist/index.d.ts`.

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
