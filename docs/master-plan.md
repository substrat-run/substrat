---
status: canonical
layer: plan
description: Strategy, architecture decisions, and the D log. Canonical; everything else derives.
---

# Substrat — Master Plan

> **The hard parts, hosted.**
>
> Working document. This is the canonical source; the operator narrative, the technical RFC,
> and any pitch material are derivatives of this file and go stale — this file doesn't.

Status: **canonical** · living document — see `git log` for currency, not this line

Anonymized: **PropCo** = the anchor property-management company · **HouseCo** = the
house-building company · **POSCo** = the point-of-sale company · **MediaCo** = the
media-subscriptions venture · **the auth platform** = our existing open-source auth
product · **the FSM vendor** = the incumbent field-service-software vendor · **the kernel
owner** = the person owning kernel and engines. Public market vendors (competitors,
suppliers, platforms) stay named — they identify no one involved.

---

## 1. Thesis

AI has made building vertical B2B software fast and cheap — except for the parts that were
never about writing code: multi-tenancy, identity, permissions, integrations, data integrity,
audit, and GDPR. Those are exactly the parts that are catastrophic when wrong and that
LLM-generated code gets wrong most often.

Substrat is a hosted substrate that owns those hard parts and enforces them **at runtime** —
so that small teams (including non-engineers wielding AI tools) can build production-grade
vertical SaaS on top, at AI speed, without the speed being fatal.

We build the substrate. They build the verticals.

## 2. The problem, with evidence

