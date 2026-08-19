---
name: substrat
description: Build a multi-tenant business app on Substrat — interview the user, map their domain onto the engines, and land a reviewable Substrat design document the user approves before any code, then build it. Use when the user mentions Substrat or substrat-run, or asks to build a multi-tenant business app / vertical / internal tool where tenancy, permissions, audit, or work-order-shaped workflows matter (field service, workshops, repairs, inspections, checklists, invoicing).
---

# Build a vertical on Substrat

Substrat is a multi-tenant kernel (tenancy, permissions, events, migrations) plus headless
**engines** that own invariants, and **verticals** that own everything a user touches.
Your job: interview the user, tell them honestly how much of their app already exists, and
**land a design document they can review and approve before a line of code is written** —
then hand off to the build.

**The target is a reviewed design, not running code.** Steps 1–2 learn the domain and map
it onto what already exists; step 3 writes a checked-in design document in the user's own
vocabulary; step 4 is a **hard stop** where the user reads and approves it. Only then does
step 5 hand off to the **new-vertical** skill to build. The design gate (step 4) is
*upstream* of the two code checkpoints (step 7) — a user with zero Substrat knowledge gets
to say "yes, that's the app I want" before implementation, not after.

**Work in the user's current directory.** This skill assumes an empty or near-empty
project. Read the whole skill before starting — the rules in the last section are not
optional, and both the design gate (step 4) and the checkpoints (step 7) are hard stops.

---

## Step 1 — Interview

Ask, don't assume. **Three to five questions, conversational, one message.** You are
learning the *shape* of the domain — the answers become the design document (step 3), so
listen for vocabulary, the cast, and who must be denied what, not just features. **Adapt
depth to the user**: someone who already knows their domain cold needs fewer, sharper
questions; someone thinking out loud needs you to draw the shape out. One flow, not
branching tracks — read the room and dial the teaching up or down.

1. **What are you building, and who uses it?** (the firm, the cast)
2. **What's the thing that moves through the system?** A job, a repair, an inspection, an
   order, a case? What happens to it from start to finish?
3. **Who must be denied what?** The most important question and the one nobody expects.
   Does a customer log in? Should a technician see pricing? This drives the whole
   permission model, and it is what Substrat is *for*.
4. **Does money come out the other end?** Invoice, quote, receipt, nothing?
5. **Anything that must be signed off or checked before a step can happen?**

Do not ask about tech, hosting, or databases yet. If the user already described their app
in detail, skip straight to step 2 and confirm your reading of it instead of re-asking.

---

## Step 2 — The coverage map

