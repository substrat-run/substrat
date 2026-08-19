---
status: proposed
layer: plan
description: The prompt-to-app channel. Explicitly not scheduled.
---

# Generated verticals — the prompt-to-app channel

**Status:** proposed, not scheduled. Explores plan §7.4's "latent channel"; depends on
nothing, blocks nothing.
**What this is:** how a Lovable-class tool builds a Substrat vertical — the hosted debug
scope it iterates against, the CI gate that admits generated code to production, and the
five places this design is load-bearing enough to break.

Read alongside [master-plan](../master-plan.md) §7.4 (the channel), §5.6 (LLM-friendliness
as a design requirement), [kernel-design](kernel-design.md) §5.5 (deployment topology), and
[control-plane](control-plane.md) (the tenant/scope/entitlement surface this provisions
against).

**Sequencing, stated first so it is not mistaken:** plan §7.4 pins this as *strictly
post-operator-proof optionality*. This document exists so the option stays cheap and its
gotchas are known before someone proposes it as a quarter's work. It is not a case.

---

## 1. The frame: what the tool does and does not do

Three integrations were considered; only one survives the architecture.

| Shape | Verdict |
|---|---|
| Lovable calls a Substrat API; engines only, no vertical | **Impossible.** See §1.1. |
| Lovable generates vertical code that runs untrusted in production | **Rejected.** See §3.2. |
| **Lovable generates the vertical; it debugs hosted, ships through CI** | This document. |

The tool's output is a vertical's `module.ts` (manifest, migrations, operations) plus a
frontend. It never gains a path into a production isolate that CI has not admitted.

### 1.1 Why engines alone are not an app

Provisioning is already dynamic and needs nothing built: `createTenant` → `provisionScope`
→ `grantEntitlement(key)` per engine → `linkIdentity` is four implemented, audited,
contract-tested calls. Entitlements really do select an engine set per tenant — an
unentitled module's operations do not resolve (D-20).

But an engines-only scope cannot do anything. `workorderModule.operations` exposes `get`,
`list`, `assign`, `start`, `report-time`, `report-material`, `complete`, `close` — and **no
`workorder/create`**. `createWorkOrder` is an in-scope function only; `demos/callout` reaches it
through `callout/create-workorder`, which prices the order first.

This is not a gap. It is the three-layer rule in load-bearing form: the engine owns the
state machine, the vertical owns vocabulary and pricing, and the engine leaves a hole
exactly where the vertical belongs. `demos/callout/src/routes.ts` maps the seam precisely —
`assign`/`start`/`close` go straight to the engine; `create-workorder` and
`complete-workorder` (which needs billable lines priced) must route through `callout/*`.

**Configuration is dynamic; composition is code.** That sentence is the whole design.

## 2. The loop

1. **Generate.** The tool emits `module.ts` + `seed.ts` against the manifest surface and the
   `new-vertical` skill's spec. This is §5.6 and D-21 cashed in: agents are the primary users
   of this SDK, and the integration surface a Lovable-class tool needs is the same manifest +
   specs + MCP loop already built for Claude Code.
2. **Debug.** A hosted, ephemeral scope loads kernel + engines + the generated module,
   seeded with a fake world. Dev-header auth (`devHeaderAdapter`, still present in
   `demos/callout/src/auth-adapters.ts`). Throwaway, no real bindings, no directory reach.
3. **Iterate.** The tool regenerates against the debug scope until the user is satisfied.
4. **Ship.** The candidate enters CI (§5). Lint, typecheck, contract tests, the scenario
   test, the migration replay check — then the two human checkpoints.
5. **Provision.** On admission, the module is bundled into a deployment and the control
   plane mints the real tenant, scope, entitlements, and identity links.

Debug is instant and unlimited. **Ship is not**, and §6.1 is about why that is the design
rather than a defect.

## 3. The debug scope is a facet

### 3.1 The facet is a scope