The "70% problem" is now industry vocabulary
([Osmani, 2024](https://addyo.substack.com/p/the-70-problem-hard-truths-about)):
prompt-to-app tools (Lovable, Bolt, Replit) get a product roughly 70% of the way, and the
remaining 30% — auth hardening, tenant isolation, error handling, integrations, compliance —
is professional work: published hardening offers run
[£1,495–4,995 fixed-price per app](https://www.originalobjective.com/software-development/vibe-coding-production-support),
and year-one true-cost analyses of running a vibe-coded prototype land at
[~$6k–32k](https://hatchworks.com/blog/gendd/cost-of-vibe-coding/). A cottage industry of
"vibe-code hardening" consultancies now exists whose audit checklists (missing RLS, broken
auth boundaries, no tenant isolation, no audit trail) read like our kernel spec in reverse.
Veracode's 2025 GenAI report puts OWASP Top-10 vulnerabilities in
[45% of AI-generated samples across 100+ models](https://www.veracode.com/blog/ai-generated-code-security-risks/);
Databricks' red team found generic "be secure" prompting cuts insecure output only
[~13–19%](https://www.databricks.com/blog/passing-security-vibe-check-dangers-vibe-coding) —
prompting is not enforcement.

We have a live case study in the friend group: multiple one-off internal systems built with
Lovable and other LLM tools across an operating portfolio (property management, POS,
house building). The builder himself expects them to fail at the exact moment a business
depends on them. He is right, and the failure list is enumerable — and it is the kernel.

The structural insight: **the layer where LLMs are weakest (tenancy, auth, migrations,
integrations, compliance) is the layer where mistakes are catastrophic. The layer where LLMs
are strongest (screens, forms, workflows, reports) is the layer where mistakes are cosmetic.**
Substrat puts humans and hard guarantees under the line, and AI velocity above it.

## 3. The three-layer model

Everything in this plan hangs off one architectural and commercial decomposition:

**Kernel** (Substrat proper). Everything that is true of every B2B SaaS and nothing that is
true of any particular one. Identity, nested tenancy, permissions, documents, integrations
framework, events/audit/reporting spine, module system, notifications, jobs, billing
entitlements, GDPR machinery, app shell. Owns **no domain entities** — no customer table,
no work-order table. Instead it offers attachment contracts (documents, comments, activity
timeline, custom fields, audit events) that bind to opaque `(entity_type, entity_id)` refs
the vertical defines.

**Engines**. Domain machinery shared across verticals but too domain-shaped for the kernel:
work orders + time reporting, scheduling, ticketing/ärende, protocol/checklist engine,
asset hierarchies, portal shells. Headless, versioned modules. Engines own **invariants**
(state machines can't skip states; time entries are append-only; signed protocols are
immutable; every mutation emits an event; every access passes the permission check).
Verticals own everything with a user's fingerprints on it: vocabulary, extra states
(substates refining engine states — decision 26), form fields, triggers, UI, pricing
logic, branschprotokoll content. Design test: **if a vertical
ever needs to fork an engine, the engine drew its line wrong.**

Composition rule: **star topology — engines talk to the kernel, never to each other.**
No engine imports or calls a sibling; composition happens through three kernel-mediated
channels: opaque refs (attachment contracts bind to `(entity_type, entity_id)` without
knowing what it is), events (an engine reacts to another's schema-versioned events on the
spine — a contract, not a call), and vertical-owned orchestration (synchronous flows
needing two engines are wired in the vertical, where the glue is visible and
agent-editable). This keeps the semver matrix at N kernel contracts instead of N² engine
pairs (the Odoo addon treadmill, avoided) and keeps each engine independently licensable.
Corollary test: **if two engines need chatty synchronous communication, they are one
engine drawn wrong** — which is why "work orders + time reporting" is one engine, not two.

Engine reuse is the plan's least-proven hypothesis: no field precedent shows hardened
domain engines shared across verticals without forking (the
[platform-landscape research](research/platform-landscape-drilldown.md) found none —
Medusa's module pattern, the closest analogue, is unproven outside e-commerce). Two
disciplines de-risk it. **Engines are extracted, not designed**: domain machinery lives as
vertical code until a second vertical with a different shape needs it; the extraction
(case 2's ärende engine, §8.5) is the proof, never a prior bet. And the placement spectrum
(§6, decision 27) bounds the form: an engine is only right in the middle of
build → template → engine → integrate — shared invariants, reshapeable behavior. If either
half fails for a capability, it exits the engine form rather than forcing verticals to
fork.

**Verticals**. The businesses. Branschmoduler, workflows, GTM, customer relationships.
Owned by whoever builds and sells them (initially: the friend's companies). Built at AI
speed on kernel + engines.

## 4. Why runtime enforcement is the moat

Every adjacent solution delivers guarantees as **conventions**: templates you copy
(MakerKit, ShipFast, Open SaaS), code generators that eject (Baseplate.dev — whose proudest
feature is "zero lock-in, no runtime dependencies"), or a BaaS whose enforcement primitive
is the very thing vibe coders misconfigure (Supabase RLS). Conventions erode with every
LLM edit. The adjacent failure mode is **configuration**: even platforms that do enforce
at runtime make the guarantee contingent on builder-declared rules — Supabase RLS,
ServiceNow ACLs (2023 mass exposures from misconfigured public ACLs), Salesforce Apex
defaulting to system mode. Substrat guarantees are defaults of the substrate, not
configuration surfaces the builder — human or AI — can get wrong.

Substrat inverts this. Generated vertical code **cannot**:

- reach another tenant's data — data access only exists as capability-scoped RPC into the
  owning scope's Durable Object, which validates the caller against its own ACL;
- leak tenants in reporting — the only analytical path is a query gateway that injects
  tenant predicates;
- call third-party APIs raw — credentials live in the integrations hub; verticals see only
  the connector interface;
- skip the audit log — events are emitted by the engine below the API surface, not by the
  calling code.

When the guarantees live below the API surface, it stops mattering who — or what — wrote
the code above it. This is a categorically stronger safety model than "prompt the LLM to be
careful," and it is the one property that survives model improvement: even a future AI that
writes flawless tenancy code doesn't solve the **trust** problem. Someone has to underwrite
that isolation, audit, and GDPR hold structurally. That someone is Substrat.

The two human checkpoints that stay non-negotiable even in a fully AI-driven vertical shop:
schema migrations and permission definitions get reviewed by a person. Everything else
iterates at AI speed with contained blast radius.

## 5. Architecture decisions

### 5.1 Tenancy: two levels, tree-shaped

The tenant is the business (förvaltningsbolag, retail chain, publisher); beneath it are
**scopes** (BRF customers, filialer, client companies, brands, clinics). Users belong to the
tenant, to a scope, or to several scopes with different roles; permissions are assignable at
either level with inheritance down the tree. This shape recurs in every known case (PropCo's
BRFs, POSCo's byrå feature, MediaCo's publishers/brands, dental chains) and incumbents
bolted it on late (the FSM vendor sells filial support as a paid add-on). Flat Auth0-style organizations
model it badly; native hierarchical scoping is a differentiator for the kernel and for
the auth platform as a product.

### 5.2 Storage: two shapes behind one contract

The kernel contract is `getScope(tenantId, scopeId) → RPC stub`; where the data physically
lives is the vertical's storage decision.

**Shape A — DO-per-scope with embedded SQLite as primary store.** The Durable Object *is*
the database (SQLite-backed DOs, 10GB/DO, PITR). Right for small, document-centric,
realtime-friendly scopes — our document-spaces product is the proving ground.

**Shape B — DO-per-scope as control plane fronting per-tenant D1.** DO holds hot state
(ACLs, entitlements, counters, locks) and mediates every access; storage stays in D1 for
read replicas (Sessions API), HTTP/wrangler ops tooling, export/backup, and >10GB headroom.
Right for the förvaltar-OS.

Granularity rule: **the DO maps to the consistency domain, not the tenant** — one
lightweight tenant-root DO (directory, membership, entitlements) plus one DO per scope.
Blast radius of a hot or wedged DO is one BRF, not one customer.

Hard rules learned in advance: DOs are not enumerable, so the directory/registry is
load-bearing — it is the only complete inventory of scopes and the input to reconciliation
and migrations. Migrations run lazily per-DO on wake (version check in init against the
Drizzle journal), with a reconciliation sweep waking stragglers before a deadline; schema
version skew across live scopes is a **normal state** code must tolerate for a window.

### 5.3 Data: three tiers, events cross boundaries, queries don't

**Tier 1 — operational truth** (DO-SQLite / D1). Transactional writes, constraints,
idempotency, balances. Anything ledger-like is double-entry here.

**Tier 2 — exact history** (domain events → Pipelines → Iceberg on R2, queried via R2 SQL
behind a tenant-scoping query gateway). Reporting, reconciliation, audit. Fed exclusively
by the event stream — application code never writes to the lake. R2 SQL matured through
H1 2026 (aggregations, CTEs, ~196 functions, JOINs, window functions, dashboard querying;
automatic compaction + snapshot expiration in R2 Data Catalog fixed the small-files
brittleness). Still open beta: re-benchmark against a realistic synthetic (≈50M ledger
events / 500 scopes) before locking in. Fallback (DuckDB or external engine reading the
same Iceberg catalog) changes nothing architecturally — **Iceberg is the contract, the
query engine is replaceable.**

**Tier 3 — telemetry** (Analytics Engine / Datadog). Sampled and approximate by design.
Never touches money, never shown to customers as a count. Ops metrics only. Design:
[design/observability.md](./architecture/observability.md) — piggyback Cloudflare's native
analytics/telemetry APIs at script grain; the router stamps the tenant dimension into AE.

Standing integrity guarantee: a reconciliation job continuously verifies Tier 2 sums match
Tier 1 balances.

GDPR in an immutable lake: PII tokenized/encrypted per-subject with crypto-shredding for
erasure; pseudonymous keys and transaction facts remain. Bokföringslagen's 7-year retention
maps cleanly: PII erasable, facts retained. This is a kernel convention every event producer
follows, not a per-vertical invention.

**Built, and narrower than this paragraph reads** (D-45, #37). The mechanism ships against
the stores that exist *today* — the live spine (redacted, because Tier 1 is mutable) and
the platform-retained copies of it (crypto-shredded, because a backup is not). Tier 2 is
not among them: nothing drains the event outbox to a lake yet, so the immutable-lake half
of this sentence remains a design, and the seam is shaped so it inherits the mechanism when
it lands. Five limits are enumerated in
[kernel-design §13.1](./architecture/kernel-design.md) — read them before this paragraph reaches a
sales deck, because *"erase X from everywhere"* is not among the things it can do.

### 5.4 Cross-tenant calls

Authorization is enforced by the **data owner**, not trusted from the caller. Cross-scope
and cross-tenant access is capability-mediated RPC into the owning DO, which validates,
executes, audits, meters, and rate-limits at one choke point. Never scatter-gather for
analytics — small-N operational fan-out is fine; dashboards read Tier 2.

This same mechanism, productized, is the beställare–utförare network play (§8.3): a work
order crossing from PropCo's scope into a subcontractor's tenant is a mediated RPC with a
commercial meaning.

### 5.5 No dynamic schema

The DatoCMS/Salesforce metadata-driven-schema question dissolves once the kernel owns no
entities. Modules own their tables and Drizzle migrations (Odoo-addon pattern); tenants get
typed custom fields (JSONB + field-definition registry) and a configurable protocol/checklist
engine. Full EAV costs indexes, query plans, reporting, and type safety to buy flexibility
no current vertical needs. Declared flexibility must stay queryable, though: registering
a custom field materializes a typed index, and engine list APIs accept declared fields as
filter/sort predicates (decision 26, kernel-design §7.5) — the obligations that keep
"typed custom fields" from decaying into an unqueryable blob.

### 5.6 LLM-friendliness as a design requirement

Narrow, aggressively typed SDK (small API surface = small hallucination surface; invalid
states unrepresentable in TypeScript). Agent-oriented docs shipped as skills / CLAUDE.md
conventions. An MCP server for the platform itself (scaffold a module, inspect a tenant's
schema, dry-run a migration, tail events). Reference verticals as few-shot material.
CI guardrails: lint rules banning raw DB/fetch access; contract tests every module must pass.

**Contract-first, code-native** (amended 2026-07-12, decision 22 — supersedes the
TypeSpec plan). Every kernel contract has a machine-readable schema as its source of
truth, authored in its native form: Zod schemas in a dedicated semver'd contracts
package — the same artifact that validates at runtime (parse, don't trust; §5.8). The
HTTP surface is served via zod-openapi on Hono and **emits** OAS; RPC and event payloads
emit JSON Schema; emitted documents are checked in and CI-diffed with breaking-change
linting — the emitted diff is what the human checkpoint reviews. AsyncAPI and Arazzo are
deferred until an external consumer needs them. Inbound vendor APIs run the opposite
direction: validators are **generated from** the vendor's published OAS — whoever owns a
contract authors it in their native form; everything else is derived. Skills, generated
SDKs, the MCP server's tools, and the §5.7 adapter-conformance tests are all **derived
from the contracts package**, never hand-maintained beside it; a module manifest that
declares its API and events in schema form is what makes an engine self-describing — to
agents now, to strangers buying it later. Spec *tooling* (registries, portals, pipelines)
is deferred per the one-step-ahead rule (§6).

**The agent loop is the acceptance test.** The measure of everything above: Claude Code,
pointed at the module manifest, the specs, and one reference vertical, scaffolds a
complete new vertical — schema, permissions, screens, workflows — with the platform
pushing back mechanically instead of via prompting: the typed SDK rejects invalid states
at compile time, lint blocks raw access, contract tests and dry-run migrations fail fast,
and the two human checkpoints (§4) gate exactly what agents must never self-approve.
"Can an agent build a vertical unaided up to the checkpoints?" was the recurring benchmark;
eight runs are recorded in `docs/acceptance/`. **The standing obligation is retired (D-57)**
and nothing replaces it — `apps/builder/evals` regression-tests the studio's own generator,
which is a different question. So the unaided-agent claim currently has no standing test,
and D-57 is the reason to run 009 before it re-enters a pitch.

### 5.7 Adapters: Cloudflare is the deployment target, not a dependency

The auth-platform adapter pattern, applied kernel-wide: every kernel contract is a pure TypeScript
interface, and every kernel service ships at least two adapters — the Cloudflare-native one
(DO / D1 / R2 / Queues; production) and a **pure SQLite/Node one** (local dev, CI,
self-host). No kernel or engine code imports a Cloudflare API directly; only adapters do.

The subtle case is the Durable Object, because it isn't just storage — it is the
consistency and enforcement domain (§5.2, §5.4). So the adapter boundary sits at the
scope-host contract, `getScope(tenantId, scopeId) → RPC stub`, not at the database driver:
the Cloudflare adapter backs the stub with a DO; the pure adapter backs it with an
in-process actor holding one SQLite file per scope, preserving the same serialized-execution
semantics. Tier 2 follows the same logic — Iceberg is already the contract (§5.3), and the
pure adapter writes the same event stream locally, queried via DuckDB. Queues, cron, and
workflow state get a SQLite-backed job-table adapter.

What this buys: fast deterministic local dev and CI (vibe-coded verticals run contract
tests against real kernel semantics without a Cloudflare account); a §9 escrow story that
is literally true rather than aspirational — single-node, but runnable; and the hedge
against Cloudflare pricing/product/deprecation risk that Iceberg-as-contract alone doesn't
cover. The rule is testable and non-negotiable: **a module's contract tests must pass
unchanged on both adapters, and the pure-SQLite adapter stays green in CI forever.**

**What travels on exit, and what does not.** The escrow claim stays literally true — code,
schema, data and a runnable single-node host all leave with the customer, which is the
point of the two-adapter rule. What does not travel is the **operated** half: our
certifications, our evidence pipeline, our incident response, our audited backups
(decision 32). That is true of every hosted service in existence, and the plan states it
plainly rather than letting a buyer discover it during an audit — §7.8's own lesson is
that this field has trained buyers to disbelieve portability claims, so the credible move
is to name the limit before anyone asks. The gap is narrowed, not closed, by the
**compliance pack**: control mapping and evidence tooling published for self-hosters,
giving their auditor a running start on a scope they now own entirely.

For the exposed surface stated in one place — what a module declares, the four API
surfaces the platform exposes, and a concept-by-concept mapping onto a non-Cloudflare
substrate (Kubernetes) — see [design/platform-neutral-surface.md](./architecture/platform-neutral-surface.md).

**The triage rule, generalized.** Three buckets, decided per capability: (1) **kernel-owned**
— anything that is enforcement input or a contract (tenancy tree, directory, permission
model, event schema, entitlements, attachment contracts, module manifest, the integrations
hub itself); (2) **adapter** — infrastructure the kernel consumes, swappable behind a pure
interface; (3) **connector** — third-party capability *tenants* use, living in the
integrations hub (Fortnox, BankID-sign, EDI). The full adapter set beyond storage:

- **Identity** and **permission evaluation** (decision 16).
- **Billing provider** — the identity split repeated: entitlements are kernel-owned
  (enforcement input); the payment rails are an adapter, Stripe default. Matters here
  concretely: Swedish B2B often pays by invoice, so a Fortnox-invoicing rail must be
  mountable without touching entitlements.
- **Model providers (AI gateway)** — per-tenant swappable (Workers AI / Anthropic / OpenAI /
  EU-hosted); the governance (metering, PII rules, audit) is kernel, the model is not.
  Also the sovereignty answer for AI features.
- **Key management** — crypto-shredding (§5.3) is kernel machinery; where keys live
  (CF secrets / cloud KMS / local encrypted store) is an adapter. GDPR erasure claims are
  only as credible as the key store's independence. *Built as stated (#37): the per-subject
  keys are the kernel's, wrapped by the swappable `SecretBox`, and "independence" is
  implemented as placement — they live in the directory, never in the scope database whose
  rows they protect, so a scope restore cannot un-erase anyone.*
- **Telemetry** — OpenTelemetry is the contract; the APM vendor (Datadog/Sentry/Better
  Stack) is an adapter. Spec-first (§5.6) applied to ops.
- **Notification transports** — dispatch, templates, preferences are kernel; the
  email/SMS/push provider is an adapter, per-tenant selectable (enterprise tenants will
  demand their own SMTP/SES).
- **Search backends** — the search contract is kernel; FTS (SQLite FTS5 / D1) and vector
  index (Vectorize / sqlite-vec) are adapters, already implied by the two-adapter rule.

What must **never** become an adapter: the event spine, tenancy/permission model,
entitlements, and the module manifest — those are the product. Swapping them out is
called "not using Substrat."

### 5.8 Language, build, and distribution

**TypeScript end-to-end** — for reasons that hold regardless of team ("why not Rust/Go"
is the RFC reviewer's first question; the answer must not be "team muscle"):

1. **Downstream of the runtime, not of taste.** The enforcement domain is V8 isolates
   (DO-per-scope, §5.2 — chosen for consistency domains and blast radius). On that runtime
   JS/TS is native and everything else is a WASM guest: Workers RPC — the capability
   stubs, the enforcement primitive itself — is a JavaScript-class mechanism others can't
   join first-class; DO APIs land JS-first; Rust arrives via bindings with bundle-size and
   interop costs; Go compiles to WASM badly. To argue the language you must argue the
   runtime — §5.2 and the adapter hedge (§5.7) answer that.
2. **The boundary is where the value is.** Verticals will be TypeScript regardless of the
   kernel (React UIs, prompt-to-app tools emit TS, agents perform best in it). "Invalid
   states unrepresentable" (§5.6) materializes at the SDK boundary; a Rust or Go kernel
   exports its types only as generated bindings — two sources of truth at the most
   important interface in the system.
3. **The workload doesn't reward systems languages.** The kernel is I/O orchestration
   over embedded SQLite, serialized per scope by the actor model — which also nullifies
   Go's one structural advantage (cheap concurrency). CPU-bound hot paths (EDI parsers,
   crypto, gateway internals) fit the WASM module slot surgically.
4. **Memory safety is already paid for** (V8: GC, sandboxed isolates); the security
   surface here is authorization logic, not memory corruption. For domain modeling, TS's
   type algebra (discriminated unions, literal + branded types) is strictly stronger than
   Go's — of the three candidates, Go is the one that *cannot express* "invalid states
   unrepresentable."
5. **The platform's primary users are agents** (§5.6). LLM capability is corpus-weighted;
   TS/JS is the largest corpus with the fastest toolchain feedback. When the customer is
   an AI, language is a product decision about the customer.

Honest concessions: a self-hosted single-binary product (PocketBase-shaped) should be Go;
a database or query engine should be Rust — which is why those layers are bought (SQLite,
R2 SQL), not written. Optics answer: the infrastructure *dependencies* are systems
languages (workerd, V8, SQLite); the kernel is the orchestration layer above them — the
layer where Cloudflare, having written workerd in C++/Rust, tells its customers to write
TypeScript. Team muscle (auth platform, document product, pnpm) is real and listed last
deliberately: the case survives a team change (risk 10).

**The type-erasure objection, answered structurally.** TS types erase at runtime, so they
are never the enforcement: every trust boundary validates at runtime with validators
generated from the specs (§5.6 — parse, don't trust), and the guarantees that matter are
structural (DO boundary, capability RPC, query gateway), not type-level. Types are agent
ergonomics; the moat doesn't depend on the compiler.

**Portability = standards + adapters, not WASM.** WASM portably runs *compute*; the
kernel is I/O orchestration, which WASM doesn't abstract — adapters do (§5.7). Kernel core
targets the standards surface (fetch, WebCrypto, streams — WinterTC profile: runs on
Workers, Node, Bun, Deno); platform specifics live only in adapters; external contracts
(Iceberg, OTel, OIDC, AsyncAPI) cover the rest. Door left open, cheaply: the module
manifest may later admit WASM component modules for hot paths (parsers, crypto, gateway
internals) or polyglot engines — additive, never a platform bet.

**Build & distribution.** pnpm monorepo → published npm packages: `@substrat-run/sdk`,
adapters (`adapter-cloudflare`, `adapter-sqlite`), engines as manifest-carrying packages,
the specs, the CLI (`substrat dev` = pure-SQLite composition locally, §5.7), skills + MCP
server. Semver everywhere (§6); AGPL + commercial licensing (§9). Runtime distribution:
hosted control plane; verticals deploy as user workers we upload with our own
credentials — ordinary Workers today, Workers-for-Platforms when script count or
isolation demands it (D-34; the same mechanism §9 relies on for per-tenant cost
attribution). WfP is verified to fit and is a paid add-on we have not bought, so it is
the destination rather than the starting point. The auth-platform packaging
playbook, applied deliberately.

## 6. Kernel components and build/buy

Principle: **build contracts and control planes, buy engines.** Build what is the moat and
what nobody sells in the needed shape; adopt substrate everywhere else.

Behind every row sits one axis — the **placement spectrum** (decision 27):
**build bespoke → copy a template → adopt an engine → integrate via API.** Moving right, a
capability gains inherited guarantees and maintenance and loses reshapeability: an
integration's functionality is fixed (you get auth or payments exactly as the provider
ships them); an engine's behavior is reshapeable within invariants (substates, custom
fields, workflows — decision 26); a template is fully mutable and fully unmaintained;
bespoke is simply yours. Two tests place each capability:

1. **Guarantee-surface coupling.** Does its data participate in the permission tree, audit
   log, tenant isolation, GDPR machinery, reporting? If yes it must live inside — kernel
   contract or engine — because an external API can exchange *outcomes* but cannot enforce
   our permissions on *its* objects. This is why documents are a kernel service despite a
   world full of document APIs (a second enforcement regime is the exact leak the kernel
   exists to prevent — table below), and why entitlement *checks* are kernel while the
   billing *rail* is an adapter.
2. **Reshaping need.** Do verticals need to change the behavior — states, fields,
   vocabulary, flows? High need with shared invariants → engine. High need without shared
   invariants → template or vertical code. No need → integrate: auth, payments, e-signing,
   SMS are commodity semantics with someone else's compliance moat.

Capabilities can straddle: scheduling is an engine (double-booking and working-time
invariants live on our data) while calendar *sync* (CalDAV/Google) is an integration;
billing splits three ways (table below). The spectrum also bounds engine ambition: an
engine is only the right form in the middle, where invariants are shared and behavior is
not. A capability that drifts to either end — so divergent per vertical that the shared
invariants vanish, or so commoditized that an API wins — should exit the engine form in
the direction the spectrum points.

| Component | Call | Notes |
|---|---|---|
| Identity / auth | **Adapter (ours default)** | Authentication is a swappable identity adapter (OIDC-shaped); our auth platform is the reference implementation and default (dogfooding + §5.1 product synergy). The kernel owns the directory and tenancy tree — identity providers authenticate people, they never own org structure. Extend: end-user identity (boende, styrelse, consumers) as first-class, BankID-heavy. |
| Permissions | **Build model, adapt engine** | Role @ node in tenancy tree + capability grants (entity-narrowable for portal users). The **model** is kernel-owned — it is enforcement input, never delegated to an auth provider. The **evaluation engine** is an adapter behind the same check API: built-in constrained relationship-tuple engine (FGA-shaped, decision 23), OpenFGA-swappable. |
| Nested tenancy + provisioning | **Build** | The crown jewel. Directory/registry, per-scope storage, migration orchestration, reconciliation. Largely exists from the auth platform. |
| Module system | **Build (thin)** | Manifest (migrations, permissions, events, extension points), entitlement flags, attachment contracts. Mostly conventions. |
| Integrations framework | **Build** | Connection store + token refresh, connector interface, webhook ingress (signatures, replay protection), outbox with idempotent retries, per-tenant config + health. Steal Nango's interface design; own it for EU sovereignty. Connectors accrete per vertical need: Fortnox, Visma, BankID, Swish, Peppol, Kivra, fastAPI, EDI (Ahlsell/Rexel/Sonepar). |
| Documents + metadata | **Extract, then re-platform the source** | Our document product's engine extracts into the kernel service (R2 + versioning + Vectorize search + retention + tenancy-tree permissions); the product then re-platforms onto the kernel piecemeal (the POSCo pattern) and becomes kernel consumer #2 — proving the contracts on a collaboration-shaped product and exercising Shape A, realtime, and search. Never the reverse: documents behind an external product's own permission regime would be a second enforcement system — the exact leak the kernel exists to prevent. |
| Events / audit / reporting | **Build spine, buy engines** | Event contract (schema-versioned, tenant-tagged, PII-classified), Pipelines→Iceberg, query gateway. Audit log is a product feature, not just ops. |
| Workflows | **Adopt + conventions** | Cloudflare Workflows for durable execution; kernel adds module-owned definitions, human-approval steps, event emission. **No visual BPMN builder — tarpit.** |
| Jobs & scheduling | **Adopt + conventions** | Queues, cron; per-tenant scheduling conventions. |
| Notifications | **Buy transport, build dispatch** | Transport is an adapter, per-tenant selectable (Resend/SES, Nordic SMS 46elks-class); kernel owns dispatch, templates, preferences, delivery tracking (§5.7). |
| Billing & entitlements | **Buy billing, build entitlements** | Three billings, three layers: (1) platform billing = kernel — entitlements are enforcement input (they gate module loading; an engine can't gate the system that loads engines), billing rail is an adapter (Stripe default, Fortnox-invoice rail for Swedish B2B, §5.7); (2) verticals billing their customers = engine territory at most (fakturaunderlag engine per §8.4; reskontra/avisering stays out per §7.5 boundary — Fortnox/Visma connectors); (3) end-customer payments = vertical domain + payment connectors (Swish, cards). |
| GDPR machinery | **Build** | DSAR export, crypto-shredding erasure, retention policies. Nobody sells it in this shape; a genuine selling point in these markets. |
| Certification & assurance programme | **Build** | Not a kernel component but a kernel *obligation*, and the only row whose cost is mostly not engineering — ISMS, control mapping, evidence pipeline, auditor-facing export, CUEC list, trust page, sub-processor register, DPA templates (decision 32). Placement note (decision 27): the *evidence* is guarantee-surface-coupled and therefore lives inside — it is generated from the same spine that enforces the controls, and a compliance product reading a second, reconstructed history would be the exact leak the kernel exists to prevent. The *audit* is bought (an external auditor, by definition). Compliance-automation vendors (Vanta/Drata-class) are an adapter-shaped buy for the workflow, never for the evidence. |
| Import / migration tooling | **Build** | Staging, mapping, validation, dry-run. Every förvaltar-OS sale is a migration out of Vitec/Fast2/the FSM vendor — turn the biggest sales barrier into onboarding. |
| Search | **Build (thin)** | Tenant-scoped, cross-module: modules register searchable entities via the attachment contract; FTS in scope SQLite/D1 + Vectorize for semantic; permission filtering applied to results at the gateway. Table stakes in every B2B app; retrofit is ugly. |
| Document generation + e-sign | **Build generation, buy signing** | Templated PDFs (protokoll, fakturaunderlag, styrelserapporter) as a service over the documents engine; e-signing via BankID-sign/Scrive-class connector; signed artifacts immutable, evidence stored. The verticals' *outputs are signed documents* — this is not optional. |
| Mobile field capture (offline) | **Build (scoped hard)** | Offline-first for **append-only capture flows only** — time entries, checklist ticks, photos, notes — as a mutation queue of event-shaped writes replayed into the scope DO. No general offline CRUD (sync/conflict tarpit). Binds the data design day one: capture flows must be event-shaped. |
| Inbound channels | **Build ingress, buy parsing** | Email-to-ärende (felanmälan), per-tenant/scope addresses, attachment capture; SMS later. Ticketing table stakes; notifications row is outbound-only without this. |
| AI gateway | **Build gateway, buy models** | Verticals will ship AI features (summarize ärende history, draft replies, RAG over scope documents — Vectorize already there). Kernel provides the governed path: per-tenant metering, PII rules from the event classification, audited AI actions. The 2026 expectation (Retool Agents, Agentforce) and a natural §9 usage meter. |
| Realtime | **Adopt (DO-native)** | Subscription contract (WebSocket/SSE) on scope DOs — portals and dispatch boards get live updates nearly free on this architecture; make it a contract, not an accident. |
| Platform ops console | **Build (internal first)** | Registry/tenant health UI, migration + reconciliation status, billing state, consented **and audited** support impersonation (view-as-user, §7.8). Needed internally regardless; later it's the enterprise admin story. |
| API surface | **Build (cheap early)** | Per-tenant keys, rate limits, signed outbound webhooks. Contract-first: zod-openapi→OAS, emitted + CI-diffed (§5.6, decision 22). |
| App shell + design system | **Build shell, buy components** | Login/SSO, org/scope switcher, permission-aware nav, settings, members, audit viewer, notifications, connector UI. **Not** a dashboard framework — that's Retool, a whole company. End-user dashboards: chart components over saved gateway queries; resist configurability until a customer pays for it. |
| Localization | **Build day one** | sv/no/da/en. Retrofits are miserable; the FSM vendor ships three languages. |
| Observability per tenant | **Convention + adapter** | OpenTelemetry is the contract; tenant/scope IDs on every trace and error; APM vendor swappable (Datadog/Sentry/Better Stack) (§5.7). Default backend is Cloudflare-native ([design/observability.md](./architecture/observability.md)); an external APM slots in behind the same proxy later. |
| Feature flags | **Adopt** | On entitlements, or GrowthBook. |

Sequencing discipline: **kernel work is never more than one step ahead of a vertical that
needs it.** Kernel-first only where retrofit is brutal: tenancy model, permission model,
event schema, module manifest, i18n. Everything else earns its way in when a second
consumer proves the contract (the auth-platform extraction pattern, applied deliberately).
Version every kernel contract (RPC interfaces, event schemas, manifest) with semver from
day one — the moment two verticals depend on it, unversioned changes halt both roadmaps.

## 7. Market landscape

### 7.1 The category gap

Every ingredient exists as a standalone company — WorkOS/Clerk (identity+orgs), Nile
(tenant-virtualized Postgres), Nango/Paragon (integrations), Inngest/Trigger.dev (jobs),
Stripe (billing) — and nobody has bundled the substrate, because the substrate alone has no
buyers; only products built on it do. Hence: **Substrat is an internal architecture
investment justified by owned verticals, with category optionality on top** — the auth-platform
playbook.

Stated against the strongest incumbents rather than the weakest: the market today forces a
three-way choice — **governance without code** (LCAP: safe, but proprietary visual models,
agent-hostile, internal-app-shaped, $36k+/yr entry), **code without governance**
(BaaS/boilerplates/prompt-to-app: agent-friendly, but every catastrophic mistake is yours),
or **both, at enterprise prices, inside a walled garden** (Salesforce/ServiceNow). Nobody
sells governance as a runtime substrate **under code you own**, agent-first, shaped for
multi-tenant vertical SaaS, in the EU. That intersection is the category.

### 7.2 Nearest neighbors and why they aren't this

- **Prompt-to-app** (Lovable, Bolt, Replit, Emergent): generate the dangerous parts
  instead of standing on hardened ones. The 70% problem is their structural ceiling — made
  concrete by CVE-2025-48757: ~10% of analyzed Lovable apps had tables readable via the
  public anon key, 170+ exposing PII
  ([analysis](https://www.superblocks.com/blog/lovable-vulnerabilities)). Their remedy
  (security *scanning*) checks that policies exist, not that they hold — convention-checking,
  §4's point.
- **Base44 (Wix)**: the partial exception among AI-natives — auth, roles, and row-level
  security are **platform primitives enforced at runtime**, not generated code. Nearest
  AI-native articulation of the Substrat model, and proof the idea is in the air. But:
  single-app-shaped (no tenancy tree, no engines, no B2B SaaS shape), weakest portability
  in the field (exported frontends die without the Base44 SDK), inside Wix — and the
  platform's own auth was bypassed in 2025
  ([Wiz](https://www.wiz.io/blog/critical-vulnerability-base44)). Validates the category;
  doesn't occupy it.
- **Templates/boilerplates** (MakerKit, ShipFast, Open SaaS, Bullet Train): closest
  articulation of "LLM-friendly foundation," but guarantees are conventions that erode with
  every edit; no nested tenancy, no provisioning, no engines; $199–649 one-time economics
  ([ShipFast](https://shipfa.st/), [MakerKit](https://makerkit.dev/)).
- **Baseplate.dev** (Half Dome Labs): nearest neighbor by pitch ("AI writes the logic,
  nobody wrote the foundation"). Deterministic codegen, Diff3-preserving regeneration —
  and proudly **ejectable** ("no runtime dependencies"). The exact opposite pole: they
  generate the foundation and leave; we are the foundation and stay. Cleanest contrast for
  positioning.
- **Enterprise low-code (LCAP)** (OutSystems, Mendix, Appian, Power Apps, ServiceNow App
  Engine): the strongest existing answer — they genuinely solve permissions, audit,
  governance, and compliance as a hosted platform, and their pricing proves the
  willingness to pay ([OutSystems from ~$36k/yr entry, enterprise $100k+](https://www.outsystems.com/pricing-and-editions/);
  [Mendix from ~€52.50/user/mo](https://www.mendix.com/pricing/);
  [Power Apps $20/user/mo](https://www.microsoft.com/en-us/power-platform/products/power-apps/pricing)).
  But all of it lives **inside a proprietary visual model**: agent-hostile (AI copilots
  generate into the model, deepening lock-in), internal-app-shaped (no nested tenancy for
  *selling* SaaS), US-owned clouds, and no code ownership. Their existence is demand
  evidence for the kernel; their entry pricing is the ceiling anchor for kernel fees.
  Even the best tenancy in the class — OutSystems O11's automatic per-tenant query
  filtering — is single-level and absent from their strategic successor (ODC); and none
  has a usable eject (OutSystems' one-way .NET detach yields code nobody maintains).
- **Governed AI internal tools** (Superblocks "Clark", Retool AI): closest philosophical
  neighbor — platform-level governance applied to AI-generated apps — but internal-tools
  shaped, runtime-locked, US-hosted.
- **BaaS** (Supabase, Convex): app-shaped, not vertical-SaaS-shaped; Supabase's enforcement
  primitive (RLS) is precisely the vibe-coding foot-gun.
- **Salesforce / ServiceNow**: proof the category works at the top of the market — now with
  AI app generation — but proprietary, US-hosted, enterprise-priced, build-inside-our-world.
  Nobody has built the code-first, developer-owned, EU version.
- **Odoo / Frappe(ERPNext)**: the platform-with-modules thesis executed; you inherit their
  ORM, worldview, and upgrade treadmill. Platform, not kernel — and single-org shaped:
  Odoo.sh is one project per GitHub repo with no reseller multi-tenancy ([FAQ](https://www.odoo.sh/faq));
  partners who do run Odoo-based SaaS self-host per-tenant databases and build the
  provisioning themselves. The treadmill is structural, not incidental: Community edition
  has **no vendor upgrade path at all** (migration scripts are closed-source,
  Enterprise-only), leaving upgrades to the OCA's chronically under-funded
  [OpenUpgrade](https://github.com/OCA/OpenUpgrade) — hand-written per-module migration
  scripts across full dependency chains, lagging releases by months to a year by the
  [OCA's own account](https://www.odoo-community.org/blog/news-updates-1/openupgrade-187).
  Real products on Odoo exist but are the exception; the ecosystem's gravity is
  per-customer integrator implementations. Frappe is the nearest open-source
  "apps on a framework" analogue, but its everything-is-a-DocType metadata model is the
  dynamic-schema pole §5.5 rejects. Full drilldown with verified sources:
  [platform-landscape research](research/platform-landscape-drilldown.md).
- **Medusa (v2)**: nearest architectural relative on the kernel side — strict module
  isolation ("a module is unaware of any resources other than its own"), cross-module
  associations via link tables without foreign keys, per-module TypeScript migrations
  ([docs](https://docs.medusajs.com/learn/fundamentals/modules/isolation)): independent
  convergence on the engine model (§3, §5.5), shipping in production. But
  e-commerce-scoped, no native multi-tenancy (builders run an instance per tenant), and
  no enforcement layer — it validates the module architecture, not the tenancy or trust
  product.

### 7.3 Unclaimed differentiators

Runtime enforcement instead of conventions · nested B2B tenancy as first-class · hardened
domain engines (nobody ships a work-order engine as a platform module — platform companies
lack the vertical operators to derive them from) · EU data sovereignty at SME price points
(a real purchasing criterion in our markets; the hyperscaler platforms now sell EU
residency — Microsoft EU Data Boundary, Salesforce Hyperforce EU — but only at enterprise
prices inside their runtimes; the developer/SME layer — Retool, Replit, the AI-natives —
stays US-default) · operator-anchored proof (others demo
todo apps; we demo a förvaltningsbolag running five offices).

### 7.4 Convergence risks

Lovable/Replit pushing toward production-grade from above; Supabase/Convex adding B2B
primitives from below; Salesforce descending downmarket with AI. Durable ground: enforcement
architecture + compliance machinery + vertical depth is a **trust** moat, not a capability
moat — model improvements don't erode it (same reason auth didn't stop being a product when
LLMs learned OAuth).

The convergence layer is also a **latent channel**: Substrat as the backend prompt-to-app
tools generate against. Not as a general Supabase replacement — the median prompt-to-app
app has no tenants, and unopinionated wins there — but for their B2B slice, whose failures
(§2) are exactly what the kernel enforces. The option costs nothing to keep alive: the
integration surface a Lovable-class tool needs is the same manifest + specs + MCP loop
already being built for Claude Code (§5.6). Strictly post-operator-proof optionality, not
a case; it would also require a self-serve tier and support surface the vertical play
doesn't. The vibe-code-hardening consultancies may be the cheaper first channel ("migrate
your Lovable app onto Substrat" as their remediation product).

**Certification is what makes the trust moat legible.** The enforcement argument is strong
and slow: it asks a buyer to follow a claim about runtime architecture before they can
value it. Inherited certification (decision 32) is the same moat stated in a sentence a
procurement officer prices immediately — *you inherit our controls and your audit evidence
generates itself* — which matters more than depth in early GTM. It also splits by
audience, and the split determines where to push it. To **buyers of verticals** it is
invisible plumbing: they never learn Substrat exists, they only notice the vertical
cleared procurement, so it is a win-rate lever and not a message. To **builders of
verticals** — the licensing channel, where the substrate business lives — it is plausibly
the strongest purchase driver available, because engines save them months of build while
certification saves them a market entry they might never manage alone. That completes the
convergence answer: Lovable and Supabase can converge on capability, and neither converges
on being an audited operator of someone else's regulated workload.

### 7.5 Vertical market notes (gathered en route)

- **Swedish FSM / arbetsorder** (the FSM vendor's market): crowded — Hantverksdata Entré, Mowin,
  Minuba, Coredination, Trinax, Fieldly, Next, Bygglet, SmartDok. The FSM vendor's moat is decades of
  vertical depth: OVK-protokoll, F-gas registerföring, borrprotokoll→SGU, EDI grossist
  pricing, ROT-fördelning. Fortnox integration is table stakes.
- **Fastighetssystem**: Vitec and Momentum are the legacy giants, Fast2 acquired by
  Addnode/SWG 2023, **Pigello** is the modern challenger (200+ bolag, covers ekonomi,
  ärenden, boendeportal, and explicitly uppdragsförvaltning). Industry integration standard:
  Sveriges Allmännytta's **fastAPI** (Vitec/Momentum/Fast2 shared IoT integration —
  sensor → felanmälan). Support it day one for cheap credibility.
- Ekonomisk förvaltning (avisering, autogiro, reskontra, inkasso, andelstal) is where the
  incumbents' moat lives — **a boundary, not a v1 module**. Integrate Fortnox/Visma instead.
- **What these markets pay** (2026, sources checked 2026-07-12):
  - FSM per user/mo: [Mowin 370 SEK flat](https://mowin.com/sv/priser) ·
    [Coredination 290–519 SEK](https://www.coredination.com/priser/) ·
    [Fieldly 219–699 SEK + EDI add-on 399 SEK/mo](https://sv.fieldly.com/priser) ·
    [Minuba ~109–269 SEK by role](https://minuba.se/priser/) ·
    [Bygglet per package, 1,049–2,289 SEK/mo](https://bygglet.com/paket-och-priser/).
    A 20-person installation firm lands around **5–10k SEK/mo** — the revenue an FSM
    vertical competes for.
  - Fastighetssystem: [Momentum packages 5,900–25,200 SEK/mo](https://www.momentum.se/prisplan-fastighet/)
    (rare public pricing, sized by apartment count); Pigello and Vitec are quote-only —
    proxy: [~11,580 SEK/mo for ~500 apartments](https://businesswith.se/system/pigello/).
  - Board portals price **per BRF**: [Boardeaser 599–999 SEK/mo, BRFs from ~299 SEK/mo](https://boardeaser.com/priser/brf/)
    — a direct market anchor for per-scope platform pricing (§9).
  - Modular per-engine precedent: [Fortnox sells modules at 89–369 SEK/mo](https://www.fortnox.se/produkt/prislista)
    on top of packages; [Odoo €19.90–29.90/user/mo](https://www.odoo.com/pricing).

### 7.6 Price anchors (what the ingredients cost à la carte, 2026)

What a serious B2B SaaS team pays today for the pieces Substrat bundles — i.e., the
willingness-to-pay evidence for a platform fee:

| Ingredient | Vendor | Price | Source |
|---|---|---|---|
| Auth + orgs (B2B) | Clerk | $25/mo + $0.02/MRU; B2B add-on $100/mo + ~$0.60–1/org/mo | [clerk.com/pricing](https://clerk.com/pricing) |
| Enterprise SSO/SCIM | WorkOS | $125/connection/mo (volume → ~$65) | [workos.com/pricing](https://workos.com/pricing) |
| Auth (B2B plans) | Auth0 | $800/mo per 1,000 MAU, 5-SSO-connection cap | [auth0.com/pricing](https://auth0.com/pricing) |
| BaaS | Supabase | Pro $25/mo; Team (SOC2, SSO) $599/mo + usage | [supabase.com/pricing](https://supabase.com/pricing) |
| Integrations infra | Nango | $50–500/mo + $1/connection/mo | [nango.dev/pricing](https://nango.dev/pricing) |
| Unified integrations API | Merge.dev | $650/mo for 10 linked accounts, then $65/account/mo | [merge.dev/pricing](https://www.merge.dev/pricing) |
| Embedded integrations | Paragon | not public; reported $15k–50k+/yr | [nango.dev/blog](https://nango.dev/blog/paragon-pricing/) |
| Durable jobs/workflows | Inngest | Pro $99/mo per 1M executions | [inngest.com/pricing](https://www.inngest.com/pricing) |
| Internal-tool UI | Retool | ~$10–50/builder + $5–15/internal user/mo; external users tiered | [retool.com/pricing](https://retool.com/pricing) |
| App platform (top of market) | Salesforce Platform | $25–150/user/mo | [salesforce.com](https://www.salesforce.com/platform/enterprise-app-development/pricing/) |
| Prompt-to-app | Lovable / Bolt / Replit | ~$25/mo prosumer + usage credits | [lovable.dev/pricing](https://lovable.dev/pricing) |
| Boilerplate | MakerKit / ShipFast | $199–649 one-time | [makerkit.dev](https://makerkit.dev/) |
| Post-hoc hardening | consultancies | £1.5k–5k fixed per app; ~$6k–32k year-one true cost | [originalobjective.com](https://www.originalobjective.com/software-development/vibe-coding-production-support) |

Read: a vertical team assembling identity + orgs + integrations + jobs + a compliance
story from parts pays roughly **$1–3k/mo before writing a line of domain code** — and still
owns the glue. That bracket is the à-la-carte anchor for kernel pricing. The verticals
themselves price against per-user incumbents (§7.5 numbers).

### 7.7 Who gains most: the niche-vertical cost curve

A production-grade foundation costs roughly the same to build whether the product will
serve 50 seats or 50,000 — tenancy, auth, audit, and GDPR don't get cheaper because the
market is small. Horizontal players amortize that fixed cost over enormous N. A niche
vertical (CRM for one trade, order management for one supply chain, förvaltning for one
region) cannot — which is why niche B2B prices run at multiples of volume tools (visible
in §7.5: package-priced fastighetssystem at 5,900–25,200 SEK/mo against volume FSM at a
few hundred SEK per user), and why the long tail below "fundable SaaS" stays on
spreadsheets, Access databases, and — lately — vibe-coded internal tools.

Substrat collapses the equation twice: AI removes most of the domain-logic cost, and the
kernel converts the foundation from a fixed build into a per-tenant fee. **The relative
gain is therefore largest exactly where the user base is smallest** — enterprise-priced
niche services with high ACV and few seats. Their buyers also demand the most compliance
(procurement checklists, SSO, audit trails, DSAR) — which is the kernel's product, not the
vertical's problem. Consequences:

- **ICP sharpened**: the ideal Substrat vertical is small-N, high-ACV, compliance-touched —
  the segment where foundation cost, not demand, is the binding constraint. Every owned
  vertical (§8) already has this shape.
- **Pricing headroom**: a kernel fee that is a rounding error against niche ACVs is still
  an order of magnitude cheaper than building the foundation once. Price the kernel on
  value per vertical, not cost-plus — and expect it to differ across verticals.
- **Revenue math flips**: small-N verticals yield few scopes, so per-scope fees alone
  under-monetize them; the value-based platform fee and engine licensing carry the load
  there, while per-scope pricing shines in many-scope shapes (förvaltning, chains).

The portfolio statement of the same fact: **no single niche vertical can justify building
the foundation; a portfolio of them can — but only if the foundation is shared.** That is
the substrate business.

### 7.8 Lessons worth stealing from the field

Product mechanics to adopt:

- **"View as user" everywhere** (Appian's security preview): permission trees are only
  debuggable if an admin can render any screen as any role @ any node. Build into the app
  shell and as an MCP tool ("show what boende X sees in scope Y") — also the single best
  demo prop for the permission model.
- **Ambient tenancy, zero-argument** (OutSystems O11): the vertical never passes
  tenant/scope IDs — context is ambient in the RPC stub. O11 proves the ergonomics work;
  its successor *dropping* the feature proves substrate tenancy can't be a bolt-on — it is
  the kernel's reason to exist.
- **One reviewable security surface** (Base44's dashboard, done right): the §4 human
  checkpoint needs permission changes rendered as one human-readable diff — who gains
  what, where in the tree — not a scattered code review.
- **Agents never touch prod** (Replit's deleted-production-database incident): preview
  scopes with seeded data as a kernel primitive; agents build and test there by default;
  per-scope PITR (§5.2) makes rollback structural rather than heroic.
- **Governance at generation time too** (Superblocks' Clark): runtime enforcement stays
  the moat, but the scaffolder should inject security defaults, the design system, and
  conventions at generation so agents *start* compliant instead of iterating against
  rejections. Cheap for us — it's skills + templates (§5.6).
- **Push upgrades, not mailed scripts** (Salesforce 2GP vs Odoo/OCA OpenUpgrade): the two
  ecosystems bracket the upgrade design space — Salesforce ISVs push managed-package
  upgrades into every subscriber org centrally, without customer action; Odoo Community
  outsources migration scripts to an under-funded nonprofit and upgrades lag releases by
  up to a year. Engine upgrades must be a kernel workflow the engine owner executes
  fleet-wide (kernel-design §5.3's journal + sweep is the substrate), never an artifact
  verticals apply themselves (§11; kernel-design open question 12).

Commercial lessons:

- **Audit is default-on; compliance-grade audit is the SKU** (Salesforce Shield runs
  ~10–30% of net spend): never charge for the audit log existing (§9's usage rule);
  charge for long retention, field history, SIEM export, DSAR tooling.
- **Never meter platform-native growth** (ServiceNow's custom-table true-up trap):
  per-table/per-config pricing punishes exactly the adoption the platform wants.
- **Expect pressure on the seal** (SAP's 2025 retreat from binary clean-core to graded
  A–D levels, admitting the strict rule was "too restrictive" for real installed bases):
  even the right sealing rule gets renegotiated once builders hit it. The answer to every
  future "one more hook" demand is extending the manifest vocabulary (as decision 26 did
  with substates), never a schema exception — grade the extension surface, don't breach
  it.
- **Anti-anchor for end-user pricing** (Power Pages at $200/site/mo per 100 authenticated
  users): per-external-user metering is why enterprise portals stay unadopted; §9's
  bundled-MAU stance is the counter-position.
- **Trust page early** (trust.retool.com / trust.lovable.dev; Lovable shipped SOC 2 + ISO
  27001 within a year of its CVE): publish the isolation test-suite results and a
  certification trajectory before anyone asks — the trust moat (§7.4) needs visible
  machinery, and the bar for "credible young platform" is now roughly one year to SOC 2.
- **Eject stories are fake everywhere** (OutSystems' one-way detach, Base44 exports that
  die without the SDK): the field has trained buyers to disbelieve portability claims —
  which makes a demonstrably real exit (AGPL + pure-SQLite adapter, §5.7/§9) rare
  positioning. Demo the eject the way we demo the tenant-boundary failure.

Architecture, for later:

- **Control-plane/data-plane split** (Superblocks' on-prem agent executing queries inside
  the customer's VPC): a data plane in an EU-sovereign or customer environment under a
  SaaS control plane is the eventual answer if "EU regions on US clouds" stops satisfying
  buyers (§7.3). The adapter rule (§5.7) keeps this reachable without redesign.

### 7.9 Non-goals: where Substrat is the wrong tool

The mirror of §7.7's ICP, kept explicit so the boundary stays reviewable (decision 27).
Each of these is a "no" from the placement spectrum (§6) or the cost curve (§7.7), not a
missing feature:

- **Enterprise applications proper.** Fortune-500 procurement buys walled-garden trust —
  certifications, integrator armies, indemnification; the platform-landscape research's
  cleanest finding is that winning that tier has historically required owning the runtime
  (Salesforce/SAP/ServiceNow). The code-ownership + eject stance is the right trade for
  SME/midmarket EU verticals and deliberately the wrong one there.
- **Data- or scale-heavy single tenants.** The scope-per-customer shape caps around 10 GB
  of hot state per scope (§5.2); a tenant with hundreds of millions of hot rows in one org
  does not fit the architecture. Tier 2 widens analytical reads, not the per-scope write
  path.
- **Deep-domain-moat products.** Accounting, payroll, reskontra/inkasso, core banking:
  the moat is decades of domain logic, not foundation cost — §7.5's boundary generalized.
  Integrate (Fortnox/Visma), never rebuild.
- **Products whose foundation isn't the binding constraint.** Consumer-scale apps,
  ML-first products, realtime-collaboration-first tools, dev tools: different physics; the
  kernel's guarantees aren't their bottleneck, so the platform fee buys them little.
- **Internal tooling.** Retool/Superblocks/Power Apps own that shape; without nested
  tenancy or a per-tenant compliance surface, the kernel's product is mostly dead weight.
- **A general prompt-to-app backend.** The median generated app has no tenants (§7.4);
  unopinionated wins there. Only the B2B slice, and only post-operator-proof.

The pattern behind the list: Substrat fits where apps are **structurally repetitive but
operationally rich** — workflow-shaped B2B products whose foundation (tenancy, permissions,
audit, GDPR) is the expensive, identical 80%, and whose differentiation is vocabulary,
states, and compliance content. Where the foundation isn't the cost driver, or a single
tenant's scale or a domain's depth is, the substrate stops paying rent.

## 8. Concrete cases and sequencing

### 8.1 Case 1 — Förvaltar-OS for PropCo (anchor)

PropCo: a long-established regional förvaltningsbolag with several offices, BRF +
commercial, existing internal work orders/hour registration and a self-built board portal. Built as internal
replacement first, productized second. Exercises nearly the whole kernel: two-level tenancy
(PropCo → hundreds of BRF scopes), the full permission tree (staff, fältpersonal, styrelse
per scope, boende per scope), fastighet→byggnad→objekt→komponent asset hierarchy,
ärende→arbetsorder→tid, ronderingar/protokoll, documents, Fortnox, felanmälan portal,
cross-scope reporting, import-from-incumbents tooling.

**The FSM vendor as bridge, not alternative**: PropCo signs the FSM vendor this fall
(shortest term; API tillval and data export as conditions). It becomes production system,
living requirements spec, and migration-tooling test target. Every friction PropCo's team
hits in it is an observed, prioritized backlog item. Acceptance test for switching: **run both systems in parallel for
one full month-end and diff the fakturaunderlag.**

**Under review as of 2026-07-19** (§11, first bullet): the friend is weighing building the
FSM instead of subscribing. Decision 8 stands until re-ratified at a human checkpoint —
what needs answering first is what then plays the roles the subscription was bought for
(production system, requirements spec, diff target for the parallel run), and what the
fallback is if the engine is not field-ready in time.

Customer-zero bias to guard: PropCo validates the FSM core, not the regulated
branschmoduler (F-gas, OVK, borr) — those need a design partner from that world later; keep
the core honestly generic.

### 8.2 Case 2 — HouseCo eftermarknad + kundresa (shape-breaker)

Deliberately different shape: lead-centric and project-centric. Lead → offert → kontrakt →
husprojekt (long-running, milestones) → leverans → eftermarknad, where eftermarknad is the
same ärende/arbetsorder engine bound to a delivered house. Customer portal for the byggresa.
Proves the attachment contracts are generic, not secretly förvaltnings-shaped. Starts only
when case 1's ärende engine is extractable — its whole point is reuse.

### 8.3 Case 3 — POSCo adopts kernel services (hardener)

No replatform of a live POS with paying customers. Piecemeal, reversible adoptions that
harden individual contracts: auth → the auth platform (the byrå feature *is* nested tenancy),
Fortnox sync → integrations hub, events → reporting spine. The same hardener role MediaCo played for the auth platform.

### 8.4 Case 4 — FSM-vendor competitor (derived, not built)

Once case 1's arbetsorder/tid/protokoll/schemaläggning engine runs in the field, an
installations-FSM is that engine + new asset vocabulary + vertical protocol packs + EDI.
Find one design-partner kylfirma/ventilationsföretag — plausibly one of PropCo's own
subcontractors.

**The network wedge**: PropCo sits on the beställare side of hundreds of underentreprenörer.
Arbetsorder issued in PropCo's system → received in the subcontractor's own (cheap/free)
instance → time, photos, protokoll flow back → fakturaunderlag lands automatically. Every
förvaltningsuppdrag PropCo wins seeds subcontractor accounts; distribution rides existing
commercial relationships. The FSM vendor sells single-company tools; a beställare–utförare network is a
different category, only available to someone who *is* a large beställare. Technically it is
§5.4 productized.

**Settled 2026-07-19 (§11): no acquisition.** The "buy the vendor outright and re-platform
over years" branch — decades of vertical knowledge and distribution at 10x the commitment —
is closed, not deferred. The live question moved in the other direction: **build the FSM
rather than subscribe to it**, then resell. That is this section's engine arriving earlier
and without decision 8's bridge underneath it; the reselling half is unchanged. The cost is
carried in §8.1 and §11, not here.

### 8.5 Sequencing (staggered, never parallel greenfields)

1. Kernel-first: tenancy tree, permission model, event schema, module manifest, i18n —
   built as part of case 1, not before it.
2. Case 1 as the vehicle; FSM-vendor bridge signed; POSCo's auth-platform adoption runs early in
   parallel (existing muscle).
3. Case 2 when the ärende engine extracts. 4. Parallel-run month-end → PropCo migrates.
5. Subcontractor network opens as first external market. 6. Branschmoduler + head-on FSM-vendor
   competition from a position of running product and captive distribution.

Team reality: ~7 people across existing ventures. Three simultaneous greenfields is how
kernels become the reason nothing ships.

## 9. Commercial structure

**Ownership map** (write down before code): kernel — the kernel owner's side. Engines — the
kernel owner's side as licensed modules, friend's teams contribute domain knowledge under
CLA (the AGPL+CLA muscle proven on the auth platform). Verticals — the friend's companies: branschlogik, GTM, customers. If
engines end up on the friend's side, the "platform" is an empty substrate and should be priced
as one — be honest about which product is being sold.

**Fee model — four meters, priced asymmetrically.** Two user populations exist: the
customer's staff, and the customer's customers (boende, styrelse, subcontractors,
consumers). They must not be priced the same way. And the meters weigh differently per
vertical shape (§7.7): many-scope verticals monetize through meters 1 and 4; small-N,
high-ACV niche verticals through a value-based platform fee and engine licensing — don't
flat-rate the kernel across verticals.

1. **Base platform fee** per tenant + per active scope. Precedent: the whole market prices
   orgs (Clerk ~$0.60–1/org/mo at volume, WorkOS $125/connection/mo, §7.6); per-scope is
   the kernel's natural unit and maps to per-BRF/per-filial value — and the end market
   already pays per scope (board portals at ~299–999 SEK/mo per BRF, §7.5).
2. **Per-engine licensing**: entitlement flags are already SKUs — pricing per engine is the
   module system turned commercial. Swedish SMEs accept modular pricing (Fortnox sells per
   module; Odoo per app). Licensed engines carry the small rev-share kicker; full revenue
   share on someone else's vertical means auditing their P&L forever — avoid.
3. **Usage** (Tier-2 events retained, storage GB, API calls): generous included tiers,
   transparent cost-plus overage — WFP makes per-tenant attribution clean. Rule: usage fees
   track cost, never profit — punishing full audit trails punishes the moat.
4. **Network transactions**: a cross-tenant arbetsorder (§5.4, §8.4) is a countable,
   high-value event; per-transaction fee scales with the network rather than seats and is
   structurally unavailable to single-company tools.

Staff seats are the **vertical's** revenue (their GTM, priced against §7.5 incumbents);
the kernel charges the vertical, not the end customer. End-users are never seat-priced —
bundled MAU with overage (the Clerk shape) — or portal and network adoption dies.

**Engines and integrations as a revenue stream** — three forms: (a) design partners fund
engine v1 as paid development, IP stays kernel-side under the CLA (new engines get built
without speculative kernel investment — the one-step-ahead rule holds); (b) the engine then
licenses per-tenant/mo as a module; (c) connectors: table-stakes ones (Fortnox, BankID)
bundled, premium ones (EDI grossist, branschprotokoll packs) priced per connection —
the market already does this (Fieldly retails EDI at 399 SEK/mo, §7.5; Merge's
$65/account/mo and Nango's $1/connection are the infra-side anchors, §7.6).

**N=1 honesty**: with one customer group this is a development partnership wearing a
platform license as a costume. Two acceptable framings: (a) partnership pricing (fees +
services fund buildout; preferential terms + roadmap influence) converting to arm's-length
pricing at the second external consumer; or (b) fold the kernel into the auth platform's natural
expansion (identity → orgs/tenancy → integrations → documents → events) with the friend
group as design partner #2 after MediaCo — the version with a market beyond one friendship.

**Trust structure / exit path** (protects the friendship and enables the bet): AGPL
kernel + commercial license + hosted control plane + support, or source escrow at minimum.
Converts "existential dependency on the kernel owner" into "we pay for the good version of something
we could self-host in a pinch" — made literally true by the pure-SQLite adapters (§5.7),
single-node but runnable — and is the same pitch that sells to strangers later.

**Who builds the verticals** — verify before pricing anything. The friend has salespeople
and operators; vertical teams on Substrat need one or two technically-literate people
wielding AI against a platform designed for it (which matches the team he has), plus the
two human checkpoints (§4). If capacity is thinner: the kernel owner's team builds vertical v1 as
paid work, handover priced explicitly.

**Governance day one**: where the kernel legally lives (own entity or clearly owned
codebase), versioned contracts, because the consumers have different owners. Cheap to decide
now; a negotiation after PropCo runs on it.

## 10. Risks

1. **Platform trap**: kernel features nobody consumes yet = the trap announcing itself.
   Mitigation: the one-step-ahead rule (§6).
2. **N=1 economics**: platform fee from one group won't fund the kernel for years.
   Mitigation: §9 framings; auth-platform convergence.
3. **Convergence** from Lovable-above / Supabase-below / Salesforce-downmarket.
   Mitigation: trust moat (§7.4), EU positioning, vertical depth.
4. **Team spread**: ~7 people, two companies, now three-plus initiatives. Mitigation:
   staggered sequencing (§8.5); PropCo runs on the FSM vendor until the parallel-run test passes.
5. **Customer-zero bias**: PropCo validates FSM core, not regulated branschmoduler.
   Mitigation: design partner from the trades before case 4 ships modules.
6. **Live-product risk (POSCo)**: replatforming a POS breaks it. Mitigation: service
   adoption only, each step reversible.
7. **Cross-ownership friction**: kernel and verticals owned by different people.
   Mitigation: §9 governance, escrow/AGPL, decision log.
8. **R2 SQL beta risk**: mitigated by Iceberg-as-contract; engine swappable.
9. **Cloudflare concentration**: the entire runtime sits on one vendor — pricing, limits,
   deprecations, or Cloudflare moving up-stack. Mitigation: adapter rule (§5.7) — contracts
   are pure interfaces, the pure-SQLite adapter stays green in CI, DO is an adapter not a
   dependency.
10. **Key-person concentration (kernel)**: design, taste, both §4 checkpoints, and the
    source assets resolve to the kernel owner — bus factor ≈ 1, spread across three
    ventures. Escrow (§9) protects consumers, not the venture. Mitigation: the agent
    artifacts double as onboarding (specs, skills, decision log, contract tests); a second
    kernel-fluent person is a named milestone **before** the parallel-run test — once
    PropCo runs on the kernel, bus factor 1 is a customer's problem.
11. **Single-relationship demand**: all four cases — demand, validation, and network-wedge
    distribution — route through one friendship, and as of 2026-07-19 that friendship has a
    mapped perimeter (§11): a single owner group of ~five companies — PropCo (förvaltning),
    HouseCo, POSCo, a property-owning arm, and an e-commerce business. Concrete, and
    therefore concretely correlated: they share owners, so they wobble
    together. Distinct from risk 7 (friction): if the
    relationship or the friend's businesses wobble, the entire market side disappears at
    once. Mitigation: §9 framing (b) (auth-platform convergence) is a real second leg, not
    a fallback; document-product re-platforming (decision 17) gives the kernel a consumer
    outside the friendship.

## 11. Open questions

- ~~Does "buy the FSM vendor" mean subscribing or acquiring the company outright?~~
  **Answered 2026-07-19: neither.** No acquisition — §8.4's "10x commitment" branch is
  closed. But the friend is now considering **building** the FSM rather than subscribing to
  the vendor, and reselling it. Read narrowly this changes less than it sounds: the FSM he
  would build *is* case 1's arbetsorder/tid/protokoll engine reaching the field, and
  reselling it is case 4 exactly as written (§8.4, network wedge included). What it removes
  is the **bridge** — and decision 8 bought three things with one signature: a production
  system for PropCo this fall, a living requirements spec (every friction an observed
  backlog item), and the parallel-run month-end acceptance test. Replacing them is now the
  open question, and D-8 needs re-ratifying at a human checkpoint rather than lapsing by
  drift. Candidate replacement for all three: **PropCo's existing internal system** —
  work orders, hour registration, and its board portal are a real incumbent with real
  fakturaunderlag, so the month-end diff has a target that costs nothing and exports no
  data to a competitor. What it cannot replace is decision 8's actual rationale — *don't
  run a business on a half-built tool* — so name the fallback before the build starts: if
  the engine is not field-ready by month X, does PropCo sign the vendor after all?
- Who, concretely, are the friend's builders? Names, hours, stack fluency. **Partially
  answered 2026-07-19** (identifying detail is deliberately kept out of this repo — the
  companies are real and this document is public; pseudonyms only): the group is one
  ownership structure of ~five companies — PropCo, a house factory (case 2), a
  POS-software company (case 3), a property-owning arm, and an **e-commerce business no
  case covers**. §8.1's "several offices" resolves to five. Two things this pins down:
  PropCo sells *both* ekonomisk and teknisk förvaltning, so decision 10 (ekonomisk out of
  v1) means part of the customer's own P&L is out of scope for v1 — the migration story
  must not assume the whole company moves; and §8.1's "self-built board portal" is a
  shipped product with real board users, making case 1 a portal *migration*, not a
  greenfield portal. Still open, and §9's "who builds the verticals" cannot be priced
  without it: names, hours, stack fluency. Note this **sharpens rather than softens risk
  11** — mapping the group does not diversify it; five businesses inside one ownership
  structure fail together.
- ~~Kernel legal home~~ **Answered 2026-07-19: a new legal entity.** Three consequences to
  execute rather than assume: it must be the **single copyright holder** decision 25's
  AGPL + commercial dual license depends on (no single holder, no commercial grant), so
  contributions from the group's companies need CLA or assignment **from the first commit**
  — retrofitting an assignment across five companies' payroll is the expensive version; it
  is the natural home for decision 32's explicitly-undecided "hosting-org legal home" and
  for §9's escrow party, so decide whether the hosting entity is the same company or a
  subsidiary before certification scoping starts (the ISMS is scoped to a legal entity);
  and IP created by group staff on group time must be assigned in **before** code, not
  during a later diligence.
- Storage shape for förvaltar-OS: **Shape A proposed 2026-07-19** (was: Shape B presumed).
  The benchmark still gates it, but its *question changes*, because the
  [documented limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
  settle the sizing half outright: 10 GB per DO, unlimited objects, ~1,000 req/s soft limit
  per object — against a scope that is **one BRF**. Size was never going to bind. What
  actually binds, and what the benchmark must now price:
  - **There is no export.** No `wrangler` export, no import, no HTTP query API — Cloudflare
    states plainly that with SQLite-in-DO "you may also need to build some of your own
    database tooling that comes out-of-the-box with D1." Data leaves a DO only through code
    we write. This lands on three promises at once: §5.7's exit story ("self-host in a
    pinch" requires getting data *out*), decision 32's auditor-facing evidence export, and
    GDPR portability/erasure. **Consequence, and arguably the right one anyway:** per-scope
    export becomes a **kernel contract** (`exportScope`-shaped) on `ScopeStub`, exercised by
    the contract tests on both adapters. Shape A does not create that requirement — the
    escrow story already did — it only removes the free implementation.
  - **PITR is better than D1's, and untestable locally.** 30 days, bookmark-addressed, and
    the recovery itself is undoable. But "not supported in local development", so the
    recovery guarantee is the one kernel promise the contract-test suite structurally
    cannot cover. Say so out loud rather than implying coverage.
  - **No documented migration path in either direction**, DO-SQLite ↔ D1. This is
    kernel-design open question 13 with the vendor half removed: if Shape A ships, the
    A→B escape hatch is entirely our code, unassisted. Either prove it once on a throwaway
    scope early, or accept that B is not a hatch we actually have.
  - **The prize for Shape A is not shipping Shape B at v1.** One backend, one set of
    contract tests — and it *retires* kernel-design questions 7 (D1 EU-residency wording:
    DO jurisdictions are a hard guarantee, D1 offers hints) and 10 (D1 physical layout).
    The EU claim gets stronger, not weaker. Against the §10 platform trap, building both
    storage backends before either has a second consumer is exactly the kind of unconsumed
    kernel feature the plan says not to build.
  - Smaller edges to design around, not decide on: 100 columns/table, 2 MB max row/BLOB,
    **100 bound parameters per query** (caps batch size in §8.1's import-from-incumbents
    tooling), single-threaded writer, no read replicas. Cold-start/wake latency is
    **undocumented** — so kernel-design question 8's latency budgets must be measured, not
    looked up, and the benchmark is the only way to learn them.
  - Cost model to watch: DO SQLite bills **rows written** ($1.00/M beyond 50 M/mo), and
    every indexed column adds ≥1 row written per insert, every `setAlarm()` is one row. A
    kernel where every mutation emits a fat event, an outbox row and an audit entry makes
    rows-written the dominant meter. §9's meter 3 says usage fees track cost — this is the
    cost they must track.
- R2 SQL benchmark (≈50M events / 500 scopes) — **limits answered 2026-07-19; criteria and
  date proposed below.** Status is still **open beta** ("supported SQL grammar may change
  over time"), so the decision-17 fallback — DuckDB over the same Iceberg catalog — stays
  live and this remains a *scheduling* question, not an architectural one.
  - The **SQL surface is no longer the risk**: all standard JOIN types, window functions,
    CTEs, subqueries, GROUPING SETS/ROLLUP/CUBE, QUALIFY, 163 scalar + 33 aggregate
    functions. Read-only, Parquet only. Notable absences: **`OFFSET` is unsupported**,
    UNNEST/PIVOT, LATERAL, named `WINDOW` clauses.
  - **Hard row cap: `LIMIT` maxes at 10,000, and with no `OFFSET` there is no pagination.**
    You cannot walk past 10,000 rows. Aggregate reporting is unaffected; anything wanting
    row-level output at volume — a fakturaunderlag reconciliation dump, an audit extract —
    needs a different path (a job reading the Iceberg tables directly). §5.3 claims Tier 2
    serves "reporting, reconciliation, audit"; the first is fine, the other two need this
    checked against real queries.
  - **Duration, concurrency and rate limits are undocumented.** What exists instead is a
    pre-flight **budget gate**: memory-heavy queries are rejected with a 400 before running,
    and that gate covers `MEDIAN`, `PERCENTILE_CONT`, `ARRAY_AGG`, `STRING_AGG`, every
    `DISTINCT` aggregate, and **all window functions**. Resource exhaustion mid-flight
    surfaces as a 502. So the honest pass/fail criterion is not a latency number we could
    look up — it is *do our real queries clear the gate*.
  - **Pricing: $0.0025/GB scanned ($2.50/TB), 10 GB/month included, minimum 10 MB billed
    per query**, failed queries free; billing not yet enabled, with 30 days' notice
    promised — so benchmarking now is nearly free. That **10 MB minimum has a design
    consequence**: a per-scope dashboard query costs 10 MB whatever it scans, so 500 scopes
    is 5 GB per sweep — half the monthly included allowance for *one* refresh. Per-scope
    dashboards must therefore never hit Tier 2 directly; they need a read model. That makes
    kernel-design question 3's optional read-model sink **not optional** if scope-level
    dashboards are a product requirement — which §8.1's styrelse/boende portals imply.
  - Proposed pass/fail, in place of the unspecified one: (1) the three reports PropCo
    actually needs each run without a 400 (budget gate) or 502; (2) each is expressible as
    an aggregation returning ≤10,000 rows, with anything that isn't explicitly routed to a
    direct-Iceberg export job; (3) bytes scanned × refresh frequency priced against
    $2.50/TB stays under the usage fee §9 meter 3 would charge. Date: run it against a
    synthetic generated from **case 1's real event shapes**, once those exist — a synthetic
    invented before the event schema tests nothing — and gate it before the first
    cross-scope report reaches a customer.
  - Catalog maintenance (relevant to the same benchmark): compaction targets are
    configurable 64–512 MB; snapshot expiration defaults to 30 days *and* retain-last-5,
    both conditions required. Orphaned files are never cleaned. Run frequency is
    **undocumented** — measure it empirically via the `r2CatalogTableMaintenanceAdaptiveGroups`
    GraphQL dataset rather than assuming a cadence.
- ~~Which Nordic SMS + email providers~~ **Answered 2026-07-19, but off-question**:
  Twilio / SendGrid / Resend / Postmark are the proposed list. All four are viable and all
  four are **US-owned**, which is the criterion the question was actually about — once
  decision 32 lands, every transport is a named sub-processor with a GDPR Art. 28 transfer
  story, and the trust page inherits whatever the register says. The list also drops the
  leg §6's buy table named: **Nordic SMS** (46elks-class), where alphanumeric sender-ID
  registration and Swedish operator handling are the whole reason a local provider exists.
  Proposal: default **Resend** (email) + one Nordic SMS provider, verify per-vendor EU
  residency and DPA terms before any trust-page claim (D-32: trajectory, not claim), and
  ship **two** implementations of the transport adapter from day one — an adapter with a
  single implementation is a wrapper, and §5.7's per-tenant selectability is what an
  enterprise tenant will demand anyway.
- Techy friend: advisor, collaborator, or competitor? Decide what role the RFC recruits for.
- Public brand trademark/domain pass for "Substrat" before launch (Groundplane as fallback).
- Prompt-to-app channel (§7.4): if/when the demo exists, which entry first — a builder
  integration (Lovable/Bolt-class), Claude Code templates, or hardening consultancies as
  resellers? What would a self-serve tier have to cost? Shape and gotchas worked out in
  [design/generated-verticals.md](./strategy/generated-verticals.md) (proposed, not scheduled);
  two of its findings bear on this choice regardless of the channel: a generated vertical's
  **permission diff needs a competent reviewer** — if that is the builder themselves, the
  checkpoint is a rubber stamp and the thesis voids (§6.1 there), which is an argument for
  the consultancies-as-resellers entry; and the channel succeeding **breaks §5.5's
  one-deployment-per-vertical** (§6.3 there), since a builder is a vertical owner and N
  deployments would equal N generated apps.
- Offline scope for fältpersonal (case 1): which flows must actually work offline
  (basements, machine rooms), and is append-only capture sufficient? Binds the
  event-shaped write design — decide with PropCo's field staff, not in the abstract.
- Document-product re-platforming (decision 17): when does it start, and who owns it given
  team spread (risk 4)? Extraction is case-1-timed; the re-platform must not become a
  third greenfield.
- Engine upgrade execution across deployed verticals (§7.8 push-upgrades lesson;
  [research drilldown §7](research/platform-landscape-drilldown.md)): kernel-design §5.3
  pins per-scope migration mechanics within one deployment, but who runs an engine
  version upgrade across verticals — including engines licensed to strangers (§9) — and
  what revalidates vertical-declared substates and custom fields against the new engine
  version? The most documented failure mode across every platform ecosystem studied;
  kernel-design open question 12.

## 12. Decision log

<!-- GENERATED by tools/decisions.mjs from docs/decisions/*.md — do not hand-edit rows. -->
| # | Date | Decision | Rationale |
|---|---|---|---|
| 1 | 2026-07-12 | Kernel, not platform: no domain entities in core; attachment contracts instead | Avoids Salesforce/EAV problem; keeps verticals flexible (§3, §5.5) |
| 2 | 2026-07-12 | Runtime enforcement over conventions/codegen | The one property templates and Baseplate can't copy; survives model improvement (§4) |
| 3 | 2026-07-12 | Two-level tenancy (tenant → scope), tree-shaped permissions | Recurs in every case; retrofit near-impossible (§5.1) |
| 4 | 2026-07-12 | DO = consistency domain (scope), not tenant | Blast radius + size caps (§5.2) |
| 5 | 2026-07-12 | Three data tiers; events cross boundaries, queries don't; Iceberg as contract | Integrity + engine replaceability (§5.3) |
| 6 | 2026-07-12 | No dynamic/EAV schema; module-owned migrations + typed custom fields | Flexibility no vertical needs vs real costs (§5.5) |
| 7 | 2026-07-12 | Vertical #1 = förvaltar-OS (PropCo), not FSM-vendor replica | Operator depth + customer zero; FSM market crowded with no edge (§8.1) |
| 8 | 2026-07-12 | FSM-vendor subscription as bridge + requirements spec; parallel-run month-end as acceptance test | Don't run a business on a half-built tool (§8.1) |
| 9 | 2026-07-12 | POSCo adopts services piecemeal; no replatform | Live product, paying customers (§8.3) |
| 10 | 2026-07-12 | Ekonomisk förvaltning out of v1; integrate Fortnox/Visma | Incumbent moat; regulated; bank integrations (§7.5) |
| 11 | 2026-07-12 | Build contracts + control planes; buy engines | Team size; moat location (§6) |
| 12 | 2026-07-12 | Name: **Chassis**. Tagline: **The hard parts, hosted.** | Structure+engines+wiring in one word; only dead squatters; Swedish-native pronunciation. Groundplane = fallback |
| 13 | 2026-07-12 | Master doc = canonical; PDFs/decks are dated exports | Single source of truth (§0) |
| 14 | 2026-07-12 | Every kernel contract ships a Cloudflare adapter **and** a pure SQLite adapter; contract tests pass on both | Auth-platform pattern; makes escrow/self-host real, hedges vendor risk, enables local dev/CI (§5.7) |
| 15 | 2026-07-12 | Spec-first contracts: TypeSpec→OAS (HTTP), AsyncAPI (events), JSON Schema (RPC); Arazzo later; SDKs/MCP/conformance tests derived from specs | Machine-readable surface is the product interface for agent builders; principle cheap now, retrofit costly; tooling deferred per one-step-ahead rule (§5.6). **Amended by 22** |
| 16 | 2026-07-12 | Identity = swappable adapter (our auth platform as default); tenancy tree, directory, and permission **model** are kernel-owned, never delegated; permission **evaluation** is an adapter (built-in default, OpenFGA-swappable) | Enforcement inputs must be kernel-owned or "swappable auth" is fiction; auth providers authenticate, they don't own org structure (§6) |
| 17 | 2026-07-12 | Document product's engine **extracts into** the kernel; the product re-platforms onto the kernel piecemeal as consumer #2 — not integrated as an external document service | One permission regime over documents (two = the leak §4 prevents); proves contracts on a second shape; extraction timed by case-1 need, re-platforming opportunistic to avoid a third greenfield (§6, risk 4) |
| 18 | 2026-07-12 | Triage rule: kernel-owned (enforcement inputs + contracts) / adapter (infra the kernel consumes: billing rails, model providers, KMS, telemetry via OTel, notification transports, search backends) / connector (capabilities tenants use, in the hub) | One test decides every future "should X be swappable" debate; event spine, tenancy/permission model, entitlements, manifest are never adapters (§5.7) |
| 19 | 2026-07-12 | Engine composition = star topology: engines talk only to the kernel (opaque refs, events, vertical-owned orchestration); chatty engine pairs merge into one engine | N kernel contracts instead of N² engine pairs (Odoo treadmill avoided); engines stay independently versionable and licensable (§3) |
| 20 | 2026-07-12 | Platform billing/entitlements = kernel; vertical-facing invoicing = engine at most (fakturaunderlag); reskontra/ekonomisk förvaltning stays a connector boundary | Entitlements gate module loading — circular if engine-owned; §7.5 boundary holds (§6) |
| 21 | 2026-07-12 | TypeScript end-to-end; runtime validation generated from specs at every trust boundary; portability via WinterTC standards surface + adapters, not WASM; pnpm/npm distribution, verticals on Workers for Platforms; WASM module slot kept open for hot paths | Team-independent case (§5.8): language is downstream of the runtime; the SDK boundary is the value; workload is I/O-bound and per-scope serialized; Go can't express the type thesis; agents are the primary users |
| 22 | 2026-07-12 | Contracts are Zod-first (zod-openapi on Hono): Zod schemas in a semver'd package are both source of truth and runtime validators; OAS/JSON Schema emitted, checked in, CI-diffed with breaking-change linting; AsyncAPI deferred; TypeSpec/Arazzo dropped until polyglot consumers exist; connectors generate validators from vendor OAS | One source of truth at the enforcement boundary — the reviewed artifact is the running validator; TS end-to-end (21) removes TypeSpec's polyglot payoff; auth-platform Hono muscle. Amends 15 (§5.6) |
| 23 | 2026-07-13 | Permission evaluation = built-in **constrained relationship-tuple engine** (FGA-shaped): fixed four-rule derivation algebra (role expansion; tenancy-tree inheritance; manifest-declared entity parent edges, depth-capped; org/group membership); no negation, no configurable rewrites; tuples scope-local, evaluated inside the scope's serialization domain; checks return tuple **proof paths**. Roles/grants stay the authored surface; verticals never see tuples; OpenFGA remains the swap target | Resolves the §11 open question (built-in vs OpenFGA) with both: DO-per-scope serialization removes Zanzibar's consistency problem (no zookies), so the mini-engine is genuinely small; entity-level portal access (the FSM shape: end customers within a filial scope) needs graph resolution the identity layer cannot do; proof paths power explain / view-as / the reviewable permission diff (§7.8). Implements 16 |
| 24 | 2026-07-13 | Name: **Substrat** (Swedish/German spelling of substrate), replacing Chassis (12); npm scope **`@substrat-run`** (org claimed on npm + GitHub; bare `@substrat` was taken), all packages renamed pre-publish; tagline unchanged: **The hard parts, hosted** | The thesis sentence already called the product "a hosted substrate" — the name is the positioning; native sv/de word keeps 12's pronunciation criterion; unscoped npm `chassis` is taken and the `@chassis` scope uncertain; adjacency to Parity's Substrate accepted as a fading brand (retired into polkadot-sdk). Groundplane fallback retired |
| 25 | 2026-07-13 | Dual licensing implemented (per §9): kernel, adapters, contract-tests, and engines under **AGPL-3.0-only + commercial**; **contracts (and future SDK) under Apache-2.0**; contributions under CLA; see LICENSING.md | AGPL makes the escrow/self-host exit real while blocking proprietary freeloading; the *interface* packages verticals import must never copyleft-capture customer applications (the moat is runtime enforcement, not schemas — §4) — the Grafana pattern (AGPL core, Apache client libs). Copyright line follows the kernel-legal-home decision (§11) |
| 26 | 2026-07-14 | Engine extension model pinned (kernel-design §7.5, K-17/K-18): verticals refine engine state machines via manifest-declared **substates** (within-state transitions vertical-owned; between-state transitions stay engine-only), and custom-field **registration materializes typed indexes** with engine list APIs accepting declared fields as filter/sort predicates | Closes the gap between §3's vertical-power promise ("extra states") and decision 6's no-EAV stance — without a mechanism, "verticals never fork engines" is discipline, not design. SAP's clean-core convergence (decades of in-core Z-table pain → sanctioned extension points) validates sealed engine schema + typed extension points; SharePoint/unindexed-JSONB is the counterexample the queryability obligation avoids |
| 27 | 2026-07-14 | Placement spectrum pinned (§6): every capability sits on build → template → engine → integrate, placed by two tests — guarantee-surface coupling (data inside the permission/audit/GDPR surface must live inside) and reshaping need (integration fixes functionality; engines reshape it within invariants). Corollaries: **engines are extracted at the second vertical, never designed ahead** (§3), and non-goals are explicit (§7.9: no enterprise-proper, no heavy single tenants, no deep-domain moats, no internal tools) | Engine reuse is the plan's least-proven hypothesis (platform-landscape research: no precedent for cross-vertical domain engines outside e-commerce), so the second-vertical extraction becomes the proof gate rather than an assumption; the spectrum explains every §6 build/buy call from one axis and gives future capabilities a placement rule instead of case-by-case debate |
| 28 | 2026-07-14 | Engine compatibility surface pinned: an engine's public contract is exactly five surfaces — exported in-scope functions, registered operations, event types + payloads, permission keys, and entity ids/`EntityRef`s. Table schema is **private**: cross-module SQL reads/writes are lint-banned (boundary-lint R5; one-time extraction handoffs via explicit `boundary-lint-allow` pragma). Evolution is **additive-only**: new operation inputs optional-with-behavior-preserving-default, emitted payload fields frozen once shipped (`schemaVersion` bump + dual-emit window for real changes), permission keys never renamed. Upstreaming from a vertical lands as **new surface, never changed semantics of existing surface**. Operations stay thin (permission check + one exported in-scope function) so verticals extend by composition, not fork | Breaking-change pressure is how the least-proven hypothesis (27) fails in practice: event breaks are silent until a consumer's runtime parse fails, and raw table reads would make every append-only migration a potential break. Naming the five surfaces makes "be careful" mechanical. Corollary of 19 (star topology), 26 (substates), 27 (extraction discipline) |
| 29 | 2026-07-14 | Event payloads get per-(type, `schemaVersion`) Zod schemas owned by the emitting engine; emit validates against them (today `payload: z.unknown()` — the manifest declares versions nothing pins); JSON Schema emitted, checked in, CI-diffed with breaking-change linting — the same pipeline as 22's API surface. Consumers keep their own lenient parse (producer-strict / consumer-lenient makes additive change safe by construction). AsyncAPI stays deferred; when polyglot/external consumers exist it is **generated** from these schemas (AsyncAPI 3 embeds JSON Schema), never hand-authored | Events are the loosest coupling and the only surface where a break ships silently; a hand-written AsyncAPI doc would be a second source of truth drifting from the running validators. Amends 22 (§5.6) |
| 30 | 2026-07-15 | **Control plane = the shared layer across N per-vertical deployments; billing deferred** ([design/control-plane.md](architecture/control-plane.md), K-20). §5.5's one-deployment-per-vertical is a *versioning and blast-radius* boundary, not duplicated platform: routing, custom hostnames, tenancy, identity, entitlements, and the Tier-2 sink are already kernel-owned and shared — the **only** per-vertical thing is the scope-DO class (the app binary). Merging the DO classes is **rejected**: it makes migrations globally ordered across unrelated verticals, merges blast radius, and forces **lockstep engine upgrades across verticals owned by different companies**. Build four things the directory was specified to hold and does not: a real `tenants` table, the §3.3 lifecycle transitions (un-archive stays a restore), an **entitlement store that finally reads `manifest.entitlementKey`**, and a `PlatformActor` + append-only **admin audit log** on every mutation (wrapping `HostAdmin`'s five unaudited methods). The admin's **effecting** half (provision/suspend/entitlements/admin-query RPC) is out-of-band host code and can never be module code (K-8: no raw DO binding — an admin vertical would be *impotent*, not dangerous); its **record-keeping** half *can* be a vertical in a platform tenant, deferred to the second vertical. Console is thin over these and is the home for the permission-diff human checkpoint. **Billing: meter, don't bill** — meters 1 (active scopes) and 2 (entitlements) fall out free; 3 and 4 are uncomputable today. Auth gates *exposing* the console, not building it *(Restated at the other altitude as [K-20](decisions/K-020-control-plane.md) — same decision, kernel layer.)* | The directory (§3.2) was specified as "the only complete inventory of tenants and scopes" and only the scope half was built — a tenant is an FK string, and D-20's entitlement gate is a field nothing reads. The console isn't a feature on a finished kernel; it's what forces the shared layer to exist. The merge rejection is §7.8/open-question-12's push-upgrade lesson applied to ourselves: adopting the Odoo/SAP treadmill to save operating a deployment is a bad trade, and the shared-bundle counter-design converts a *structural* guarantee into a *config* one — the move K-3 and K-8 refuse everywhere else. The vertical/effecting split is D-18's triage rule (effects on the outside world are connectors); the tell is that a hand-built admin audit log *is* `_substrat_outbox`. Billing deferral follows from the meters: 3 needs the Tier-2 fan-in sink (per-scope outbox can't aggregate; reads emit nothing; `drained_at` written nowhere) and 4 needs cross-tenant orders — a meter you cannot compute is a data-pipeline project, not a pricing decision. The `PlatformActor` seam is D-16 cashed in: the actions decide the auth, so building them first is what makes the auth designable |
| 31 | 2026-07-18 | **The admin's record-keeping half becomes a vertical, and is the first consumer of the tenant-facing engines** ([design/membership.md](architecture/membership.md)). Takes the option 30 deferred ("decide it at the second vertical") — the trigger fired, but not for 30's stated reason: **self-service changed the population**, not the data volume. Substrat's own admin needs members, invites, roles, plan-shaped entitlements and an audit trail; so does every hosted vertical, so these are **product engines with two consumers**, not control-plane plumbing. 30's effecting/record-keeping line is **unchanged** (K-8; provision/suspend/archive/hostnames/admin-query stay out-of-band host code, ~30% of the admin), as is D-18's connector bridge. The blocker is a **missing kernel seam**: `OperationContext` has `sql`/`emit`/`check`/`link` and no membership equivalent, so membership is mutable only via `HostAdmin.addMember`, which has **no `removeMember`, no enumeration, an unvalidated free-form `orgId` with no org record, and a `PlatformActorId` signature** — a tenant admin is a `PrincipalId` and cannot act as itself, so routing those methods would launder every self-serve membership change through a platform actor. Build membership as an **in-scope capability** on the `ctx.link` pattern (kernel owns the tuple write, module triggers it, ordinary `ctx.check` gates it); revocation must take whichever answer kernel open question 15's tuple-tombstone question takes. Cut the D-22/D-29 checkpoint at role **definition** (reviewed, CI-diffed, `defineRole` unreachable from self-service) vs role **assignment** (self-serve from a vertical-declared fixed role set), **bounded by the assigner's own authority**: a principal may assign `R` at node `N` only if they already hold every permission `R` carries at `N` — removal takes the same bound, entity-narrowed grants do not launder into unnarrowed roles, and the first admin is seeded platform-side since the bound forbids self-assignment. Note this needs a permission-**set** comparison the kernel does not expose (`ctx.check` is one permission at a time), to be settled with the seam. **Metering explicitly does not ride along**: meters 3–4 stay uncomputable, #38/#39 stay deferred until a vertical meters something; entitlements-as-plan (#33) is separable and lands with the tenant-admin surface | 30 predicted the trigger as "the platform tenant holds enough data to earn a deployment" and named the real risk as writing "the admin is never a vertical" into the log. Self-service is what actually forces it: thousands of tenants whose members join, change role and leave with no human at Substrat involved makes membership a *product surface*, and a product surface is what a vertical is for. Not taking it means building members and billing **twice** — bespoke inside the control plane, then properly as engines — and the bespoke one will not be the reusable one, because nothing forced it to be; this is 30's own "the console is what forces the shared layer to exist" applied one level up. The `PlatformActorId` signature is the tell that #34 as filed would not unblock self-service: the defect is structural, not a missing route, so adding `removeMember`/`listMembers` beside `addMember` inherits it. The definition/assignment cut identifies what D-22/D-29 were protecting — a *widening of what a role can do* must not merge unseen; assigning a person to an already-reviewed role invents no authority **once bounded by the assigner's own**, and holding it to the same gate makes self-service impossible while protecting nothing. The bound is not a detail: unbounded, any vertical that defines a role carrying assignment permission turns assignment into an escalation path — an `admin` promoting themselves to `owner` widens nothing, calls no `defineRole`, and shows up in no diff. Two consumers on day one is D-27's extraction condition met, not an exception to it — which is exactly why metering, with zero consumers, is carved out rather than grandfathered in on elegance (§10's platform trap: "kernel features nobody consumes yet"). Honest cost: a bounded issue queue becomes a sequenced program with a kernel change at its root, provisioning goes async (suspend-for-incident may stay synchronous), and the audit trail splits across the vertical's outbox and the executor's log |
| 32 | 2026-07-18 | **Hosting is the monetization boundary; certification inheritance is the paid layer.** §5.7's Cloudflare-vs-pure-adapter split is a *portability* boundary and stays exactly as written; this names the *commercial* one, which sits elsewhere: inherited controls exist only where someone operates the controls, so the compliance product is purchasable only as an operated service. Consequences: (1) the AGPL build stays **fully functional and genuinely exitable** — no feature is withheld to manufacture a paid tier, because the paid layer is not code; (2) the hosted service pursues **ISO 27001 + SOC 2 Type II first**, then GDPR Art. 28 processor-chain hygiene and EU Cloud CoC, then **EN 301 549/WCAG conformance in the app shell** (the most inheritable item on the list, since accessibility is a component-library property), with sector regimes (21 CFR Part 11, TISAX, C5, ENS, HITRUST) chased **on demand per segment, never speculatively**; (3) the auditor-facing evidence export becomes a product surface alongside §7.8's SIEM export; (4) self-hosters inherit **nothing** operationally and are served instead by a published **compliance pack** — control mapping plus evidence tooling — giving their own auditor a running start (§5.7); (5) **trajectory, not claim**: until an audit completes, the trust page publishes the roadmap and the architecture argument, never implied controls. Certification also **cannot be inherited for configuration** — a perfectly certified platform, misconfigured, is still a breach, which is what the §4 checkpoints exist for. Explicitly **not** decided here: timeline, headcount, hosting-org legal home, or whether Substrat is processor or sub-processor per deployment shape | Certification is a **fixed cost with the same shape as the foundation build** — roughly identical whether the vertical has 50 seats or 50,000 — so §7.7's cost curve repeats one level up, and the substrate collapses it the same way: fixed cost becomes per-tenant fee. The ICP makes this binding rather than nice: small-N/high-ACV/compliance-touched buyers are *defined* by procurement gates, and a three-person vertical cannot economically carry an ISMS. It also answers a question the plan had left open — **how to monetize AGPL without crippling the open version.** Open-core withholds features, which makes the free product deliberately worse and turns §5.7's exit story into the same theatre §7.8 says buyers have been trained to disbelieve; compliance-as-the-paid-layer withholds nothing and **cannot be copied by forking, because it is not code**. Most of what an audit costs is evidence that controls *operated*, and the kernel emits that structurally (audit spine, permission model, migration journal, per-scope PITR), so the defensible claim is not "you are certified" but "your evidence is continuous rather than a quarterly fire drill" — stronger and true. Pricing follows: what is bought is insurance-shaped (risk transferred, cost avoided, nothing consumed), arguing for §9's value-based platform fee over per-scope metering. **This work is unglamorous and will read as "not product" to whoever picks it up — log it as a revenue line, not overhead**, or it will lose every prioritization contest to engine work forever. Honest costs, all real: SOC 2 Type II requires an **observation window of controls operating in production with real tenants**, so it cannot be front-run — the hosting business must exist and be unremarkable before the clock starts, fixing the sequence as owned verticals → host them (tenant zero) → certify → open the licensing channel with certification as the headline; being an operator means on-call, incident management, access reviews, vendor and sub-processor management, continuity testing and a permanent ISMS, most of which is not engineering headcount; and hosting converts a kernel isolation bug from embarrassing into a **reportable breach across the fleet** — §4 already knew the stakes, this makes us the party who answers for them. Amends the framing of 25 (dual licensing) without changing its terms: 25 settled what is open, 32 settles what is paid |
| 33 | 2026-07-19 | **The builder portal is the platform vertical; milestone one is demo instantiation, not git push** (unifies #31, #33, #35, #39 and cashes in decision 31). **Four audiences, not three**: platform **staff** operating the fleet (`apps/console`), **vertical builders/hosters** signing in at substrat.run to manage their own verticals, **tenant admins** inside a vertical (a club admin in RallyPoint), and **end users**. The second was missing from the model and is D-32's paying customer — hosting is the monetization boundary, so the buyer is whoever wants Substrat to operate their vertical. That portal **is** the platform vertical D-31 committed to: its tenants are vertical builders, and it composes the same engines every vertical does — invites for their team, entitlements-as-plan for their tier, meters for their bill. Consequences: (1) **Milestone one is instantiating a DEMO vertical**, not connecting a git repo — arbitrary customer code needs Workers-for-Platforms (first-flow open question 9) and D-30 rejects the bundling shortcut, whereas a demo instance is served by that vertical's own deployment and has no such blocker. Sign up → pick a template → get an instance → validate it in production is reachable now; *connect a GitHub repo* is not. (2) **Teams and invites are not a new app**: the invites engine (shipped) contributes UI into admin surfaces that already exist, per K-15's composition model. What is genuinely absent is the builder portal itself, and that is smaller than the tracking issue implied. (3) **Demos become templates under Apache-2.0** — the same tier as `contracts`, patent grant included, because a template is *copied* rather than imported and must capture nothing. The engines it runs on stay AGPL-or-commercial, and that boundary is stated in the template or the licence misleads exactly the people it is meant to attract | The four-audience model is the correction that unlocks the rest: those four issues were describing one product without naming its customer, and "tenant-admin" was doing double duty for a vertical's own admin and for the builder's portal — which have different auth regimes (staff have no self-service signup; builders need it), different actor types (`PlatformActorId` vs `PrincipalId`, branded distinctly so the compiler refuses to confuse them) and different threat models. D-31 already said the admin's record-keeping half should be a vertical in a platform tenant; this gives it a customer and a revenue model rather than a dogfooding argument, and supplies the invites engine its second consumer. The milestone split is D-30 enforced rather than restated: one DO class per customer's code is exactly the lockstep-upgrade trap it rejects, so the honest first cut avoids needing one at all. The licensing tier follows D-25's own rule — the interface must never copyleft-capture what you build — applied to its strongest case. What that costs is real and is not a licence header: the teaching artifacts must leave the provisioning path first. Every seed mints an adversarial second tenant and an attacker principal for the cross-tenant-denial beat, and two demos resolve the acting principal from an ungated `x-principal` header. Those must survive as *tests* while disappearing from what a customer receives — the `fresh` guard is nearly the right seam |
| 34 | 2026-07-19 | **Workers for Platforms is verified to fit, so "connect a git repo" is a COMMERCIAL gate, not a technical one** (K-28). D-33 called milestone one demo-instantiation rather than git-push because "arbitrary customer code needs Workers-for-Platforms" and that was an open technical risk. It is no longer open: a user worker in a dispatch namespace **may define its own SQLite Durable Object class**, tested end-to-end rather than inferred — which is the one property the whole architecture depended on, since `defineScopeDO(MODULES)` means a vertical *is* a Durable Object rather than something that talks to one. D-30 survives intact: separate scripts, separate DO classes, no lockstep engine upgrades. What actually gates git-push now is that **WfP is a paid add-on we have not bought** (`code: 10121` on both our accounts), so it joins Regional Services (K-26) as a plan dependency in D-32's cost model. **The sequencing consequence: build the orchestration layer against the ORDINARY Workers upload API first.** Platform-owned deploys need no WfP at all — we upload with our credentials and the customer never holds a Cloudflare token, which is the whole of "we host it" — and that path provably supports DO classes because it is what `wrangler deploy` already uses for our own verticals. Move to dispatch namespaces when script count or tenant isolation demands it; the router's `verticalFor` swaps a service binding for `env.DISPATCH.get(name)`, the same `Fetcher` type, one function | This narrows D-33 rather than overturning it: demo instantiation is still the right milestone one, but for a smaller and more honest reason — not "the platform cannot host customer code" but "we have not yet needed to pay for the version that scales". Worth the distinction, because a technical blocker invites redesign and a line item invites a purchase decision, and treating the second as the first would have bought a redesign nobody needed. The spike also surfaced something no document would have: a newly-uploaded user worker is not instantly dispatchable everywhere — one scope failed with `Worker not found.` for ~15s while siblings on the same script succeeded, because its DO landed in a colo the script had not reached. Upload-succeeded is therefore not ready-to-serve, and the orchestration layer must gate hostname binding and channel promotion on a readiness check rather than on the upload response. That would otherwise have been learned from a customer |
| 35 | 2026-07-20 | **The hosted product has paid Cloudflare dependencies; they are a cost line, not a discovery** (K-26, K-28, K-30; cashes in D-32). Three separate findings each concluded "this belongs in D-32's cost model" and none of them landed there, which is how a plan dependency becomes a procurement surprise. Stated together: **Advanced Certificate Manager** (~$10/month) — required, because default hostnames are `<slug>.<jurisdiction>.substrat.run` and a two-level hostname is beyond Universal SSL's root-plus-first-level coverage. **Regional Services** — an Enterprise add-on, and what pins TLS termination; without it the EU claim has no mechanism. **Workers for Platforms** — a paid add-on, verified to fit (K-28) and **not enabled on our accounts** (`code: 10121`); it gates customer-pushed verticals, not the current milestone, because platform-owned deploys already work through the ordinary Workers upload API. **Cloudflare for SaaS** — 100 custom hostnames free on every plan, then $0.10 per hostname per month up to 50,000, which is what customer-owned domains cost. **Two domains** — a brand domain and a separate, PSL-listed domain for tenant apps, because a tenant subdomain that can set a cookie on the parent reaches the portal and every other tenant | The pattern worth naming is that each of these was found by checking rather than recalling, and three of them contradicted what seemed obvious: WfP looked like a technical risk and is a purchase decision; D1 looked like hints-only and offers real jurisdictions; KV looked like the natural cache and is incompatible with the residency claim. The costs are small individually and the point is not their size — it is that a hosted compliance product whose residency guarantee rests on an Enterprise add-on has a business dependency that must be visible when pricing is set, not when a customer asks for a DPA. Note also what is NOT a cost: nothing here gates the current milestone. Wildcard proxied DNS is free on all plans, Universal SSL covers first-level subdomains, and instances of a deployed vertical need no per-customer deploy at all |
| 36 | 2026-07-26 | **The staff admission gate moves to the audience boundary: a private vertical is self-serve end to end, and publish is where the human vouch lives** (revises builder-plane.md §4 / self-serve-deploy.md model B; the marketplace-publish.md §2 tiers were already the right cut). Model B kept admission + prod promotion staff-side for every builder vertical. That conflated two boundaries: *"may this code run on our infrastructure?"* — answered mechanically by the sandbox contract (declared bindings, WfP isolation, quotas) — and *"may other tenants run this code against their data?"* — a human decision. For a **private** vertical (tenant-owned, `listed = false`) only the first applies, and dev/staging self-serve had already conceded it: the same opaque bundle ran in the same sandbox on the same infra, so the staff prod gate was ceremony that also dead-ended the builder loop (a merged PR waited on an operator per version). Consequences: a private vertical's push lands **admitted** (`AUTO_ADMISSION_NOTE` marks it); the owner promotes every channel, prod included (`substrat push --promote prod` — the generated deploy workflow uses it, so merge-to-main is the deploy); a prod promote re-points the owner's live scopes in the same act (D-30's lockstep concern is a *shared* vertical's many tenants, which a private vertical cannot have; snapshots/forks keep their frontier, and a migration-crossing rebind snapshots first per §4 fork-before-promote); every promotion appends to `vertical_channel_history` (what went live, what it replaced, who, exactly when — the dashboard rollback picker, and each `at` is the instant a PITR restore would rewind the data to, preview-and-snapshots.md §7). The staff gate returns exactly where the audience widens: `setVerticalListed` refuses while prod points at an auto-admitted version (staff `admitVersion` upgrades it to a recorded manual vouch first), and a listed vertical's pushes land pending with prod staff-only again. The promotion-time digest acknowledgements survive unchanged for everyone — the owner is the human at their own checkpoint | The tell was a user seeing "Admission: pending / not in production" on their own private CRM with no self-serve path forward: the gate was not protecting anyone, because the only tenant exposed to the code had written it. The design docs had already half-conceded the point — builder-plane §8 held "prod promotion request" open, and self-serve-deploy admitted that admission of an opaque bundle "degrades from verified to guessed"; a guessed admission gates nothing, so keeping it mandatory bought review theatre at the cost of the product's core loop. The auto-admission *note* is the load-bearing detail: it is what lets the publish seam distinguish a version a human actually vouched for from one the shortcut admitted, so opening prod to owners does not silently weaken the marketplace gate — the human decision is preserved, relocated to the one place it means something. The auto-rebind is the second correction: D-30 separated promote from bind to avoid forced lockstep upgrades across tenants, but for a single-owner vertical that separation just meant "merge deployed nothing until someone clicked update"; scoping the follow-the-channel rebind to private verticals keeps D-30's argument intact where it applies and deletes the dead step where it does not. Honest costs: the sandbox contract is now genuinely the only thing between a builder's bundle and our infrastructure (it always was — this makes it undeniable, and §4's enforcement work correspondingly non-optional); and a compromised builder account can now ship straight to that tenant's production, so account security and the audit trail (every auto-admission and rebind is logged) carry weight the staff gate used to pretend to |
| 37 | 2026-07-27 | **Version updates carry data forward: verticals serve in place from ONE stable script per vertical; per-version scripts remain the push archive** ([#286](https://github.com/substrat-run/substrat/issues/286); K-33; supersedes orchestration.md §5.3's serving half). The gap this closes was the live product's sharpest hazard: each version was its own Workers-for-Platforms script with its own DO namespace, so Update rebound a scope to empty storage — data did not follow, and every production deploy was a manual backup→update→restore runbook with post-restore repairs. Now a prod promote re-uploads the promoted bundle onto the vertical's stable serving script (modules read back from the version's archive script, metadata from its retained manifest), DOs and data stay put, and the kernel's append-only migrations finally run against production data as designed. Secrets survive deploys (`keep_bindings`). Safety net: versions badge **code-only vs schema-change** at publish; the scope DO bookmarks (PITR) the instant before an upgrade migrates; a time-boxed, audited **rewind** (24h unless forced) is the first-hours backout, with §8 backup/restore as the considered path. Legacy scopes hop once via **adopt-serving** (export → restore → flip, data-first). Conceded: per-scope staged rollout across versions — illusory for stateful scopes — so blast radius stays per-vertical (D-30) *(Restated at the other altitude as [K-33](decisions/K-033-verticals-serve-in-place-from-one-stable-script-per-version-.md) — same decision, kernel layer.)* | The lesson worth the log: §5.3 priced dispatch scripts as stateless when the scope DO *is* the app, and the tell was that the migration machinery the kernel is built around never executed in production — when a design's central mechanism is dead code, the deploy model contradicts the data model. The benefits the old shape claimed (per-scope pinning, rollback by repointing, readiness against the live script) could not coexist with data and so were never actually delivered; the fatal cost was. The backout's honesty is enforced in the DO, not the UI — PITR rewinds the whole database, so a stale bookmark is refused where it cannot be skipped. This also cashes in preview-and-snapshots.md §7's promise that channel-history `at` anchors a PITR rewind: the anchor is now a real bookmark taken at exactly the right instant |
| 38 | 2026-07-26 | **Builders keep the substrate vocabulary; the Cloudflare mapping lives behind the platform** (#190). A vertical declares what it needs from the runtime in Substrat terms — `substrat.runtimeNeeds` in its package.json: an entry module, `needsNodeCompat`, an optional pre-bundle `build` command, and its own `stores` (binding → durable state class). At push time the CLI derives the substrate-native config (a generated wrangler config fed to the bundler via `--config`, removed after the build) and assembles the deploy manifest from the same object, so declaration and bundle cannot drift. The platform pins the compatibility baseline (`RUNTIME_BASELINE` in contracts) — a builder states needs, never substrate config, and advancing the baseline is a platform release concern. Datastores beyond own stores are deliberately absent from the vocabulary: those are platform-provisioned (self-serve-deploy.md §4's open question resolves toward the platform minting the store and injecting the id), never bundle-declared. A hand-authored `wrangler.jsonc` remains the expert/legacy path and is ignored when `runtimeNeeds` is present | The vocabulary is small *because* §4 is strict: the sandbox contract already refuses everything except a vertical's own stores, so own-stores + node-compat + a build command is not a subset of what a builder may say — it is the whole of it, which is what makes the mapping mechanical rather than a leaky abstraction. The honest limit, stated so it is not mistaken for solved: this neutralizes the *declaration*, not the *toolchain* — wrangler remains the client-side bundler in every builder's CI (`npx wrangler deploy --dry-run`), and swapping that is a different, bigger decision nobody has needed yet. The risk the gate existed for — baking CF assumptions into a "neutral" vocabulary designed inside a one-substrate world — is bounded by the same smallness: four fields, each with an obvious meaning on any substrate that can run a worker-shaped bundle with durable state |
| 39 | 2026-07-28 | **The permission registry ships in the deploy manifest; the declared surface is a per-version artifact, never a live table** (completes the §4.5 permission-diff split in control-plane.md; kernel siblings K-34/K-35). The registry — permission keys + descriptions, role templates, entity-grant shapes: exactly what `tools/permission-diff.mts` renders into `PERMISSIONS.md` — exists only at build time today; the deploy manifest carries `ownerGrants` and a `digests.permission` *hash* of it, so the platform commits to content it does not hold, which is why the dashboard grew a hardcoded third copy (`apps/dashboard/src/catalog.ts`). The manifest now carries the registry itself beside its digest: immutable per version, stamped at push, drift-proof by construction, and admission gains a mechanical version-to-version permission diff (orchestration.md's "permissions changed" badge gets its content). Rejected: a mutable "current permissions" table in the control plane (a second source of truth for a code-declared fact — drifts by design) and a self-describe endpoint on running verticals (turns a build-time fact into a runtime question and couples console/dashboard to reaching into scopes). The resulting layering, stated once: **declared** surface → version manifest (immutable); **operator** state (roles) → directory `_substrat_roles` via `listRoles` (runtime-mutable, correctly a table); **minted** grants → scope-local tuples, enumerable only via the audited admin-query RPC, never mirrored into the directory. Trust caveat inherited from self-serve-deploy.md §3: on an opaque-bundle push the shipped registry is pusher-claimed exactly as the digest is — verified only under the controlled build (model A) | The pattern existed twice already: permission keys are never renamed and evolve additively, which is what makes an immutable per-version artifact the natural home; and `digests.permission` already committed to this exact content — shipping content beside its hash is completion, not addition. The tell that the data had no home: three partial copies (`PERMISSIONS.md` in the repo, a hash in the registry, a hardcoded catalog in the dashboard), none consumable by the surfaces (§4.5's console, a dashboard permissions tab) that need it. Both rejections are one argument in two directions: state that can drift from enforcement is worse than no state |
| 40 | 2026-07-28 | **The hosted-vertical sandbox is a positive binding allowlist, not a denylist** ([#302](https://github.com/substrat-run/substrat/issues/302); self-serve-deploy.md §4.1). `assertSandboxContract` refused a known-bad shortlist (`CONTROL_PLANE`, `service`, cross-script DO) and *allowed everything else by omission* — KV/Queues/R2/analytics were neither named nor validated, and an unrecognized type sailed through. Inverted: a vertical may declare only its OWN resources, from one written set (`ADMISSIBLE_BINDING_TYPES` in contracts) — its DO classes (own class only) plus own data stores (`d1`, `kv_namespace`, `queue`, `r2_bucket`, `analytics_engine`) and inert `secret_text`/`plain_text`; anything else is refused *by omission*, with a message that names the binding and its type and points at the doc. Two posture calls settled: own→own **service bindings stay rejected** (a hosted vertical is one serving script — no own sibling to bind, and platform reach is the router, K-27); own **`d1` stays admitted** but its `database_id` ownership is still unproven — trusted under model-B human admission until platform provisioning injects the id (#301). `CONTROL_PLANE` is refused by *name* whatever type it claims, so masquerading can't slip it. The allowlist lives in `contracts` so the CLI can predict admission from the same list the control plane enforces | The tell was the issue's own framing: "what passes" was an emergent property of what the denylist forgot to ban, so a builder couldn't predict admission and the platform couldn't say what it permitted. A denylist is open by default — every new Cloudflare binding type is admitted until someone remembers to ban it; an allowlist is closed by default and fails safe. Same shape as D-39's "state that can drift from enforcement is worse than no state": the permitted set had to become a written artifact, not a gap. Follow-ups this scopes *out*: the CLI still only assembles DO+d1 bindings (kv/queue/r2 from a hand-authored wrangler are dropped before upload — a CLI-completeness gap, not an admission one), and structural D1-ownership proof is #301 |
| 41 | 2026-07-28 | **A hosted vertical reads its entitlements at request time from a scope-local projection — settling kernel open-question 5 with the routing cache's answer** ([#304](https://github.com/substrat-run/substrat/issues/304); scope-local-permissions.md §3/§7, control-plane.md §4.3). Entitlements were a coordinator-only, trust-at-provision check: it gated *module loading* but a dispatched worker could not read `plan`/`quota`/`tier` at request time (the `CONTROL_PLANE` binding is forbidden by the sandbox contract, D-302/#302), and a CP-less scope short-circuited the gate to `true` — enforcing *nothing* in-request, not even expiry. Now entitlements are **projected into each scope** beside roles/tuples (the scope-local-permissions machinery, extended not duplicated): `ctx.entitlement(key)`/`ctx.entitlements()` read them locally (a console-managed scope reads over the same RPC the permission checker uses), the per-operation gate fails closed against the projection, and a grant/revoke fans out to invalidate. This is **open-question 5's answer** — cached in scope DOs with event invalidation — and deliberately the SAME project-on-write mechanism K-26/K-30 defer the routing/suspension cache to, per control-plane.md §4's "settle once for both". Two calls, per #33's grain: **expose, don't enforce** `quota`/`plan` (the kernel gates presence + expiry; the vertical counts its own usage), and **fail-closed** enforcement that flips **per scope** via an `entitlements_enforced` marker the first time entitlements are projected — so a scope provisioned before #304 keeps trusting upstream until a fan-out/reconcile/re-provision back-fills it, stranding no live scope | The tell that this belonged to the projection, not a new mechanism, was in the docs already: scope-local-permissions.md §3 listed entitlements as the one checker-adjacent input *not* projected, and control-plane.md §4 said the entitlement cache and the routing cache "should be settled once, for both". #304 is cashing both notes. The marker is the honest reading of "fail-closed + reconcile back-fill": strictness is real, but it activates where projection has actually reached, so correctness never arrives as an outage. Scoped out (a follow-up, consistent with role-projection's own limit): the platform→dispatched-vertical provision path (control-plane-api) does not yet *pass* entitlements into `provisionScopeLocal`, so re-projection to a live dispatched worker rides re-provision/reconcile until that is wired — expiry still enforces locally meanwhile, because the projected row carries it |
| 42 | 2026-07-28 | **The platform delivers a tenant's entitlements WITH provisioning, and grant/revoke propagation to a live dispatched vertical rides re-provision** ([#310](https://github.com/substrat-run/substrat/issues/310); completes D-41's scoped-out item). D-41 projected entitlements into a scope but left the platform→dispatched-vertical seam un-wired: a freshly provisioned CP-less scope got *no* entitlements, so its `entitlements_enforced` marker stayed off and the gate trusted upstream. Now the control-plane's single provision choke point (`POST /verticals/:slug/instances`) **gathers the tenant's entitlements itself** (`admin.listEntitlements` — platform-authoritative, never trusting the caller's body) and delivers them on the provision payload; the vertical parses them (`entitlementGrant`, reusing the contract) and hands them to `provisionScopeLocal`, which projects them and flips enforcement on. Both console and dashboard route through that one endpoint, so one injection covers every production path. **Propagation of a later grant/revoke to an already-live dispatched worker rides a re-provision** — the same idempotent K-31 call, and the same mechanism role-definition changes already use — rather than a new push-on-grant fan-out channel; meanwhile expiry still enforces locally because the projected row carries it | The seam looked like it needed touching in four places (control-plane-api, console, dashboard, each vertical) until the call graph showed console and dashboard both POST to the *same* control-plane endpoint — so the authoritative gather belongs there, once, and the callers stay unchanged. Deciding re-provision is the propagation channel (not building a push-on-grant fan-out) is the same judgment D-41's marker encodes: the platform already re-provisions to heal role projections (the Egeryds runbook), so entitlements riding that path adds no new failure mode, whereas a bespoke grant→vertical push would add one for a case expiry already covers. A dedicated push channel stays available if a future SLA needs sub-re-provision revocation latency |
| 43 | 2026-07-30 | **Per-PR preview instances: a private vertical's PR forks prod, runs the PR's code against the copy on its own URL, and is reaped on close** (preview-and-snapshots.md §2/§9 — resolves that doc's open-Q1 and open-Q6). The generated deploy workflow only fired on push-to-branch, so a PR's changes could not be seen running before merge. Now `substrat preview create` (in the PR-open/synchronize job) pushes the working tree, forks the tenant's prod scope, binds the just-pushed version to the fork, and mints a non-canonical `<label>--pr-N.<base>` hostname; the PR-close job runs `substrat preview delete`, and a per-preview `expiresAt` is the GC backstop (the 15-min platform sweep already reaps expired forks). This is the [§9 "cross-version preview"](architecture/preview-and-snapshots.md) path — the fork binds a NEW version whose bundle is a *different* dispatch script, so the dump moves between deployments (export from where prod data lives → import into the PR version's deployment) — the one genuinely byte-moving lifecycle op, gated exactly as the governed pull: **`global`-jurisdiction only** (K-32 residency; an `eu`/`us` source is refused until Regional Services), the canonical audited export path, and a non-canonical, non-public preview URL that never demotes prod. Almost nothing new was built below the seam — `provisionScope`(kind=`preview`/`forkedFrom`/`expiresAt`), `exportScope`/`restoreScope`, `bindScopeVersion`, hostname bind/unbind and the expiry GC all already shipped; the work was composition glue (`orchestratedPreview` + 3 builder-reachable `/verticals/:slug/previews` routes), the `substrat preview` CLI verb, and the PR triggers in the generated workflow. **Private verticals only, and no admission relaxation**: a private push self-admits (D-36), so binding an unpromoted PR version to a preview scope is a pure self-serve act; a listed vertical's preview would need to bind un-vouched code and is deferred with the rest of the listed-tier admission work | The reason this is a small, safe slice and not the whole of preview-and-snapshots.md is that the two hard parts were already decided elsewhere. D-36 made a private vertical self-admitting, which is exactly what lets a builder bind their own PR code with no staff in the loop — the "admission relaxation" the design doc worried about simply isn't needed once the audience is one's own tenant. And D-37's stable serving script means prod data lives somewhere findable to export from. What remained genuinely new — a dump crossing deployment boundaries — is the one thing §9 flagged as the harder path, so it inherits §6's gates verbatim rather than inventing new ones: same `global`-only refusal, same audited canonical export, same dead-ended fork. The honest limit is that the fork carries real prod PII onto a preview URL; the URL is non-canonical and preview-gated, and the fork is outbound-dead-ended, but a builder previewing their own tenant's data is trusting themselves — the boundary that would matter (data leaving the platform) is `scope pull`, which stays break-glass |
| 44 | 2026-08-06 | **Native static assets are an additive allow to the hosted-vertical sandbox — the bytes are trusted, the content-address is verified** ([#340](https://github.com/substrat-run/substrat/issues/340); self-serve-deploy.md §4.1). Every dispatched vertical inlined its built SPA into the worker bundle as base64 (`gen-assets.mjs` → `assets.generated.ts`), justified by "WfP dispatch has no static-assets path" — stale since Workers for Platforms grew `assets-upload-session`. That workaround cost ~+33 % in bundle size against the script-size limit (Manyfold's inlined SPA alone is 3.9 MB of source), re-parsed the whole UI on every cold start, and invoked the worker for every image. A vertical now declares `runtimeNeeds.assets` — a directory plus path-routing config (`notFoundHandling`, `runWorkerFirst`) — and the platform uploads the files to the runtime's own asset store through Cloudflare's three-step upload session: served from the edge without invoking the worker, and versioned atomically with the code. **D-40's binding allowlist cannot rule on this either way** — native assets are a top-level upload path, not a binding — so the decision is written down separately: assets are admitted because they carry no reach (inert public bytes: no code, no credential, no cross-tenant name), while their **hash is re-derived from the received bytes and refused on mismatch**, because the asset store is content-addressed and deduped namespace-wide, so bytes stored under an address they do not have could decide what a *different* vertical's identical-hash asset serves. An `assets.binding` (programmatic `env.ASSETS`) stays refused, at push time rather than silently | The reflex was to read this as "one more binding type" and extend D-40's allowlist; it is not a binding at all, which is why the sandbox question had to be re-asked from scratch instead of answered by precedent. Re-asking it found the one genuinely non-inert property — the dedup key is SHARED, so it is the only part of an asset upload a tenant must not choose freely — and that single verification is what lets everything else stay trusted. Retaining the file MANIFEST rather than the bytes is what makes a promote work: the archive script gives back the modules (#286), content-addressed dedup gives back the assets, and a re-serve that finds bytes the runtime has dropped refuses instead of quietly serving a half-broken page |
| 45 | 2026-08-08 | **Subject erasure is scoped to the stores that exist: the spine is redacted, platform-retained copies are crypto-shredded, and the keys sit in the directory** ([#37](https://github.com/substrat-run/substrat/issues/37); K-37 is the kernel-side twin; implements §5.3's crypto-shredding sentence and answers kernel open question 17's spine half). §5.3 promised "PII tokenized/encrypted per-subject with crypto-shredding for erasure" and the contracts package enforced its precondition totally — `piiClass` requires a `subjectId`, message and all — while `packages/` contained no key store, no shred, and no cipher. Two findings shaped what was actually built. **The lake is not there**: `_substrat_outbox.drained_at` is still dead (K-24 built the Tier-2 sink for the ACCESS log only), so the "immutable lake" §5.3's GDPR sentence is about does not exist, and building the mechanism for it would have been building against an absent store. **The un-deletable copies that DO exist are last week's work** — the reap backup (#493), the stored dumps (#40), the tenant export (#36) — all full-fidelity by deliberate design, and therefore all unreachable by a `DELETE`. So: erase in Tier 1 by redaction (mutable store, ordinary UPDATE, envelope kept), erase in every retained copy by destroying a per-subject key that sealed it on the way out, and let the Tier-2 drain inherit the same seam when it is built. Staff-triggered, audited in both logs, and NOT self-service — a builder forwards the DSAR, the platform executes it and returns a receipt (hosting-and-certification.md §3's shared-responsibility line, "we provide extraction, they define scope") *(Restated at the other altitude as [K-37](decisions/K-037-subject-erasure-splits-by-store-tier-1-is-redacted-platform-.md) — same decision, kernel layer.)* | The decision worth recording is **where the honesty lives**. This is the second compliance mechanism in a fortnight (#36 was the first) whose value depends less on the code than on the limits published beside it, and the issue said so in advance: *"That's a real Article 17 scenario. Don't promise it."* So five limits ship as documentation, not as backlog — one subject per event, vertical tables untouched, copies already handed out, the PITR window, and a directory restore resurrecting a key. Each is the kind of thing a buyer's auditor finds in year two if we do not say it in month one, and §7.8's lesson is that this field has already trained them to disbelieve the claim. Deferred deliberately: the `onSubjectErased` module hook that would bring a vertical's own tables inside the guarantee — it is a new module-facing contract governed by D-28 from its first line, and it deserves its own issue rather than a corner of this one |
| 46 | 2026-08-11 | **A hosted vertical's outbound egress is a declared per-version allowlist, enforced at the dispatch egress seam and metered on every verdict** ([#303](https://github.com/substrat-run/substrat/issues/303); self-serve-deploy.md §4.2 — resolves that doc's open question 6.3, "allowlist, none, or metered", with *allowlist and metered*). Egress from a hosted worker runs under the platform's Cloudflare account — an SSRF/exfiltration and cost/abuse surface — yet every dispatched `fetch()` passed through the egress worker (#442) untouched. Now the vertical declares the third-party hosts it calls (`package.json` `substrat.outbound`: exact hostnames + `*.`-wildcards), the CLI carries the list in the deploy manifest **versioned with the code** (each version's manifest holds its own list, lifted onto the version record and rendered beside the console's Admit button — the permission-surface shape, D-39), the router's directory read joins the list of *the version whose code the dispatch runs* (serving version when the stable script wins, bound version on the per-version fallback — the policy follows the bundle, not the pointer), and the egress worker enforces it per subrequest: platform hosts keep looping through the router (K-27), declared hosts pass untouched, anything else is a teachable 403 naming the host. A new-CLI push **always** sends the field (`[]` when undeclared) because *no direct third-party egress* is the right default — connectors run platform-side, mail rides the relay grant, cross-vertical calls ride the router; a pre-#303 version resolves `hosts: null` and passes through **unenforced but metered** until its next push, so least privilege arrives version by version, never as a fleet outage. Every verdict (`platform`/`allowed`/`unenforced`/`refused`) writes one Analytics Engine datapoint (`substrat_egress`, index = slug — D-30 *meter, don't bill*) | Three calls worth recording. **Declaration is the authority, not a staff grant** — unlike `emailSender` (platform credential, shared sending reputation), a declared host grants nothing the vertical could not already reach before this existed; the value is the bound, the diff at admit, and the attributed meter — so a private self-admitting vertical (D-36) stays self-serve and the listed tier's human admitter sees the list like the permission table. **The policy follows the bundle**: reading the scope's bound version would enforce a *different version's* list than the code actually running mid-promote. And **the honest limit ships with the mechanism** (the D-45 rule): Cloudflare outbound workers do not intercept Durable-Object-originated subrequests, and verticals are DO-centric — so this is defense-in-depth plus a reviewed contract, not an airtight sandbox, and the doc says so; if CF extends interception, enforcement completes with no contract change. Free win, also written down: attaching an outbound worker disables raw TCP `connect()` for every dispatched script |
| 47 | 2026-07-30 | **Permission registry is a required, TypeScript-derived manifest field** — completes D-39 and retires its checked-in machine artifact. The surface is declared once via a typed `definePermissions()` (compile-checked), discovered from a declared entry rather than a by-name `seed.ts` re-export, and the wire registry is *derived at push* from the built entry — no `permissions.json` in git. `deployManifest.registry` becomes required; a missing surface is a hard error at both the CLI and the trust boundary; honest-empty stays expressible only explicitly. `PERMISSIONS.md` remains the checked-in human review artifact. Rejected: hand-authored JSON, `seed.ts` discovery, a self-describe endpoint, a mutable CP table. **As built, two refinements:** push tolerates a node-ful entry (bundling with packages external, resolved from the vertical's own `node_modules`), and contracts exports a lenient `storedDeployManifest` so manifests persisted before `registry` existed still re-parse. The checked-in `permissions.json` fallback was **not** needed — `buildPermissionRegistry` reproduced all seven committed files byte-for-byte, so they were deleted. | D-39 made the content drift-proof but left the mechanism opt-out-able by convention and introduced a machine-only generated file in git — both are the derived-state-that-drifts this design refuses everywhere else. **Note on numbering:** this entry originally proposed itself as decision 41, a number already held by the scope-local entitlements projection (#304). The collision went unnoticed because neither document could see the other — which is the argument for the generated log this entry was split into. |
| 48 | 2026-08-15 | **The builder studio is built as an unlisted internal tool first.** No marketing surface, no dashboard entry, staff roster only; the competent-reviewer problem is solved by construction because every user is staff. Offering it outside the staff roster is a separate decision that re-opens §6, not a deploy. | The local loop already serves engineers, so the only hypothesis worth testing is whether a *non-engineer domain expert* can reach a staff-admittable vertical — which is simultaneously the internal workflow and the product question, testable against our own operator work rather than a paying customer. |
| 49 | 2026-08-15 | **The studio's local and hosted modes are one product behind a `Workspace` interface.** The method (skills, checks, git, commit-per-turn) is identical; only `exec`, file access and port exposure differ. | The local loop is the reference implementation and already works, so the hosted one is a shell over it — and a shared interface is what stops the two from silently diverging into different definitions of "a build." |
| 50 | 2026-08-15 | **The LLM is pluggable at the generator seam, and running any provider is a requirement.** A `VerticalGenerator` produces our `BuildEvent` union over a `Workspace`; the default implementation uses the Vercel AI SDK with `Workspace` methods as the model's tools, so provider is config and no credential enters the sandbox. | The prompt (files) and the verification (exit codes) are already provider-neutral for free, so the only real question was where the harness binds — and a hard any-LLM requirement rules out the Claude Agent SDK and Managed Agents as the *core*, leaving them as optional implementations behind the same seam. The honest bound: architecture permits any model, `evals/` decides which ones can actually pass the gates, and that list is expected to be short. |
| 51 | 2026-08-15 | **Regression safety comes from an acceptance ledger the user authored.** A pinned confirmation in chat becomes a named case in `spec/accepted.md` and a step in the scenario narrative; the whole ledger runs every turn; a break is reported in the builder's own words. Agent-authored tests stay, labelled as lint, and never gate a promotion. | An agent that writes both the implementation and its oracle can be wrong in the same direction twice, so the only assertions worth trusting are the ones it did not author — the golden-file gates that already exist (`lint:permissions`, `lint:api`, boundary-lint, migration replay) and the user's own accepted behaviours. This is also what makes the *chat* interface load-bearing rather than cosmetic: a terminal loop discards the acceptance signal, and the ledger is the only artifact that could later make an automated engine-upgrade checkable. |
| 52 | 2026-08-15 | **The generator itself is regression-tested against frozen concept fixtures (`evals/`).** Any change to the skills, the model, the effort level or the harness runs N stored concepts and compares structural outcomes. | The skills are the product, so a prompt edit is a fleet-wide behaviour change with no reviewable diff — this is what `packages/contract-tests` is for adapters, applied to the thing that writes every future vertical. |
| 53 | 2026-08-15 | **A generated vertical's repo is hosted by us as a git bundle in R2, not on GitHub.** One bare repo per vertical, written only by that vertical's `BuilderAgent` DO, stored under the tenant's namespace. A builder's own GitHub is a one-way export target. *(Correction, post-implementation: R2 has no object versioning — rollback is app-level ULID-keyed bundle history, not a bucket feature.)* | The code is the customer's and we merely hold it, so code should live where the data lives — a tenant with EU-resident data whose business logic sits in a US SaaS is an inconsistency aimed squarely at the buyer the trust moat targets — and hosting customer repos in our own org would make us custodian of their IP at a scale (thousands of repos) with an offboarding story we would have to invent. The decision is also asymmetrically reversible: bundles → any git host is a `git push`, while our-org → elsewhere means transferring repos we should never have held. |
| 54 | 2026-08-15 | **The generated vertical is the customer's code; the studio is a tool, not the author.** Export is available from day one rather than at offboarding, we hold the repo as custodian by arrangement (D-53), the model provider is a disclosed subprocessor the tenant may constrain, and ownership is never offered as an answer to the review question. | The honest description of the product is "a better-guardrailed agent than the one they would point at this themselves" — and each consequence is something that becomes expensive to retrofit once customers exist. The subprocessor point is the one with teeth: it converts the pluggable provider seam (D-50) from a portability nicety into the mechanism that answers a procurement objection by configuration — EU-resident inference, a vendor veto, or a self-hosted model — instead of by losing the deal. |
| 55 | 2026-08-15 | **The generator's skills are builder-distilled documents owned by the studio.** The generator reads `apps/builder/skills/`, not the repo's Claude Code skills. The originals assume monorepo access, a deploy CLI and curl — all unreachable or denied in the project-rooted sandbox — and they duplicate the system prompt's module rules. The distilled pair carries the engine coverage map + concept template (interview) and inline code shapes replacing unreachable reference files (build), at roughly a third of the size. | Every turn billed the same rules twice and pointed the model at files it cannot read. Consequence accepted: a second document to keep in sync when platform surfaces change — the studio's files say so in their header, and `evals/` (D-52) is the mechanism that catches a drifted skill producing a vertical that no longer passes the gates. |
| 56 | 2026-08-15 | **Which skills ride a turn is decided by a phase ladder derived from workspace facts.** Three phases — interview (no `spec/concept.md`), scaffold (no `src/module.ts` yet), iterate — gate a skill manifest (`phase.ts`) shared by both hosts; the UI's phase stepper renders the same server-emitted facts, so what the user sees IS what the generator is loaded for. Prefix content changes only at phase boundaries. | A phase the loader cannot detect at turn start is a phase it cannot enforce — which is why "planning" and "design" are not phases; they happen inside interview turns with no workspace fact between them. Per-turn dynamic prefix selection would invalidate the prompt cache from byte one: anything finer-grained than a phase belongs behind a read tool, not in the prefix. The ladder is monotonic in practice; a deliberate re-design (deleting or rewriting the concept) moves it backward honestly, because the facts moved. |
| 57 | 2026-08-19 | **The standing obligation goes; the evidence stays.** §5.6 called "can an agent build a vertical unaided up to the checkpoints?" **the recurring benchmark** and "the question every kernel API review should end with", and kernel-design §11 listed it as testing-strategy item 4. Eight runs exist, all between 2026-07-14 and 2026-07-16, and none since — across a period in which the platform gained three engines, the builder studio, the model phase, sub-transactions and a live production tenant. A claimed discipline that has not run in five weeks is worse than an absent one, because it is read as coverage. So the claim comes down from §5.6 and from kernel-design §11. **The eight records in `docs/acceptance/` stay, at `status: historical`** — they are load-bearing evidence, not ceremony: kernel open question 15 (entity re-parenting, an unresolved access-revocation failure) cites run 007 as where it was found, `packages/boundary-lint` ships a test suite named `zero-engine verticals (agent-loop-008)`, the root README credits run 001 with the Handlebar demo's existence, and `rfc/booking-social.md` cites 007. Deleting them would orphan a live open question's provenance and a shipped test's rationale. | **`apps/builder/evals` is not a replacement, and this entry declines to pretend it is.** Evals sweeps frozen concept fixtures through the studio's generator before and after any skill, model or harness change — a regression test on *our* generator. The retired benchmark asked a different question: whether an **arbitrary** agent, working **outside this monorepo**, against the **published packages only**, on a domain the skill has no worked example for, reaches a checkpoint-clean vertical. Runs 006, 007 and 008 were explicitly that shape, and run 008's value was that the correct answer was partly *"this does not belong here"*. Nothing now covers it. Naming that loss is the point of writing this down rather than letting the practice lapse by drift — the same failure D-8 was re-ratified to avoid. What made the benchmark expensive is also what made it good: each run was a hand-conducted exercise with a written verdict, which is not a thing CI can hold. The honest position is that the platform now leans on mechanical gates (`lint:permissions`, `lint:model`, `lint:api`, `lint:decisions`, boundary-lint, migration replay, the contract tests on both adapters) plus evals for the generator, and has **no standing test of the unaided-agent claim**. If that claim re-enters a pitch, this entry is the reason to run 009 first. |

## 13. Next actions

1. Kernel owner: push this doc; open issues for each open question in §11.
2. Derive the **operator narrative** (2–3 pages, mark/grund/stammar framing, delivered in
   conversation; ends with the four decisions needed: FSM-vendor bridge terms, builders, ownership/
   fee structure, governance/escrow).
3. Derive the **technical RFC** for the techy friend (architecture-first, alternatives
   considered, risks and open questions as questions; deliberately unpolished; ask him to
   break it).
4. Milestone one: the **15-minute demo** — toy vertical scaffolded by Claude Code on the
   kernel from the module manifest + specs (§5.6); show generation succeed and
   cross-tenant access **fail** at the boundary.
5. Clarify the FSM-vendor question (subscribe vs acquire) with the friend before fall.
