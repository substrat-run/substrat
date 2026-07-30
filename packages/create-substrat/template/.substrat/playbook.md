# Playbook — build a vertical on Substrat

The always-on rules live in [`AGENTS.md`](../AGENTS.md); read them first. This playbook is
the **flow**: interview the user, tell them honestly how much of their app already exists,
then build and run the part that doesn't. Read the whole thing before starting — the
checkpoint in Step 6 is a hard stop.

This project ships with a small **working reference vertical** — a bike-repair shop on
`engine-workorder` + `engine-invoicing`, green out of the box (`npm test`). It is your
worked example and your starting point: you **reshape** it into the user's domain rather
than building from an empty directory. Work in the project root.

---

## Step 1 — Interview

Ask, don't assume. **Three to five questions, conversational, one message.** You are
learning the *shape* of the domain, not writing a spec.

1. **What are you building, and who uses it?** (the firm, the cast)
2. **What's the thing that moves through the system?** A job, a repair, an inspection, an
   order, a case? What happens to it from start to finish?
3. **Who must be denied what?** The most important question and the one nobody expects.
   Does a customer log in? Should a technician see pricing? This drives the whole
   permission model, and it is what Substrat is *for*.
4. **Does money come out the other end?** Invoice, quote, receipt, nothing?
5. **Anything that must be signed off or checked before a step can happen?**

Don't ask about tech, hosting, or databases yet. If the user already described their app in
detail, skip to Step 2 and confirm your reading of it instead of re-asking.

---

## Step 2 — The coverage map

**This is the most valuable thing you do, and the easiest to get wrong by being
flattering.** Tell the user what already exists and what they are actually signing up to
build. Be specific and honest.

**First, list the engines that actually exist. Do not trust any hard-coded list:**

```sh
npm search @substrat-run --json | grep -E '"name"|"description"'
```

Substrat publishes frequently, so any inventory in a doc goes stale between releases. A
missing engine does not fail loudly — it silently becomes Tier 3, and you hand the user an
estimate for work that already exists. Run the search, then read the `dist/index.d.ts` of
anything relevant.

Coverage has four tiers:

### Tier 0 — the kernel. Always. Free.

Every vertical gets this whether or not it uses a single engine:

- **Tenancy** — tenants and scopes, isolated at the database level. A scope is one
  SQLite/DO database. Cross-tenant access is not a bug you avoid; there is no API for it.
- **Permissions** — roles, grants, entity-narrowed grants, and every decision carries a
  proof path (why it was allowed).
- **Events + audit** — every mutation emits a kernel-stamped event. Origin fields (tenant,
  scope, actor, time) are stamped by the kernel; your code cannot mislabel one.
- **Migrations** — journaled per module, applied lazily per scope.

This is usually *most of what the user would otherwise build badly*. Say so plainly.

### Tier 1 — engines you compose

Imported directly; their in-scope functions run in **your** transaction. Read each one's
`node_modules/@substrat-run/engine-*/dist/index.d.ts` for the real surface before composing
— in-scope functions, `PERM` keys, and types. Typical examples (verify with the search):

- **`engine-workorder`** — a job with a lifecycle that cannot skip states, plus time and
  material reporting. Note there is **no `workorder/create` operation** — creation goes
  through `createWorkOrder(ctx, …)`, an in-scope function, because the vertical must
  price/label it first. The hole is deliberate: the engine owns the state machine, you own
  vocabulary and pricing.
- **`engine-protocol`** — checklists/inspections with templates, responses, and signatures.
  Contributes a guard predicate so you can declare an operation blocked until signed.
- **`engine-booking`** — reservations. Owns one invariant: concurrent allocations never
  exceed capacity over any overlapping interval. Knows nothing about pricing, opening
  hours, recurrence, or timezones — all vertical policy.
- **`engine-invites`** — how a person joins an org they are not in. Identifiers stored
  hashed and never returned; an invitation confers nothing until accepted. Reach for it
  before hand-rolling any invite flow.

### Tier 2 — engines you feed by event

**No import.** You emit; they consume. This is the star topology.

- **`engine-invoicing`** — invoice basis and lines, immutable after export. Consumes
  `workorder.completed` and `commerce.order-placed`, so a vertical that imports zero engines
  still gets invoicing by emitting an event. Its consumer find-or-creates the customer's
  *open* basis and appends. It has **no tax/VAT concept** — say so before an EU user
  discovers it.

### Tier 2b — connectors, for anything off-box

Module code may not touch the network (rule 2), so a third party is reached by a
**connector**: `host.registerConnector(id, eventType, handler, options)`, with retry
policy, timeout, dead letters, and per-connection state. The handler runs *outside* the
scope transaction. Delivery is at-least-once — key a dispatch ledger in connector state and
return early on redelivery. Granting door access twice is harmless; charging a card twice
is not.

### Tier 3 — yours