[Durable Object facets](https://developers.cloudflare.com/dynamic-workers/usage/durable-object-facets/)
load dynamically-generated code as a child of a parent DO, with its own SQLite database, in
milliseconds. Cloudflare's requirement is that the Dynamic Worker export a class declared
`extends DurableObject`.

`defineScopeDO(modules, bareOps)` already returns exactly that — a scope-DO class built from
a module list at runtime. The debug worker is roughly five lines: import the engines, import
the generated module, `defineScopeDO([...engines, generatedModule], {})`, export it.

The mapping: **the facet's own SQLite database is the scope's database.** Engines and the
generated vertical share it, so composition is untouched; facets use the normal
`ctx.storage.sql`, which `ScopeDO` already assigns, so `ctx.sql` stays synchronous. And the
facet cannot read the supervisor's database — the directory becomes unreachable from
generated code *by the platform*, which is K-8's "never a raw DO namespace binding" upgraded
from a convention the lint watches to a property of the runtime.

Debug then runs on the actual production runtime. Parity is by identity, not by D-14's
two-adapter argument.

### 3.2 Why the vertical is never isolated from the kernel — and why this stays in the build phase

The obvious design — supervisor holds kernel + engines, facet holds the generated vertical —
is wrong, and the contract says why. `ScopedSql.query` returns `T[]`, **not** `Promise<T[]>`,
and every engine in-scope function is sync on top of it (`createWorkOrder(ctx, input):
WorkOrder`). Any cross-isolate hop forces `ctx.sql` async, changing the signature of every
in-scope function in every engine and every vertical composing them. That is a rewrite of the
kernel contract, not a tweak. Separate databases would also delete the same-transaction
composition that makes a vertical a vertical.

So the vertical shares an isolate with the kernel, the engines, and `_substrat_outbox`. Which
means **facet isolation cannot make untrusted verticals safe in production**: the wall lands
between the facet and the directory, while the things worth protecting — the spine, the
engines' invariants — sit *inside* the facet next to the untrusted code, where it can
monkey-patch the kernel and forge events. R4 is `boundary-lint`, and lint is static analysis.

Debug works because **nothing inside the debug facet is worth protecting**. The property that
makes facets right here is the property that makes them useless for production trust. For
production, the answer is unchanged: trust the code, and earn the trust at the CI gate.

### 3.3 Fallback

The Sandbox SDK (GA) running the `demos/callout` topology — `tsx src/server.ts` on
`adapter-sqlite` — is the documented fallback. It needs no bundler (`tsx` runs generated TS
directly) and no beta feature, at the cost of container cold-starts and parity-by-D-14
instead of parity-by-identity. `adapter-sqlite` is already scoped for exactly this ("local
dev, CI, self-host") and `demos/callout` already proves the shape.

## 4. The API is the manifest

**Do not generate routes.** `demos/callout/src/routes.ts` is ~160 hand-written lines of thin
wrappers; a generated vertical needs none of it. `ScopeStub.invoke(operation, input)` is
already a uniform RPC surface, so one endpoint — `POST /api/op/:name` → `stub.invoke(name,
body)` — exposes every registered operation with no per-vertical route code.

This is safe by construction rather than by care. A generic endpoint exposes engine
operations directly, but every operation's first line is `assertAllowed(await
ctx.check(PERM))` and the entitlement gate sits on the same path. **Exposure is not
authorization**, so a uniform invoke surface weakens nothing.

The manifest — operation names plus their Zod input schemas — is then the API description the
frontend generates against. No OpenAPI to maintain, no route layer to drift.

## 5. CI is the admission gate

The gate is mostly built: `boundary-lint` (R1–R5), `pnpm typecheck`, `contract-tests`, the
scenario-test pattern. Two additions:

- **`boundary-lint` needs the candidate in the workspace.** It walks the repo and builds its
  table-owner map from every `CREATE TABLE` in every package's `src`, so R5 cannot judge a
  module linted standalone. Drop the candidate in; lint everything.
- **The migration replay check** (§6.2).

**This is where CLAUDE.md's two human checkpoints finally live.** The migration diff and the
permission diff have had no home. A machine-generated vertical is the strongest possible
argument for them, because nobody read the code. Static analysis is the right tool for
admitting code you are about to compile into a trusted deployment — the thing it cannot do
(stop malicious runtime behavior) is the thing the human diff behind it exists to catch.

## 6. Gotchas

Ordered by how much they hurt, not by when they appear.

### 6.1 Who reviews the permission diff?

**The deepest problem, and it is not technical.** A smooth prompt-to-app experience ends at
a human review gate. If the human is the Lovable user, the checkpoint is a rubber stamp: a
non-technical builder clicking approve on a permission diff they cannot evaluate. That
reproduces the exact failure this platform exists to prevent — §2's "the very thing vibe
coders misconfigure," CVE-2025-48757, the ~10% of Lovable apps with world-readable tables —
with extra ceremony. A checkpoint assumes a competent reviewer; it is theater without one.

Three ways out, none free, and this must be answered before the channel opens:

1. **Substrat staff review every promotion.** Meaningful, and a support surface the vertical
   play does not have (§7.4 says exactly this). Does not scale, which may be correct early.
2. **Constrain the generated surface** so approval is cheap to evaluate — permissions and
   roles drawn from a fixed template vocabulary rather than invented per app. A diff a
   layperson *can* read. Narrows what can be built.
3. **Sell the review.** The hardening consultancies §7.4 names as the cheaper first channel
   are the competent reviewer, and promotion review is their product.

Do not open this channel without picking one. "The user approves their own diff" is the
default that arrives if nobody decides, and it is the one that voids the thesis.

### 6.2 Regeneration versus append-only migrations

**The hard technical one.** Prompt-to-app tools regenerate from the prompt; Substrat appends
migrations and never edits a shipped version. `demos/callout` ships `0001-init`,
`0002-protocols`, `0003-protocols-to-engine` — an evolution history.

First ship is free: squash all debug churn into `0001-init`. The debug versions were never
shipped, so nothing is edited. **The promotion boundary is exactly where migrations freeze**,
which is clean and worth stating as the rule.

Ship two is a different problem. Against real tenant data, the generator can no longer emit a
schema — it must emit a *delta* against a shipped list it did not author, and never touch
what is there. That is not a blank-page generation and a regenerating tool is bad at it.

**Mitigation: replay.** CI replays `0001..000N` from an empty database and compares the
result to the schema the module's code expects. A wrong or history-rewriting migration
diverges and fails. This makes a generated migration *checkable* rather than *believed* —
the same move the kernel makes everywhere else.

**Scope v1 to first-ship.** "Generate, debug, ship once; subsequent edits take the normal
vertical path" is honest and achievable. Promising regeneration forever is a research
project.

### 6.3 The channel succeeding breaks §5.5

§5.5 pins one kernel-runtime deployment per vertical. That is right for a handful of
verticals owned by companies you know. **A Lovable user is a vertical owner** (§5.1: the
tenant is the business; the vertical is the product over it) — so N deployments = N generated
apps. The topology does not survive its own success: open question 9 (orchestrating N
deployments) stops being "the next hard problem" and becomes a day-one blocker at thousands.

This is where §3.2's deferral comes back. Facets-as-generic — one supervisor, N
independently-versioned vertical bundles — is the shape that does 10,000, and it dodges all
three of [control-plane](control-plane.md) §1.1's objections to merging deployments
(migrations stay per-facet; code blast radius stays split across Dynamic Worker versions;
each bundle pins its own engine versions, making per-vertical upgrade cadence *structural*).
§1.1 argued against one bundle with every vertical compiled in; it did not consider this.

Not a recommendation — it re-architects §5.5 on a beta, does not buy the trust property that
would justify it, and leaves the spine's read paths unresolved (the supervisor cannot read
the facet's database, but `_substrat_outbox` and `_substrat_migrations` live there, so the
Tier-2 drain, §5.4's admin-query RPC, and migration sweeps all route through facet code; it
is also unknown whether facets support alarms). **But it is the honest cost of this channel
working**, and building the debug loop on facets first buys operating experience before the
expensive call.

### 6.4 The rest

- **Facets are open beta** (Workers Paid, announced Agents Week April 2026); Sandboxes went
  GA at the same event. Acceptable *here* and only here: beta carries the throwaway debug
  loop, never a paying tenant. Production scopes stay on the compiled `ScopeDO`. If facets
  change or vanish, the trial funnel breaks for a sprint — nobody's data does. The beta risk
  is contained by the same boundary as the trust risk, which is not a coincidence: nothing
  unreviewed crosses into production.
- **Dynamic Workers price on "unique Dynamic Workers created per day."** A regenerate-per-
  keystroke loop is a cost bug. Debouncing is a design input, not an optimization.
- **A build step is required.** Dynamic Workers take JS modules, so generated TS needs
  esbuild in the loop. The Sandbox fallback gets `tsx` for free — the fallback's one real
  advantage.
- **`boundary-lint` is not a sandbox.** It is static analysis and generated code can ignore
  it at runtime. Correct as an admission gate; never the runtime guard. Debug still wants
  egress control (a Dynamic Workers config flag) and no secrets in the isolate.
- **Auth changes at the boundary.** Dev-header in debug, Better Auth + `linkIdentity` at
  promotion. The generated frontend must not bake in the dev seam — `control-plane` §6's
  rule holds: real auth gates *exposing*, not *building*.
- **The engines are AGPL.** A generated vertical bundles them; production needs a commercial
  license. Hosting the debug loop keeps that surface yours (§7 below).

## 7. Why we host it, and not the tool

`adapter-sqlite` needs a real Node container: native `better-sqlite3`, `node:fs`, `node:path`,
and a filesystem it `mkdirSync`s per scope. Whether a given tool's sandbox can run that is an
empirical question worth one afternoon — but the answer does not matter, because two other
reasons decide it:

- **Licensing.** Engines running in a third party's container, served over a network, is the
  AGPL surface being exercised where you cannot see it.
- **Metering.** §9's meters compute off the directory. A debug scope you do not host is a
  scope the control plane never sees — no funnel, no meter, no promotion path. If CI
  admission is the gate, the loop leading into it should be yours.

## 8. Consequences

- **Nothing here is on the critical path**, and §7.4's sequencing stands. The cheapest lever
  for lowering the bar remains the `new-vertical` skill and templates, which serve the
  operator proof too.
- **This channel is a forcing function for the console.** §6.1's review gate is a screen
  someone has to click — [control-plane](control-plane.md) §4.5 item 4, the permission diff.
- **The debug loop is reversible; the fleet answer is not.** Build §2–§5 if the channel is
  ever tried. Do not let it decide §6.3 by accident.
