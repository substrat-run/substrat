# Why Substrat — the honest version

> A sales page that only lists strengths is a document nobody trusts twice. This one labels
> every claim, names the competitors that are genuinely better at things, and keeps a
> section for where Substrat is the wrong answer.
>
> Companion to [master-plan.md](master-plan.md) (§4 enforcement, §7 landscape, §10 risks).
> Where the two disagree, the master plan wins and this file is stale.
> Last updated: 2026-08-18.
>
> **This file is the source, not the publication.** It says things a public page should not
> — venture risk, named customer concentration, unreleased work — so it stays here and feeds
> four pages on [substrat.net](https://substrat.net) instead:
>
> | section here | published as |
> |---|---|
> | §2 the framework perks, the second opinion, bring-your-own-model, ship-and-verify | [`guide/ai-agents.md`](../apps/docs/guide/ai-agents.md) |
> | §3 how it compares | [`guide/comparisons.md`](../apps/docs/guide/comparisons.md) — the scanning table + the frameworks neighbour |
> | §4 wrong tool · §5 weaknesses · §6 what competitors have | [`guide/what-substrat-lacks.md`](../apps/docs/guide/what-substrat-lacks.md) |
> | §1 the claim, and the recurring objections | [`guide/faq.md`](../apps/docs/guide/faq.md) |
>
> When a claim here changes, the published page is the thing that has gone stale.

## Honesty rules for this file

Every claim carries one of three labels. Nothing goes in unlabelled.

- **[shipped]** — it exists in this repo, it is exercised by tests or by a running
  deployment, and you can go read the code today.
- **[built, unproven]** — the code exists and works, but it hasn't survived the load,
  the customer count, or the second use case that would make it a fact.
- **[bet]** — a design position we believe and have not yet earned the right to assert.

---

## 1. The claim in one paragraph

AI made building vertical B2B software fast, except for the parts that were never about
writing code: multi-tenancy, identity, permissions, integrations, data integrity, audit,
GDPR. Those are exactly the parts LLM-generated code gets wrong most often and the parts
where being wrong is catastrophic rather than cosmetic. Substrat is a hosted substrate that
owns them and enforces them *below the API surface* — so it stops mattering who, or what,
wrote the code above it.

## 2. What is genuinely good about it

### The framework perks, kept — not traded away for the guarantees

The usual trade for runtime guarantees is giving up the things a good framework gives you.
We didn't take that trade — this is the Wasp/Rails column, and we keep all of it:

- **Deterministic generation wherever determinism is possible.** Entities are declared once;
  [`@substrat-run/model-emit`](../packages/model-emit) emits the DDL from that declaration,
  and `pnpm lint:model --check` gates the emitted `model.json` in CI. Code generated *by
  code* beats code generated *by a model* on three axes at once — tokens, latency, and
  exactness — and the artifact left behind is smaller, which makes it easier for a human
  and an agent to hold in context. The model isn't just cheaper to produce; it's cheaper to
  reason about forever after. **[shipped]**
- **Auth you never write.** Verticals are OIDC-only against a shared relying party
  (`@substrat-run/oidc-rp`, `@substrat-run/vertical-auth`) with a per-tenant identity DO
  handling owner-claim and invites. Pre-vetted once, reused everywhere — not regenerated,
  slightly differently and slightly wrong, per app. **[shipped]**
- **Run it locally, own the code.** The whole stack runs on the pure-SQLite adapter — CI
  proves it on every commit — and the same vertical deploys to Cloudflare with only the
  adapter beneath differing. **[shipped]**, with the licensing said plainly: contracts are
  Apache-2.0, kernel/adapters/engines are AGPL + commercial with escrow. "Open source" here
  means copyleft and inspectable, not permissive.
- **Connectors instead of hand-rolled integrations.** Third-party access is a connector
  interface; credentials never enter vertical code. **[shipped as a mechanism; the
  catalogue is thin]** — one production connector today. The pattern is proven, the library
  isn't there yet.
- **Migrations are the platform's job.** Append-only ordered `SqlMigration[]` per module; on
  a version update the vertical runs its own migrations inside a fail-closed path, with a
  PITR bookmark taken first and per-scope rewind available for ~30 days. *Version 2 landing
  on version 1's live data is the single most common way a generated app dies* — here it's a
  reviewed diff plus a rollback path, not a hope. **[shipped]**
- **One model, many surfaces.** The router resolves `hostname → (tenant, scope, vertical,
  surface)`, so a storefront and a back office — or a player app and a manager console — are
  two apps over **one model and one source of truth**, not two databases and a sync job. The
  shop demo runs exactly this shape. **[shipped]**

### Ship-and-verify machinery: every PR gets a running copy of production

The single most common way a generated app dies is version 2 meeting version 1's live data.
This is the machinery that makes that survivable, and it is **[shipped]**, not planned:

- **Per-PR previews against a fork of prod data.** Open a PR and the platform forks the
  production scope, binds the version that PR just pushed, gives it its own hostname
  (`<label>--<tag>.<base>`), and posts the URL on the PR; closing the PR reaps it. Successive
  pushes to the same PR are idempotent on `(tenant, vertical, tag)` — they roll their
  migrations *forward on one copy*, exactly as a real upgrade would — while `refresh` forces
  a clean fork and `empty` provisions a clean-room scope for a vertical that has no prod to
  copy yet. Forks GC after 72h by default; `ttlHours: null` pins a long-lived environment.
- **Fork-before-promote, gated by digest rather than by intention.** When a bind crosses a
  **migration-digest boundary**, the pre-migration data is snapshotted first. The digest
  comparison is the gate — not a flag someone remembers to pass — so the safety net is on
  precisely when it matters and absent on a code-only rebind.
- **Why this is hard for everyone else.** Neon, PlanetScale and Vercel all branch a
  *database*; none of them run *your code* against the branch. Substrat can because the
  scope-host contract already runs identical module code on two adapters, and a scope is
  already the unit of consistency. The feature falls out of the architecture instead of
  being bolted onto it.
- **Plus the operational surface around it**: per-tenant observability (builders reach logs
  and metrics through a proxied read surface, because the platform holds the Cloudflare
  credential and they never do), declared per-version env specs resolved per scope, and
  per-scope PITR for ~30 days underneath all of it.

Reviewing a migration diff is a human checkpoint. Clicking a URL on the PR and *watching that
migration run against a copy of the real data* is what makes the checkpoint honest.

### The second opinion — two descriptions that can disagree

This is the quiet one, and it may be the most valuable thing in the stack. The models are
fantastic and *inconsistent*: they don't fail loudly, they make many small mistakes. You
cannot prompt that away, so the architecture has to catch it.

- **Every defect worth catching is two descriptions disagreeing.** Once the implementation
  is derived from the model, the code is a *function of* the model and can no longer
  contradict it. So the second description has to be the tests — and they are only a second
  description if they were written from somewhere else. **[bet, and a well-tested one]**
- **So the direction is load-bearing: code comes from the model, tests come from the
  concept.** The concept is the human-approved prose; the model is the typed declaration.
  Two independent derivations of the same intent, and the disagreement between them is the
  entire product. `apps/builder/skills/scenario.md` states it as a rule an agent cannot
  quietly skip: *"Tests come from `spec/concept.md`. Never from `spec/model.ts`, and never
  by reading code that does not exist yet."* **[shipped]**
- **A suite written after the handlers can only agree with whatever got built.** It will
  pass, it will look thorough, and it will ratify a wrong model perfectly and forever. That
  is the failure mode every AI-generated test suite has, and almost nobody names it.
- **The mechanical rule that keeps it honest:** literal inputs, literal outputs, import
  nothing from `spec/`. A test that builds its input from the schema it is meant to judge
  *cannot* disagree with that schema — it's the mirror again, one level down.
  **[built, not yet in CI]** — `tools/test-independence.mjs` is committed and
  `pnpm lint:tests` runs it, but `ci.yml` does not, so the discipline is still instruction
  plus a local gate rather than a red build. That's a one-line gap, not a design gap.
  (`pnpm lint:docs --check` went into CI with #750; this one should follow it.)
- **The build may not edit its own oracle.** Tests are written and approved *first*; the
  build's job is to make them pass. And if the concept doesn't say what should happen, that
  is a gap in the concept — the agent says so and stops, rather than inventing an answer and
  thereby making it agreed. **[shipped]**

### Bring your own model, bring your own agent

- **You are not locked into someone's prompt box.** Design and build run in *your* Claude
  Code against repo skills, and the hosted builder runs against a model you choose — we
  measure skill/model/harness changes with a frozen fixture sweep (`pnpm builder evals`)
  rather than guessing. Your tokens, your model, your agent. **[shipped]**
- **And the code is on your disk, running locally.** That's the difference in kind from
  Lovable or Floot: not "export a zip that dies without our SDK", but a repo that boots
  against SQLite with no platform in the loop. **[shipped]**

### Enforcement is structural, not configured

- **A vertical cannot reach another tenant's data, because the reach doesn't exist.**
  Data access is `ctx.sql` inside a scope-owned Durable Object that validates the caller
  against its own ACL. There is no connection string to misconfigure and no RLS policy to
  forget. **[shipped]**
- **The escape hatches are lint errors, not code review notes.** `node tools/boundary-lint.mjs`
  blocks raw DB imports, `fetch`, `node:*`, and writes to `_substrat_*` tables in module
  code, and blocks one module reading another's tables. CI runs it. **[shipped]**
- **This is the one property that survives model improvement.** Even an AI that writes
  flawless tenancy code doesn't solve the *trust* problem — someone still has to underwrite
  that isolation and audit hold structurally. **[bet, and the central one]**

### Guarantees that are usually retrofitted, and usually can't be

- **Two-level tenancy (tenant → scope) with tree-shaped permission inheritance**, designed
  in from commit one. Retrofitting nested tenancy onto a single-org product is close to a
  rewrite; every incumbent in §7 that has tenancy at all has one level. **[shipped]**
- **GDPR erasure that reaches the copies you cannot rewrite.** Per-subject data keys +
  crypto-shredding, with a tombstone so a destroyed key is never re-minted — because a
  backup that can restore is exactly a backup a DELETE cannot reach into
  ([subject-keys.ts](../packages/kernel/src/subject-keys.ts)). Most platforms' "GDPR
  support" is a delete button that quietly excludes backups. **[shipped]**, and further than
  the mechanism: `POST /tenants/:t/scopes/:s/subjects/:id/shred` redacts the spine payloads
  and destroys the sealing key in one audited, idempotent call, returning a **receipt the
  DSAR response is written from** — because an erasure that records no proof it happened is
  not a fulfilled DSAR. Deliberately staff-only rather than self-serve: a builder forwards
  the request and the platform executes it, since letting a vertical destroy evidence about
  a person on its own authority is a different decision than this one.
- **Audit is not opt-in.** Events are emitted below the API surface; a mutation that skips
  the log is a mutation that didn't happen. **[shipped]**
- **Credentials never reach vertical code.** Third-party access goes through connectors;
  verticals see an interface, not a token. A declared per-version egress allowlist bounds
  outbound traffic. **[shipped, with a documented gap: DO subrequests]**

### Built for agents on purpose, not marketed at them afterwards

- **A vertical declares what exists — entities, operations, permissions — in one typed
  module, and the compiler checks the joins.** A parent naming no entity, an `entityIdFrom`
  naming no output field, a payload carrying an erasable field: compile errors, not runtime
  surprises ([model.ts](../packages/contracts/src/model.ts)). Agents fail loudly and early,
  which is the only failure mode that composes with generation. **[shipped]**
- **Two human checkpoints that agents cannot self-approve**: migration diffs and permission
  diffs. The permission one has a mechanical home — `pnpm lint:permissions` re-emits each
  vertical's `PERMISSIONS.md` and CI fails on drift, so a widened role cannot merge without
  showing up in the PR. **[shipped]**
- **Everything else is mechanically gated too**: `lint:model`, `lint:api` (OpenAPI drift),
  `lint:boundaries`, contract tests, per-demo scenario tests. **[shipped]**

### Portability is a discipline, not a promise

- **Two adapters, one suite.** `adapter-sqlite` (local, CI, self-host, escrow) and
  `adapter-cloudflare` (Durable Objects + D1) pass `@substrat-run/contract-tests`
  *unchanged*. The flagship demo deploys from local SQLite to Cloudflare with only the
  adapter beneath differing. That's a much harder claim than "we're portable" and it's
  green in CI. **[shipped]**
- **Nothing in the runtime is vendor-specific, and that's checkable rather than claimed.**
  `@substrat-run/kernel` has exactly **one** dependency — the contracts package. No
  Cloudflare imports, no `node:*`, no ORM. `vertical-host` adds Hono and nothing else. The
  rule underneath is mechanically enforced: web-standard APIs only (`globalThis.crypto`,
  `TextEncoder`, `URL`), and `boundary-lint` fails the build on a `node:*` or adapter import
  in module code. Portability usually rots because one convenient import sneaks in; here the
  import is a red build. **[shipped]**
- **So a third adapter is a real option, not a thought experiment.** Write a scope host over
  Postgres, or over your own Kubernetes cluster in your own datacenter, make
  `@substrat-run/contract-tests` pass, and your verticals run there unchanged — same module
  code, same engines, same permission checks. The suite *is* the specification of what an
  adapter must do, which is why the port is a bounded job rather than an archaeology
  project. **[bet — the two existing adapters make it credible; nobody has written a third]**
- **You own the code.** Contracts are Apache-2.0; kernel, adapters and engines are
  AGPL + commercial with escrow. Compare: OutSystems' one-way .NET detach, Base44 exports
  that die without the SDK. **[shipped]**
- **What that does and does not cover, said plainly.** It covers the thing that matters for
  sovereignty and escrow: if the hosted platform disappeared tomorrow, a customer's vertical
  still runs — the runtime it needs is published, AGPL, and provably portable. It does not
  cover the *platform* — the router, control plane, dashboard and builder are `private: true`
  and Cloudflare-native, so "run all of Substrat in your datacenter" is not on offer today.
  The verticals are portable; the hosting product is not.

### Domain machinery nobody else ships as a platform module

- Work orders, invoicing, protocols/checklists, booking, absence, metering, invites — as
  headless engines that own their invariants, in a star topology (engines never import each
  other). Platform companies don't ship a work-order engine because they lack the vertical
  operators to derive one from. **[built, unproven]** — the engine-reuse-without-forking
  hypothesis is the plan's least-proven, by its own admission (master-plan §3).
- **Does anyone else have this? Nearly, and instructively not quite.** *Medusa v2* modules
  are the closest architectural relative and independently converged on the same isolation
  rules — but e-commerce only. *Odoo* and *Frappe/ERPNext* have the biggest module
  ecosystems on earth, but their modules are customized per customer and forked in
  practice; Frappe's everything-is-a-DocType metadata model is the dynamic-schema pole we
  reject outright. What none of them ships is a **versioned domain module that enforces its
  own invariants and that a vertical extends by composition rather than by forking**. That
  gap is real — and it is real partly because it's hard, which is why the bullet above is
  labelled unproven and not shipped.

## 3. How it compares

Read the table as "what each product optimizes for", not as a scoreboard. Several of these
are better than Substrat at what they set out to do.

| Product | What it really is | Where it beats Substrat | Where Substrat differs |
|---|---|---|---|
| **Salesforce Platform** | Enterprise app platform + walled-garden trust | Ecosystem, certifications, integrator army, indemnification, AI app gen at the top of the market | Code-first, EU-hosted, SME-priced, you own the code; Apex defaults to *system* mode — enforcement contingent on the developer |
| **Microsoft Dataverse** (+ Power Apps) | Proprietary data platform with runtime-enforced security roles, under Power Platform and Dynamics 365 | The most mature RBAC in this table by a distance — row *and* column security, business-unit hierarchies, team ownership, audit built in, enforced by the platform for every client. Plus an ecosystem and an enterprise sales motion we don't have | Business units are *internal org structure inside one tenant*, not tenancy for selling SaaS to many customers; per-user licensing lands on your customer, which breaks vertical-SaaS economics; proprietary model, Azure-hosted, no eject, agent-hostile |
| **Floot** | AI app builder: prompt → full-stack app with auth, DB, hosting ([floot.com](https://floot.com)) | Time-to-first-app for a non-technical founder; single subscription across many apps; draw-to-build | No tenancy tree, no audit spine, no local run, and no way to watch v2's migrations run against a fork of real data before they run against the real thing — Substrat code boots on SQLite with no platform in the loop |
| **Lovable / Bolt / Replit** | Prompt-to-app | Enormous distribution, polish, iteration speed, genuinely delightful | The 70% problem is structural: CVE-2025-48757 saw ~10% of analyzed Lovable apps readable via the public anon key. Their remedy is *scanning* — checking policies exist, not that they hold. And here you bring your own model and your own agent, on code that runs locally |
| **Base44 (Wix)** | AI-native app builder with auth/roles/RLS as **platform primitives** | Nearest AI-native articulation of the same idea, with a real product and real users | Single-app shaped (no tenancy tree, no engines, no B2B SaaS shape), weakest portability in the field, and its own auth was bypassed in 2025 (Wiz) |
| **Ruby on Rails** | The reference full-stack framework | Maturity, ecosystem, hiring pool, 20 years of answers to every question; Rails + a good team beats Substrat on almost any *single*-tenant app | Rails gives you conventions; conventions erode with every LLM edit. No tenancy, permissions, audit, or GDPR machinery below the app — that's yours to build and keep correct |
| **Wasp** ([wasp.sh](https://wasp.sh)) | Rails-for-JS/TS: declarative spec → React/Node/Prisma app; since June 2026 the spec is TypeScript | Excellent DX, open source, no hosting lock-in, strong AI-coding compatibility, and Open SaaS as a template | Convergent instinct (a typed spec the compiler checks — Substrat's `model.ts` rhymes with it), opposite depth: Wasp is a framework you deploy, Substrat is a runtime that enforces — and we keep Wasp's own perks (deterministic generation, pre-vetted auth, local run, connectors, migrations) rather than trading them for the guarantees |
| **Baseplate.dev** | Deterministic codegen you eject from | Zero lock-in, literally its proudest feature | Exact opposite pole: they generate the foundation and leave; we are the foundation and stay |
| **MakerKit / ShipFast / Open SaaS** | Boilerplates, $199–649 one-time | Unbeatable economics if the guarantees can be conventions | Guarantees erode with every edit; no nested tenancy, no provisioning, no engines |
| **Supabase / Convex** | BaaS | Better DX, bigger ecosystem, far better for app-shaped products | App-shaped, not vertical-SaaS-shaped; RLS is precisely the foot-gun that produces the CVEs above |
| **Retool / Superblocks** | Internal tools with governance | Owns the internal-tool shape outright — genuinely better there | No nested tenancy for *selling* SaaS; runtime-locked; US-hosted |
| **OutSystems / Mendix / Power Apps** | Enterprise LCAP | Genuinely solve permissions, audit, governance as a hosted platform, and prove the willingness to pay (~$36k/yr entry) | Proprietary visual model: agent-hostile, internal-app-shaped, single-level tenancy, no usable eject |
| **Odoo / Frappe** | Platform-with-modules | Vast module ecosystem; a real business today | You inherit their ORM, worldview, and upgrade treadmill (Community has *no* vendor upgrade path); single-org shaped |
| **Medusa v2** | E-commerce with strict module isolation | Independently converged on the module/engine model, shipping in production | E-commerce-scoped, no native multi-tenancy, no enforcement layer |
| **8090** ([8090.ai](https://www.8090.ai/)) | AI-native *software factory* for regulated enterprises: plain-English intent → production code in a governed workspace; $135M Series A led by Salesforce Ventures | Governs the **build process** — a knowledge graph of requirements, decisions and context feeding agents structured input instead of ad-hoc prompts, plus reverse-engineering agents that build that graph from existing code (they cite an 18M-line Medicare claims system). We have none of that for brownfield | Different axis, not a competitor: they audit *how the code came to exist*, we enforce *what the running system cannot do*. Their ICP is Fortune-500 regulated modernization with a services arm; ours is SME/midmarket EU vertical SaaS |
| **DIY: WorkOS + Nile + Nango + Inngest + Stripe** | Assemble the substrate yourself | Best-in-class at each piece; no platform bet | Every seam between them is yours to keep correct forever, and none of them enforces anything about the code above |

**What none of the AI builders in this table have** is an oracle independent of the code
they generate. Lovable, Floot, Base44 and friends generate the app and the tests from the
same act of generation — so the tests inherit the same misunderstanding and pass. Wasp and
Rails don't generate your tests at all, which is honest but leaves the second opinion to
your discipline on a Friday afternoon. Deriving code from the model and tests from the
concept is cheap, and it catches the exact failure mode — small, confident, inconsistent
mistakes — that makes generated systems untrustworthy.

### The one-line version

The market forces a three-way choice: **governance without code** (LCAP — safe, proprietary,
agent-hostile, $36k+/yr), **code without governance** (BaaS, boilerplates, prompt-to-app —
agent-friendly, every catastrophic mistake yours), or **both at enterprise prices inside a
walled garden** (Salesforce/ServiceNow). Substrat is governance as a runtime substrate
*under code you own*, agent-first, EU-hosted. **[bet: that this intersection has buyers]**

## 4. Where Substrat is the wrong tool

Kept explicit so the boundary stays reviewable (master-plan §7.9). These are "no"s, not
missing features:

- **Enterprise applications proper** — that tier buys walled-garden trust; code-ownership
  is the wrong trade there.
- **Data- or scale-heavy single tenants** — the scope-per-customer shape caps around 10 GB
  of hot state per scope.
- **Deep-domain-moat products** — accounting, payroll, core banking. Integrate, never rebuild.
- **Products whose foundation isn't the binding constraint** — consumer apps, ML-first,
  realtime-collaboration-first, dev tools.
- **Internal tooling** — Retool and Power Apps own that shape.
- **A general prompt-to-app backend** — the median generated app has no tenants, and
  unopinionated wins there.
- **Anything single-tenant and simple** — Rails or Wasp will beat us, and it isn't close.

## 5. The honest weaknesses

- **Engine reuse across verticals has no field precedent.** Nobody has shown hardened
  domain engines shared without forking. Two disciplines de-risk it (engines are *extracted*,
  never designed up front; the placement spectrum bounds what may become one) — but it's
  still the plan's least-proven hypothesis.
- **Single-vendor runtime concentration.** The hosted path is Cloudflare end to end. The
  adapter rule and the always-green SQLite adapter are the mitigation, not a denial.
- **Bus factor.** Design, taste, both human checkpoints, and the source assets concentrate
  in one person. Escrow protects consumers, not the venture.
- **Demand is one relationship deep.** Cases route through a single owner group of ~five
  companies that share owners — so they wobble together.
- **The platform trap is always one feature away.** Kernel features nobody consumes yet are
  the trap announcing itself; the one-step-ahead rule is the discipline against it.
- **Enforcement is a slow argument.** It asks a buyer to follow a claim about runtime
  architecture before they can price it. Inherited certification is the version a
  procurement officer prices in one sentence — and it isn't there yet.
- **The DO-subrequest egress gap is real.** Don't call the sandbox airtight; it isn't yet.

## 6. What the competitors have that we don't

Asked directly, and answered without flinching. Three columns of status, because "we chose
not to" and "we haven't got to it" are different admissions and blurring them is how these
documents start lying.

| Capability | Who has it | Our status |
|---|---|---|
| **Integration catalogue** | Power Automate (1000+ connectors), Zapier, Nango (400+) | **Genuine gap, and the most practical one.** We have one production connector. The framework is right; the library is a rounding error |
| **DSAR *access-request* export** (Art. 15) | Anyone selling GDPR compliance as a feature | **Half-built, and it's the visible half.** Art. 17 erasure is shipped with a receipt; the Art. 15 export that answers *"what do you hold about me"* is not, and neither half has a UI. The asymmetry is odd from outside — we do the cryptographically hard part and not the part a customer actually asks for first |
| **Certifications** (SOC 2, ISO 27001, HIPAA, FedRAMP) | Salesforce, Dataverse, OutSystems — and *Lovable*, which shipped SOC 2 + ISO 27001 | **Genuine gap, and the sharpest one relative to our own pitch.** We sell trust and cannot yet hand a procurement officer the one page that prices it. Master-plan D-32 knows this |
| **End-user report / dashboard builder** | Salesforce, Odoo, Retool, Power BI | **Deliberate refusal** (master-plan §6: "resist configurability until a customer pays for it") — but it *will* lose a bake-off against Salesforce, and knowing why doesn't make the demo go better |
| **No-code admin customization** | Salesforce Flow, Odoo Studio, Dataverse | **Deliberate refusal.** "No visual BPMN builder — tarpit." Defensible, and it means an admin cannot change behavior without a developer |
| **Visual building: click-to-edit, instant preview, Figma import** | Lovable, Bolt, Base44, Floot, Retool | **Two-thirds answered, one-third a real gap.** *Instant preview* we have both ways — Vite HMR locally (`pnpm <demo> dev`), and a `PreviewPane` iframe over a live devserver in the hosted builder — but that's parity with any decent framework, not a win. *Figma* works through an MCP server or a pasted screenshot, and Manyfold is the evidence: a 13-screen design-system handover recreated as a working vertical. It's setup, though, not a button. *Click-to-edit* we genuinely lack, and the gap is **audience, not technology** — it exists so someone with no terminal and no vocabulary for the change can still make it. Claude Code gives a better loop to people who can already run a terminal, and no loop at all to people who can't |
| **Native mobile + offline sync** | Salesforce, OutSystems, Mendix, Power Apps; Floot exports mobile | **Planned, scoped hard, unbuilt.** Append-only capture flows only — general offline CRUD is a sync/conflict tarpit |
| **Marketplace + third-party ecosystem** | AppExchange, Odoo Apps, OutSystems Forge, Frappe | **Planned, unbuilt.** A design doc is not an ecosystem, and ecosystems take years |
| **Full-text + semantic search** | Supabase, Salesforce, essentially everyone | **Planned, unbuilt.** Table stakes in every B2B app and ugly to retrofit — §6 says so itself |
| **Realtime subscriptions / presence** | Supabase, Convex | **Planned, unbuilt.** Nearly free on scope DOs, which is exactly why not building it yet is a choice rather than a constraint |
| **Localization** | The FSM incumbent ships three languages; everyone mature does | **Planned, unbuilt.** §6 says "build day one" and today it's an `// i18n key` comment. Retrofits here are miserable |
| **Billing your customers out of the box** | Open SaaS (Stripe), Base44 payments primitives | **Partial.** Metering and entitlements exist for platform billing; the vertical-bills-its-own-customers rail is engine territory, not shipped |
| **Data import / legacy migration tooling** | Salesforce Data Loader, Odoo import, **8090's reverse-engineering agents** | **Planned, unbuilt** — and §6 calls it out as the biggest sales barrier, since every sale is a migration out of an incumbent. 8090's brownfield story is real and ours is greenfield-only |
| **Permissive licence** | Rails, Wasp, Medusa (MIT) | **Deliberate**, and a real adoption barrier. AGPL + commercial is a different bargain from MIT, and some builders will simply not take it |
| **A fully self-hostable *platform*** | Odoo, Frappe, Medusa, Rails, Wasp — clone it and run the whole thing | **Partial, and the split is the honest bit.** The vertical runtime self-hosts today (published, AGPL, one dependency, contract-tested on two adapters). The multi-tenant hosting product — router, control plane, PR-preview forking, per-tenant database minting — is private and Cloudflare-native. Escrow answers "can we keep running"; it does not answer "can we run the platform ourselves" |
| **Ecosystem, hiring pool, twenty years of answers** | Rails, and it isn't close | **Structural.** Nothing to do but say it |
| **Environment/ALM maturity** (sandboxes, managed solutions, refresh) | Salesforce, Dataverse | **We win the part that matters and lose the breadth.** A per-PR fork of prod that runs the PR's own code arrives in minutes and reaps itself; a Salesforce full-copy sandbox refreshes on the order of days. What they have and we don't is everything *around* it — change sets, deployment pipelines, org-wide metadata compare |
| **Provenance of the build itself** (decision graph, agent context, reverse-engineering) | 8090 | **Different axis, partly ours.** `concept.md` + the decision log + typed model are the same instinct in flat files — no graph, no retro-extraction from a legacy codebase |

**The pattern worth noticing:** almost every gap is *breadth* — catalogues, ecosystems,
certifications, years. Almost every strength is *depth of guarantee*. That is the honest
shape of a young platform with an unusual foundation, and it says exactly who should not buy
yet: anyone whose decision turns on connector count, an admin-configurable report builder, or
a certificate we don't have.

## 7. Add your own

<!-- Markus: append below. Same labelling rules — [shipped] / [built, unproven] / [bet]. -->

-

---

**Sources for the external claims:** [Floot](https://floot.com) ·
[Wasp](https://github.com/wasp-lang/wasp) ·
[Wasp's TypeScript spec, June 2026](https://wasp.sh/blog/2026/06/15/wasp-typescript-spec) ·
[Lovable RLS analysis (Superblocks)](https://www.superblocks.com/blog/lovable-vulnerabilities) ·
[Base44 auth bypass (Wiz)](https://www.wiz.io/blog/critical-vulnerability-base44) ·
[Dataverse security roles](https://learn.microsoft.com/power-platform/admin/security-roles-privileges) ·
[8090 Software Factory](https://www.8090.ai/software-factory) ·
[8090 $135M Series A, June 2026](https://www.businesswire.com/news/home/20260626795833/en/8090-Raises-$135M-Series-A-to-Accelerate-Their-Rollout-of-Software-Factory) ·
pricing and vendor claims are carried from [master-plan §7](master-plan.md#7-market-landscape),
which holds the full citation list.