Vocabulary, price list, screens, roles, and any domain the engines don't own. If the user's
core noun isn't a job/inspection, this is most of the app — **a normal, supported outcome,
not a failure.**

### Deliver it like this

> Your bike shop: a repair is a **work order** — the engine owns its lifecycle, so it can't
> jump from booked to closed. Time and parts reporting: engine. The invoice at the end:
> invoicing, by event — you emit, it listens. **Yours:** bikes, customers, your price list,
> the pricing rule when a repair takes 20 minutes but you bill a minimum hour, and the
> screens. Tenancy, permissions, and the audit trail come from the kernel — including the
> part where a customer logs in and sees *only their own* bikes.

### The honest no

Substrat is the wrong tool for plenty. Say so — it's what makes the yes trustworthy. Bad
fits: single-tenant apps, content/marketing sites, pure CRUD with no permission story,
real-time collaborative editing, analytics workloads, anything where the hard part isn't
*who may do what to which record*. If it's a bad fit, say why, name a better tool, and
stop. Do not scaffold.

---

## Step 3 — Decisions

Short. Recommend a default and move.

- **Auth.** Local dev uses an `x-principal` header — a dev seam, not a login. Offer to wire
  a real login now if they want it; otherwise default to the dev header and say it **must**
  be replaced before anything real. Real auth gates *exposing* the app, not *building* it.
- **The cast.** Confirm the personas and their roles (e.g. `office-admin`, `technician`,
  `portal-customer`). Roles are the user's vocabulary — name them for the persona.
- **Two tenants, always.** Seed a second tenant that exists to be attacked. This is how the
  isolation gets proven rather than claimed.

---

## Step 4 — Reshape the reference

The scaffold already contains a working vertical in `src/` + `test/` — the bike-repair shop.
**Read it first** (it's your Callout: the real, green implementation of every pattern this
step describes), then reshape it into the user's domain from the interview:

- **Rename the vocabulary** — `shop_customers`/`shop_bikes` → the user's nouns, the `shop/*`
  operation names, the roles, the price-list shape. If the user's core noun maps onto a work
  order (a repair, a job, an inspection, a case), most of the structure carries over
  unchanged and you are editing labels and the pricing rule.
- **Keep the load-bearing patterns** — the permission check as every operation's first line,
  the pricing moment, the portal proof-walk, the two-tenant seed, the pinned-message
  denials. These are what make it a Substrat vertical rather than a CRUD app; the reference
  demonstrates each one working.
- **Drop what the domain doesn't need, add its own tables** for anything the engines don't
  own. If the user's core noun *isn't* work-order-shaped, you may replace more of `src/` —
  but the seed/server/test scaffolding and the layout still hold.
- **Re-run the gates as you go** (Step 5) — the reference is green, so any red is something
  you just changed.

The dependencies are already wired in `package.json` (the `@substrat-run/*` packages, `hono`,
`better-sqlite3`; engines added as needed). If you compose a **different** engine, add it and
read its surface — the engines are self-describing:
`node_modules/@substrat-run/engine-*/dist/index.d.ts` is the reference; never guess at it.

**Do NOT add `zod` as a dependency, and never `import { z } from 'zod'`** (rule 10). Import
everything from contracts:

```ts
import { z, entityRef, money, moduleManifest } from '@substrat-run/contracts';
```

**After install, the engines are self-describing — read them.** Do not guess at their
surface: `node_modules/@substrat-run/engine-*/dist/index.d.ts` is the reference.

### `src/manifest.ts`, `src/migrations.ts`, `src/module.ts`

Three separate files. `manifest.ts` holds the `PERM` consts + `moduleManifest.parse`,
`migrations.ts` exports the `SqlMigration[]`, `module.ts` imports both and holds only the
operations + the `ModuleRegistration`. Keep the split — the linter and tests expect it.

- `moduleManifest.parse({ … })` — id, version, `kernelContract: '^0.0.1'`, `permissions`
  (key + human description; these feed the permission diff), `events` emits/consumes,
  `attachmentTargets`, `entityRelations`, `entitlementKey`.
- **`entityRelations` must declare every edge you traverse** — your own (`bike → customer`)
  and the ones the engine makes on your behalf (`workorder → bike`). The adapter rejects a
  `ctx.link` for an undeclared edge. This is also what makes the portal proof-walk reach
  the customer.
- Migrations: `SqlMigration[]`, tables prefixed `<vertical>_`, TEXT ids, ISO-8601 TEXT
  timestamps, money/decimals as TEXT. **Append-only forever after first ship.**
- Operations: first line is always `assertAllowed(await ctx.check(PERM))`. Parse inputs
  with Zod. `ctx.link(child, parent)` when creating related entities.
- **The pricing moment is the pattern to copy**: read the engine's reported lines with
  `getReportedLines(ctx, orderId)` → apply the vertical's price list → call the engine's
  `completeWorkOrder`. One transaction, invariants intact.