**This is the most valuable thing you do, and the easiest to get wrong by being
flattering.** Work out what already exists and what the user is actually signing up to
build. Be specific and be honest. This analysis is the analytical core of the design
document (step 3) — sections 3 ("what already exists vs. what's yours") and 4 ("who is
denied what") are this map, written down.

**First, list the engines that actually exist. Do not trust the list below:**

```sh
npm search @substrat-run --json | grep -E '"name"|"description"'
```

Substrat publishes frequently and this file is hand-maintained, so the inventory below
goes stale between releases — `engine-booking` and `engine-invites` both appeared the day
this section was last written, and `connector-scrive` two days later. A missing engine
does not fail loudly: it silently becomes Tier 3, and you hand the user an estimate for
work that already exists. That is the single most expensive mistake available at this
step. Run the search, then read the `dist/index.d.ts` of anything that looks relevant.

Coverage is not a percentage. It has four tiers:

### Tier 0 — the kernel. Always. Free.

Every vertical gets this whether or not it uses a single engine:

- **Tenancy** — tenants and scopes, isolated at the database level. A scope is one
  SQLite/DO database. Cross-tenant access is not a bug you avoid; there is no API for it.
- **Permissions** — roles, grants, entity-narrowed grants, and every decision carries a
  proof path (why it was allowed).
- **Events + audit** — every mutation emits a kernel-stamped event. Origin fields
  (tenant, scope, actor, time) are stamped by the kernel; your code cannot mislabel one.
- **Migrations** — journaled per module, applied lazily per scope.

This is usually *most of what the user would otherwise build badly*. Say so plainly. It is
the honest answer even when no engine fits.

### Tier 1 — engines you compose

Imported directly; their in-scope functions run in **your** transaction.

- **`@substrat-run/engine-workorder`** — a job with a lifecycle that cannot skip states,
  plus time and material reporting. Operations: `get`, `list`, `assign`, `start`,
  `report-time`, `report-material`, `complete`, `close`. Note there is **no
  `workorder/create` operation** — creation goes through `createWorkOrder(ctx, …)`, an
  in-scope function, because the vertical must price/label it first. That hole is
  deliberate: the engine owns the state machine, you own vocabulary and pricing.
- **`@substrat-run/engine-protocol`** — checklists/inspections with templates, responses,
  and signatures. Contributes the `protocol/all-signed` guard predicate, so you can
  declare in your manifest that an operation is blocked until a protocol is signed.
- **`@substrat-run/engine-booking`** — reservations. Owns exactly one invariant:
  *concurrent allocations against a resource never exceed its capacity over any
  overlapping interval*. States `held → confirmed → in_service → completed`, plus
  `expired`/`cancelled`/`no_show`; holds carry an expiry, so an unanswered request expires
  instead of sitting forever. Capacity with `join`/`leave`, `availability()`, `move`,
  typed `SlotUnavailable`. It knows **nothing** about pricing, opening hours, recurrence,
  cancellation windows or timezones — all vertical policy; it compares absolute instants
  and never does calendar arithmetic. Note `booking:hold` and `booking:confirm` are
  separate permissions, so an approval workflow is a *grant shape*, not custom logic.
- **`@substrat-run/engine-invites`** — how a person joins an org they are not in.
  Identifiers are stored **hashed and never returned**, so the invite surface can never
  answer "is this person on the platform"; and an invitation confers nothing until
  accepted. Reach for it before hand-rolling any invite flow — those two properties are
  easy to lose and expensive to lose.

### Tier 2 — engines you feed by event

**No import.** You emit; they consume. This is the star topology.

- **`@substrat-run/engine-invoicing`** — invoice basis (`invoice basis`) and lines,
  immutable after export. It consumes `workorder.completed`, `commerce.order-placed`
  **and** `timesheet.period-closed` (a closed/approved period of reported time —
  `closeId`/`customer`/`period`/`billable`/`total`, deduped on `closeId`). So an
  e-commerce vertical OR a time-reporting vertical that imports zero engines still gets
  invoicing by emitting an event. Its consumer find-or-creates the customer's *open*
  basis and appends — that is the monthly-accrual model, free. It ignores orders where
  `paymentMethod !== 'invoice'`. It has **no tax/VAT concept**; say so before an EU user
  discovers it.

### Tier 2b — connectors, for anything off-box

Module code may not touch the network (rule 2), so a third party is reached by a
**connector**: `host.registerConnector(id, eventType, handler, options)`, with retry
policy, timeout, dead letters and per-connection state. The handler runs *outside* the
scope transaction and gets `ctx.connection(provider)`.

- **`@substrat-run/connector-scrive`** — Scrive eSign / Swedish BankID, driven by
  `protocol.signatures-requested`. Also the reference for writing your own: delivery is
  at-least-once, so it keys a dispatch ledger in connector state and returns early on
  redelivery. **Copy that idempotency.** Granting door access twice is harmless; charging
  a card twice is not.

### Tier 3 — yours

Vocabulary, price list, screens, roles, and any domain the engines don't own. If the
user's core noun isn't a job/inspection, this is most of the app — **and that is a normal,
supported outcome, not a failure.** `demos/shop` in the Substrat repo is an entire
e-commerce vertical with zero engine imports.

### Deliver it like this

> Your bike shop: a repair is a **work order** — the engine owns its lifecycle, so it
> can't jump from booked to closed. Time and parts reporting: engine. The invoice at the
> end: invoicing, by event — you emit, it listens. **Yours:** bikes, customers, your price
> list, the pricing rule when a repair takes 20 minutes but you bill a minimum hour, and
> the screens.
> Tenancy, permissions and the audit trail come from the kernel — including the part where
> a customer logs in and can see *only their own* bikes.

### The honest no

Substrat is the wrong tool for plenty. Say so — it is what makes the yes trustworthy. Bad
fits: single-tenant apps (the whole point is tenancy), content/marketing sites, pure CRUD
with no permission story, real-time collaborative editing, analytics workloads, anything
where the hard part isn't *who may do what to which record*.

If it's a bad fit, say so, say why, name a better tool, and stop. Do not scaffold.

---

## Step 3 — Write the design document

**This is the deliverable.** Everything before now was learning; this is where it lands
somewhere the user can hold. Write a **checked-in file** in the user's own vocabulary — no
Substrat internals, no `D-`/`K-` decision refs, no `§` cross-references (those live in
platform docs, not a user's design doc). Someone who has never heard of Substrat must be
able to read it and recognise their own business.

**Where:** `DESIGN.md` in the project root for a real user's empty directory; inside the
Substrat monorepo it is `demos/<name>/spec/concept.md` (the existing convention).

**Top line, verbatim** — this is the house marker for a pre-code design (matching
`docs/engines/protocol.md`):

```
Status: draft v0.1 · Last updated: <date> · For review before any code
```

**The template** — the coverage map (step 2) is sections 3–4, already done; the rest is the
interview written down. Two sections deliberately *preview* the code checkpoints of step 7
in plain language, so nothing there is a surprise:

1. **What we're building & who uses it** — the firm and the cast, one paragraph.
2. **The thing that moves through the system** — the core noun and its lifecycle
   (the states it passes through, and which transitions must not be skippable).
3. **What already exists vs. what's yours** — the coverage map as tiers: the kernel
   (free), the engines you compose, the connectors, and the Tier-3 vocabulary/pricing/
   screens that are yours. If it's a **bad fit, this is where the honest no lands** — say
   so and stop; do not write the rest.
4. **Who is denied what** — the load-bearing section, and a plain-language *preview of the
   permission diff*: each role and what it can and cannot see. Make two answers impossible
   to miss — **who can see the money, and who can see other customers' data.**
5. **Money & sign-off** — invoice / quote / receipt / none; anything gated on a signature
   or a check before a step can happen.
6. **The cast, roles, and tenancy** — the named roles per persona (roles are the user's
   vocabulary — name them for the persona: `workshop-admin`, not `role_1`). **Two tenants,
   always** — the second exists to be attacked, which is how isolation gets proven rather
   than claimed.
7. **The data we'll store** — the vertical's own tables and fields in plain terms. This
   *previews the migration diff*; migrations are **append-only forever after first ship**,
   so this is the cheap moment to get the shape right. **Every human-readable string the
   design promises on an output artifact needs a named source here** — if §8 shows an
   invoice line saying "Konsulttid Anna", some table in §7 must own that name, because
   principals are ULIDs. A promised name with no source table is a missing table,
   discovered at build time instead of in this review.
8. **The scenario the test will replay** — the happy path plus the denials that prove
   isolation (wrong role denied, customer A sees theirs and customer B sees nothing, a
   cross-tenant attacker gets nothing).
9. **Open decisions** — each with a **recommended default**, so the user chooses rather
   than specifies:
   - **Auth.** Local dev uses an `x-principal` header — a dev seam, not a login. Real auth
     gates *exposing* the app, not *building* it — but if the app will be deployed for real
     users, wire the OIDC seam from the start: the standard is a **separate OIDC issuer**
     (an Auth Server app in the same team, or an external issuer — Supabase/Auth0/AuthHero/
     Keycloak), never per-app credential storage. The vertical is a pure OIDC **relying
     party** per `docs/architecture/vertical-auth-detach.md`: depend on
     `@substrat-run/vertical-auth`, bind its `IdentityDO` (the `sub → principal` directory,
     TOFU owner claim, invites) as a third DO store, read the platform-delivered
     `substrat:auth` config per scope (`authWiring`), and build `oidcRpAuthProvider` per
     request — `demos/meridian/src/worker.ts` is the reference. The dashboard's New-app
     **Identity** section does the automatic half (dynamic client registration at the
     issuer + `/internal/configure` delivery) — but ONLY at app creation, and only for
     verticals that implement this seam. An install created without the identity choice
     stays `builtin`/unwired forever (switching issuers is deliberately create-time only);
     a starter worker whose `authenticatedPrincipal` returns null answers 401 to everything
     deployed, however many auth servers exist in the team.
   - **Deploy or stay local.** Local-first is a legitimate endpoint; default to it.
10. **Out of scope / deferred** — what you are deliberately not building, so the review is
    about a bounded thing.

End with a short **"Review questions for the human"** block (2–3 questions, mirroring
`engine-protocol.md`) — the things the user must actively confirm, not rubber-stamp.

---

## Step 4 — The design gate. STOP HERE.

**Present the design document and wait for approval. Do not scaffold, do not write code.**

This is a *human* gate, and it is the whole point of the reshape: it happens **before** any
code, upstream of the two implementation checkpoints in step 7. Walk the user through
section 4 ("who is denied what") in **their own vocabulary** until they can answer, without
your help: *who can see the money, and who can see other customers' data?*

**A gate assumes a competent reviewer.** If the user cannot evaluate the permission preview,
say so rather than letting them wave it through — a design nobody understands is theater,
and reproduces exactly the failure Substrat exists to prevent. Iterate the document until
they can, and only then take explicit approval.

Approval of the design is what unlocks step 5. Until you have it, you are still in design.

---

## Step 5 — Declare the model

The design is approved. Before any handler, declare **what exists** in `spec/model.ts`:
entities, the operations over them, and the permissions those operations check. One
TypeScript module, and the compiler checks the joins — a `parents` naming no entity, an
`entityIdFrom` naming no output field, a payload carrying an `erasable` field are all
compile errors, before a line of the module exists.

Full walkthrough: [The model](https://substrat.net/concepts/model). The short version:

```ts
export const entities = defineEntities({ … });          // table, fields, parents, primaryKey, key, erasable
export const PERMISSIONS = ['thing:manage'] as const;
export const operations = defineOperations(entities, PERMISSIONS, [engineEntities])({ … });
export const model = emitModel(entities);
```

Behaviour stays prose. If you find yourself inventing a way to declare a state
*transition*, the boundary has slipped — that belongs in the concept document.

Field names mirror the SQL columns, snake_case included; a prettier naming here is a second
description of the same rows. And not every table is an entity: an entity is something the
platform can point at.

`primaryKey` defaults to `['id']` — declare it where the identity is something else. The
side table you add for extra data on an engine's entity is keyed by *that engine's id*
(`primaryKey: ['workorder_id']`), and a value-keyed table by its values
(`primaryKey: ['customer_id', 'year', 'month']`). It is separate from `key`, which is an
additional uniqueness rule; a table legitimately has both. An entity with neither an `id`
field nor a `primaryKey` is refused rather than emitted without one.

A **composite** key means the entity cannot be pointed at: attachments, grants, `ctx.link`
edges and event subjects all need one id, so `parents`, `attachmentTargets`, `relations`,
`emits.entity` and a narrowed `permission.entity` are compile errors for such an entity. It
is still a full model member with migrations and a row type. A single-column key that is not
called `id` stays fully pointable.

**Do not edit `spec/model.ts` during the build.** If a handler cannot return what the model
declares, that is real information — say so and stop, rather than reshaping the model to
make the build pass. The model changes because the business changed, never to accommodate
what got built.

---

## Step 6 — Build it

The model is approved — now build it with the **new-vertical** skill
(`.claude/skills/new-vertical/SKILL.md`), which turns this design document into a working
vertical (the three module files, the seed world, the server, the API surface, the app
skin, the scenario test) against the Callout reference. Point it at the approved
`DESIGN.md` / `spec/concept.md` — it should translate the design, not re-derive the domain.

Two front-door cautions worth carrying in, because they are silent traps and easy to lose:

- **Import `z` from `@substrat-run/contracts`, never from `zod`; do not add `zod` as a
  dependency.** Zod schemas do not compose across copies or majors — composing a contracts
  schema into your own then fails at *runtime* with `expected a Zod schema`, pointing
  nowhere near the cause. Import the instance the schemas were built with and it can't
  happen: `import { z, entityRef, money, moduleManifest } from '@substrat-run/contracts';`.
- **The engines are self-describing — read them, don't guess.**
  `node_modules/@substrat-run/engine-workorder/dist/index.d.ts` is the reference for
  in-scope functions, `PERM` keys, and types. Read it before composing.

---

## Step 7 — Run it

(Steps 7–10 happen inside the build, after the new-vertical skill has scaffolded — they are
here so the whole arc reads in one place.)

Build confidence in this order, and **show the user the output of each**:

```sh
pnpm install
pnpm test                      # the scenario, including the denials
npx @substrat-run/boundary-lint # the layer rules — see the rules section
pnpm dev                       # API on :8871 (PORT=… WEB_PORT=… to move it)
```

Then **actually exercise it** — don't just report that the server started. Drive the real
flow with curl (create → assign → start → report → complete), switching `x-principal` to
show a denial landing. The moment the attack fails is the demo; make sure the user sees
it.

If they want a UI, scaffold a minimal Vite + React app under `app/` with a principal
picker in the top bar and typed wrappers over the routes. Ask first — it roughly doubles
the work and plenty of people want the API and their own frontend.

---

## Step 8 — The two checkpoints. STOP HERE.

These are the **code** checkpoints — the design gate (step 4) reviewed the *plan*; these
review the *implementation* against it. The permission diff here should hold no surprises
if section 4 of the design was approved; it is the same story, now in real permission keys.

**You may never self-approve these. Present them and wait.**

1. **Migration diff** — every new `SqlMigration`, verbatim. Once shipped they are
   append-only forever, so this is the last cheap moment to change your mind.
2. **Permission diff** — a table: key → description → which roles hold it → why.

Render the permission diff as a table the user can actually read:

| Key | Description | Roles |
|---|---|---|
| `repair:create` | Book a repair for a customer's bike | workshop-admin |
| `workorder:report` | Report time and materials | workshop-admin, mechanic |
| `bike:read-own` | See your own bikes (entity-narrowed) | portal-customer |

**A checkpoint assumes a competent reviewer.** If the user cannot evaluate this table, say
so rather than letting them rubber-stamp it — a permission diff nobody understands is
theater, and reproduces exactly the failure Substrat exists to prevent. Walk them through
it in their own vocabulary until they can answer: *who can now see the money, and who can
see other customers' data?*

---

## Step 9 — Deploy (optional)

Only if the user asks. Local-first is a legitimate stopping point.

Substrat runs on Cloudflare via `@substrat-run/adapter-cloudflare` (Durable Objects).
`demos/callout` and `demos/meridian` are the references for the Worker topology (own ScopeDO
+ IdentityDO). A vertical declares what it needs at runtime with a `substrat.runtimeNeeds`
block in `package.json` (stores, node-compat, build) instead of hand-authoring wrangler
config — though the demos still ship an authored `wrangler.jsonc` today.

**A SPA ships as NATIVE assets (#340) — never inline it into the worker.** Declare it in
`runtimeNeeds` and `substrat push` builds, hashes, and uploads the directory to the
runtime's own asset store, served from the edge without invoking the worker:

```jsonc
"substrat": {
  "runtimeNeeds": {
    "entry": "src/worker.ts",
    "build": "npm --prefix app install && npm --prefix app run build",
    "assets": {
      "directory": "app/dist",
      "notFoundHandling": "single-page-application",   // deep client routes → index.html
      "runWorkerFirst": ["/api/*", "/internal/*"]      // only these reach the worker
    }
  }
}
```

`build` runs before assets are collected, so the directory may be pure build output. The
old pattern of base64-inlining `app/dist` into a generated worker module (the CRM's
`gen-assets.mjs`) predates #340 — don't copy it into new verticals; it costs ~+33 % script
size and a worker invocation per image.

The deploy path is the authenticated CLI, and the author never holds a Cloudflare token:

- `substrat login` / `substrat whoami` — authenticate against the control plane.
- `substrat push` — push the vertical. By default the version is the registry's highest
  semver, patch-bumped; `package.json`'s version is only a **seed for the first push of a
  new slug**, and an explicit `--version` always wins. A **private** (tenant-owned)
  vertical is admitted automatically; a **listed/shared** one waits for staff admission.

**Let changesets own the version, and pass it to push explicitly** — the default bump walks
the registry forward on its own, so `package.json` and the registry drift apart within a
few deploys. Set this up when the vertical first deploys:

```sh
pnpm add -D @changesets/cli && npx changeset init
```

Then in `.changeset/config.json` add `"privatePackages": { "version": true, "tag": false }`
(the vertical is a private package, never npm-published), make sure `pnpm-workspace.yaml`
lists `packages: ["."]` so changesets can see the root package, and add the scripts:

```json
"changeset": "changeset",
"release": "pnpm test && pnpm typecheck && pnpm lint:boundaries && changeset version && substrat push --version $(node -p \"require('./package.json').version\") --promote prod"
```

Read the version with `node -p` at that point in the script, not `$npm_package_version` —
the latter is captured before `changeset version` rewrites `package.json`, so it would push
the version you just replaced.

The flow: record intent while working (`pnpm changeset`, patch/minor/major + summary);
release with `pnpm release` — gates first, then `changeset version` consumes the pending
changesets, bumps `package.json`, writes `CHANGELOG.md`, and the push deploys **that exact
version** and points prod at it. Changesets needs a git repo with a commit on the base
branch (`git init -b main`) — scaffolds that aren't repos yet must init before the first
release.
- `substrat promote <slug> --channel dev|staging|prod --version … [--ack-permissions]
  [--ack-migrations]` — the owner promotes every channel, **prod included**, for their own
  private vertical. Merge-to-main is the deploy.
- `substrat hostnames bind <slug> --surface <s> [--domain <d>]` — custom hostnames **are
  built**: with no `--domain` the platform mints a hostname that's live immediately; with
  `--domain` it records a custom domain pending DNS validation (`substrat hostnames verify`).
- Updates deploy **in place** from one stable script — data carries forward, migrations run
  against prod data, and backout is a time-boxed PITR rewind. `substrat scope pull` /
  `scope restore` export and reload a scope's data.

Before deploying: the `x-principal` dev header **must** be gone. It is a dev affordance,
and shipping it is a cross-tenant hole with a UI.

---

## Step 10 — Leave the project competent

Write a `CLAUDE.md` in the project root carrying the rules below plus the app's own
vocabulary, cast, and roles. This session has the skill loaded; **the next one won't** —
CLAUDE.md is what makes the next session competent, and it only loads at session start, so
write it before the user comes back.

---

## The rules (non-negotiable)

**Module code** = everything reachable from a `ModuleRegistration` (operations,
consumers). `seed.ts` / `server.ts` are harness and exempt.

1. **Data access is `ctx.sql` only.** Never import `better-sqlite3`, an adapter, or
   `node:*` in module code.
2. **No `fetch` / network in module code.** It would hold the scope's transaction open on
   a third party. The sanctioned path is a **connector** (Tier 2b) — emit a fat event,
   register a handler that runs outside the transaction. Never conclude an integration is
   impossible because of this rule; it has an answer.
3. **Never write `_substrat_*` tables.** Reads are fine (timelines are projections);
   writes forge the audit spine.
4. **Another module's tables are private.** Never `SELECT` from `workorder_*` — use the
   engine's exported in-scope functions. This is the rule that matters most and the one
   with **no runtime equivalent**: the shortcut *works*, returns the right rows, and
   silently welds you to an engine's private schema forever. Need extra data on an engine
   entity? Add **your own side table keyed by the engine's id** — never a column upstream.
5. **Every operation checks a permission first.** `assertAllowed(await ctx.check(PERM))`.
6. **Every mutation emits a fat event** — a consumer must never need a cross-module read.
7. **Never fork an engine.** Extend by composition. If you need to fork, the engine drew
   its line wrong — say so; that's design feedback, not a coding problem.
8. **IDs are `ulid()`. Money is strings** via `@substrat-run/contracts` helpers
   (`moneyOf`, `mulMoney`, `addDecimal`) — never floats.
9. **Web-standard APIs always** — `globalThis.crypto`, `TextEncoder`, `URL`. Never
   hand-roll a hash to dodge an import ban.
10. **Parse, don't trust.** Zod at every boundary — with `z` imported from
    `@substrat-run/contracts`, never from `zod` (see step 5).

Rules 1–4 are enforced mechanically. Run it, and believe it:

```sh
npx @substrat-run/boundary-lint
```

It exits `2` — not `0` — if it couldn't do its job (no module code found, or no engines
resolvable). A pass that checked nothing is worse than no linter, so never wave that
through: fix the setup until it can actually see your code.