- Portal listing: iterate and `ctx.check(perm, entityRef)` **per entity** — a proof walk,
  not UI filtering.

### `src/seed.ts`

`new SqliteScopeHost({ dir })`, then `registerModule` per engine + the vertical. The control
plane comes first and is audited:

```ts
host.admin.createTenant(actor, { id: tenant, slug: 'acme', name: 'Acme' });
host.admin.grantEntitlement(actor, tenant, '<entitlementKey>');   // per module
await host.provisionScope(actor, { tenantId: tenant, scopeId: scope, jurisdiction: 'eu' });
```

Define roles **per tenant** from the engines' `PERM` + your keys, assign them, create seed
entities via `stub.invoke` (**never raw SQL**), give portal principals entity-narrowed
grants. Make it idempotent.

### `test/scenario.test.ts`

Replay the domain scenario headlessly against a temp dir. **The denial assertions are the
whole point:**

```ts
await expect(host.getScope(mallory, t2, s1)).rejects.toThrow(/unknown scope/);   // wrong pair
const m = await host.getScope(mallory, t1, s1);                                  // right pair, no tuples
await expect(m.invoke('workorder/list')).rejects.toThrow(/permission denied/);
```

Cover: happy path → wrong-role denied → portal isolation (customer A sees theirs, B sees
nothing) → cross-tenant attacker denied → pricing exact to the öre → the state machine
refusing to skip. Never write a bare `.rejects.toThrow()` — pin the message, and pair every
closed-door assertion with a control proving a neighbouring door is still open.

---

## Step 5 — Run it

Build confidence in this order, and **show the user the output of each**:

```sh
pnpm install
pnpm test                        # the scenario, including the denials
npx @substrat-run/boundary-lint  # the layer rules
pnpm dev                         # API on :8871 (PORT=… WEB_PORT=… to move it)
```

Then **actually exercise it** — don't just report that the server started. A green scenario
test never touches `server.ts`, its routes, or the principal picker, so it can be green
while the app is broken. Drive the real flow with curl (create → assign → start → report →
complete) as two personas, switching `x-principal` to show a denial landing as a denial.
The moment the attack fails is the demo; make sure the user sees it.

If they want a UI, scaffold a minimal Vite + React app under `app/` with a principal picker
and typed wrappers over the routes. Ask first — it roughly doubles the work.

---

## Step 6 — The two checkpoints. STOP HERE.

**You may never self-approve these. Present them and wait.**

1. **Migration diff** — every new `SqlMigration`, verbatim. Append-only forever once
   shipped, so this is the last cheap moment to change your mind.
2. **Permission diff** — a table: key → description → which roles hold it → why.

| Key | Description | Roles |
|---|---|---|
| `repair:create` | Book a repair for a customer's bike | workshop-admin |
| `workorder:report` | Report time and materials | workshop-admin, mechanic |
| `bike:read-own` | See your own bikes (entity-narrowed) | portal-customer |

**A checkpoint assumes a competent reviewer.** If the user cannot evaluate the table, walk
them through it in their own vocabulary until they can answer: *who can now see the money,
and who can see other tenants' data?* A permission diff nobody understands is theater.

---

## Step 7 — Deploy (optional)

Only if the user asks. Local-first is a legitimate stopping point.

Substrat runs on Cloudflare via `@substrat-run/adapter-cloudflare` (Durable Objects). A
vertical declares what it needs at runtime with a `substrat.runtimeNeeds` block in
`package.json` (stores, node-compat, build). The deploy path is the authenticated CLI, and
the author never holds a Cloudflare token:

- `substrat login` / `substrat whoami` — authenticate against the control plane.
- `substrat push` — push the vertical; the version auto-bumps. A **private** (tenant-owned)
  vertical is admitted automatically; a **listed/shared** one waits for staff admission.
- `substrat promote <slug> --channel dev|staging|prod --version … [--ack-permissions]
  [--ack-migrations]` — the owner promotes every channel, prod included, for their own
  private vertical.
- `substrat hostnames bind <slug> --surface <s> [--domain <d>]` — mint a live hostname, or
  record a custom domain pending DNS validation (`substrat hostnames verify`).

Updates deploy **in place** from one stable script — data carries forward, migrations run
against prod data, backout is a time-boxed PITR rewind.

Before deploying: the `x-principal` dev header **must** be gone. Shipping it is a
cross-tenant hole with a UI.

---

## Step 8 — Leave the project competent

The next session — in any tool — starts cold. The scaffold already ships `AGENTS.md`,
`CLAUDE.md`, and the Cursor/opencode command stubs, so the rules and this flow survive. Your
job here is to make them *specific to this app*: append the vertical's own vocabulary, cast,
and roles to `AGENTS.md` (it's the file every tool reads), so the next session knows the
domain and not just the framework. Do this before the user comes back.
