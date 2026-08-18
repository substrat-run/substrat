# How Substrat compares

Substrat sits in a category most people meet for the first time here, so the fastest way to
understand it is against the tools you already know. This page places it next to each
familiar neighbor and names the *one axis* where it diverges.

It is deliberately not a scoreboard. Every tool below is good at what it was built for, and
several are excellent; the point is to show what Substrat is by showing what it trades away
and what it keeps. If your problem is the shape one of these neighbors was built for, use
that neighbor — the last section says so plainly.

## The three-way choice everyone else forces

Today a team building vertical B2B software has to pick two of three things — governance,
code ownership, and an open, agent-friendly runtime:

| Approach | Examples | What you get | What you give up |
|---|---|---|---|
| **Governance without code** | OutSystems, Mendix, Power Apps, ServiceNow App Engine | Real permissions, audit, compliance — as a hosted platform | A proprietary visual model; no code you own; agent-hostile |
| **Code without governance** | Supabase, boilerplates, prompt-to-app tools | Full code ownership, fast start, agent-friendly | Every catastrophic mistake — tenant leaks, missing audit — is yours |
| **Both, walled garden** | Salesforce, ServiceNow | Governance *and* depth, at the top of the market | Proprietary runtime, enterprise pricing, build-inside-our-world |

Substrat is the missing fourth corner: **governance as a runtime substrate, under code you
own, on an open runtime, shaped for multi-tenant vertical SaaS.** The guarantees live
[below the API surface](/guide/why-substrat), so it stops mattering who — or what — wrote
the code above them, and you still own that code.

## The table, for scanning

Read it as *what each product optimizes for*, not as a scoreboard. Several of these are
better than Substrat at what they set out to do, and the third column says so.

| Product | What it really is | Where it beats Substrat | Where Substrat differs |
|---|---|---|---|
| **Ruby on Rails** | The reference full-stack framework | Maturity, ecosystem, hiring pool, twenty years of answers. Rails + a good team beats Substrat on almost any *single*-tenant app | Rails gives you conventions, and conventions erode with every edit. No tenancy, permissions, audit or GDPR machinery below the app — that is yours to build and keep correct |
| **Wasp** | Rails-for-TypeScript: a declarative spec compiled to a React/Node/Prisma app | Excellent DX, MIT, no hosting lock-in, strong AI-coding compatibility, and a SaaS template that gets you selling | Convergent instinct — a typed spec the compiler checks; our [`model.ts`](/concepts/model) rhymes with theirs — and opposite depth. Wasp is a framework you deploy; Substrat is a runtime that *enforces*. We keep their perks (deterministic generation, pre-vetted auth, local run, migrations) rather than trading them away for the guarantees |
| **Supabase / Convex** | Backend-as-a-service | Better DX, bigger ecosystem, far better for app-shaped products | App-shaped, not vertical-SaaS-shaped. RLS is precisely the surface builders and LLMs misconfigure most |
| **MakerKit / ShipFast / Open SaaS** | Boilerplates, one-time purchase | Unbeatable economics *if* the guarantees can be conventions | Guarantees erode with every edit; no nested tenancy, no provisioning, no engines |
| **Lovable / Bolt / Replit** | Prompt-to-app | Enormous distribution, polish, iteration speed | They generate the dangerous parts too. Their remedy is *scanning* — checking policies exist, not that they hold. Here you bring your own model and your own agent, on code that runs locally |
| **Base44, Floot** | AI-native app builders with auth/roles as platform primitives | The nearest AI-native articulation of the same idea, with real products and real users | Single-app shaped — no tenancy tree, no engines, no B2B SaaS shape — and weak portability. Substrat code boots on SQLite with no platform in the loop |
| **Retool / Superblocks** | Internal tools with governance | Owns the internal-tool shape outright — genuinely better there | No nested tenancy for *selling* SaaS; runtime-locked |
| **OutSystems / Mendix / Power Apps** | Enterprise low-code | Genuinely solve permissions, audit and governance as a hosted platform — and prove the willingness to pay | A proprietary visual model: agent-hostile, internal-app-shaped, single-level tenancy, no usable eject |
| **Microsoft Dataverse** | Proprietary data platform with runtime-enforced security roles | The most mature RBAC in this table by a distance — row *and* column security, business-unit hierarchies, team ownership, audit built in | Business units are org structure *inside one tenant*, not tenancy for selling SaaS to many customers; per-user licensing lands on your customer, which breaks vertical-SaaS economics |
| **Salesforce / ServiceNow** | The top of the market | Ecosystem, certifications, integrator army, indemnification | Proprietary runtime, enterprise pricing, no real exit. Apex defaults to *system* mode — enforcement contingent on the developer |
| **Odoo / Frappe** | Platform-with-modules | The biggest module ecosystems on earth; a real business today | You inherit their ORM, worldview and upgrade treadmill; single-org shaped |
| **Medusa v2** | E-commerce with strict module isolation | Independently converged on the module/engine model, shipping in production | E-commerce-scoped, no native multi-tenancy, no enforcement layer around the modules |
| **Baseplate.dev** | Deterministic codegen you eject from | Zero lock-in — literally its proudest feature | The exact opposite pole: they generate the foundation and leave; we *are* the foundation and stay |
| **DIY: WorkOS + Nango + Inngest + Stripe** | Assemble it yourself | Best-in-class at each piece; no platform bet | Every seam between them is yours to keep correct forever, and none of them enforces anything about the code above |

**What none of the AI builders in this table have** is an oracle independent of the code they
generate: they produce the app and its tests from the same act of generation, so the tests
inherit the same misunderstanding and pass. Frameworks don't generate your tests at all, which
is honest but leaves the second opinion to your discipline on a Friday afternoon. Deriving
code from the model and [tests from the concept](/guide/ai-agents#the-second-opinion-two-descriptions-that-can-disagree)
is cheap, and it catches the exact failure mode — small, confident, inconsistent mistakes —
that makes generated systems untrustworthy.

## The neighbors, one by one

### Full-stack frameworks

*Ruby on Rails, Wasp, Laravel.*

The honest baseline, and the one most readers should measure against first: for a
single-tenant app, a good framework and a good team beat Substrat, and it isn't close. What a
framework gives you is **conventions** — and conventions are exactly what erodes when the
fifth iteration of a handler is written at speed, by a person or an agent, and drops a
`WHERE` clause nothing was enforcing.

Wasp is the closest in instinct: a declarative spec the compiler checks, compiled down to a
working app — the same conviction that a project should have one high-level description a
human and an agent can both hold in their head. Substrat's [`model.ts`](/concepts/model)
rhymes with `main.wasp.ts` deliberately.

The divergence is depth, not direction. Wasp is a framework you deploy; Substrat is a runtime
that *enforces*, with tenancy, permissions, audit and GDPR below the API surface rather than
in the app you generate. And the trade usually demanded for that — giving up the framework
perks — is one we tried hard not to take: deterministic generation, auth you never write,
local run, connectors, and platform-owned migrations are all still here.

If your problem is one app for one organization, take the framework.

### Templates & boilerplates

*MakerKit, ShipFast, Open SaaS, Bullet Train.*

The closest articulation of "an LLM-friendly foundation you own" — and the honest one about
its own economics (a one-time purchase, then it's yours). The difference is durability: a
template gives you correct code *once*, and every edit after that, human or AI, can erode
it. Nothing at runtime stops the fifth iteration of a handler from querying across tenants.
Substrat's guarantees are enforced by the substrate on every call, not printed into a
starting point. Templates also stop at the single-app shape — no nested tenancy, no
provisioning, no shared domain engines.

### Prompt-to-app

*Lovable, Bolt, Replit, and similar.*

These generate the whole app, including the dangerous parts. That's their ceiling for B2B:
the parts an LLM gets wrong most often — tenant isolation, auth boundaries, audit — are
exactly the parts they generate rather than stand on. Their remedy, security *scanning*,
checks that policies exist, not that they hold. Substrat inverts the split: the dangerous
30% is a hardened substrate; the safe, high-velocity 70% — screens, forms, workflows — is
where the generation happens. The two are complementary, not rivals: a prompt-to-app tool
pointed at Substrat's manifest generates *above* the guarantees instead of reinventing
them.

### Backend-as-a-service

*Supabase, Convex.*

BaaS does enforce at runtime — but it makes the guarantee contingent on rules the builder
writes correctly. Row-level-security policies are precisely the surface inexperienced
builders and LLMs misconfigure most; the isolation is real *if* every policy is right.
Substrat's isolation is not a policy you author — [the API for reaching a
scope](/concepts/scope-host) *is* the isolation mechanism, and its secure default is deny.
BaaS is also app-shaped rather than vertical-SaaS-shaped: no nested tenancy tree, no module
system, no domain engines.

### Low-code / enterprise app platforms

*OutSystems, Mendix, Appian, Power Apps, ServiceNow App Engine.*

The strongest existing answer on governance — they genuinely solve permissions, audit, and
compliance as a hosted platform, and the market pays enterprise prices for it. The trade is
that all of it lives inside a proprietary visual model: AI copilots generate *into* that
model, deepening lock-in rather than producing code you own; the shape is internal-app, not
multi-tenant SaaS you sell; and even the best tenancy in the class is single-level. Their
existence is the demand evidence for the category. Substrat targets the same governance, but
as a substrate under TypeScript you own, [agent-first by design](/guide/ai-agents), with
nested tenancy as the reason it exists.

### Salesforce & ServiceNow

*The top of the market.*

Proof the category works at scale — governance, depth, and now AI app generation, sold to
the largest enterprises. And proof of the trade Substrat refuses: a proprietary runtime,
enterprise pricing, US-hosted, build-inside-our-world with no real exit. Substrat is the
code-first, developer-owned, EU-shaped version for the SME and mid-market segment that tier
prices out — a different customer, deliberately.

### Odoo & Frappe

*The platform-with-modules thesis, executed.*

The nearest thing in spirit to "apps on a shared platform," and worth understanding closely
because the resemblance is surface-level. On Odoo you adopt an entire ORM, worldview, and
upgrade cadence; apps extend each other by inheritance and share one database, so the
platform is a single-organization shape — reseller multi-tenancy is something integrators
build themselves, per tenant. Frappe's everything-is-a-DocType metadata model is the
dynamic-schema approach Substrat [deliberately avoids](/concepts/modules): modules own their
own typed tables and migrations instead. The engine model draws the opposite boundary from
an Odoo app — see [what an engine is *not*](/engines/#what-an-engine-is-not).

### Medusa

*The architectural cousin.*

The one neighbor Substrat resembles by convergence rather than contrast. Medusa v2's modules
are strictly isolated, associate through link tables instead of foreign keys, and carry
per-module migrations — independently arriving at the same engine model, and shipping in
production. It validates the architecture. The differences are scope and layer: Medusa is
e-commerce-shaped, runs one instance per tenant rather than native multi-tenancy, and has no
enforcement layer around the modules. Substrat generalizes the module isolation and wraps it
in [nested tenancy](/concepts/tenancy) and runtime enforcement.

### Assembling the pieces yourself

*Clerk / WorkOS for identity, Nango for integrations, Inngest for jobs, Stripe for billing.*

Every ingredient Substrat bundles exists as an excellent standalone product, and a capable
team can wire them together. What that assembly doesn't give you is the *seam*: identity,
tenancy, permissions, events, and integrations enforced as one coherent substrate, with
domain engines on top and one audited path through all of it. You own the glue — and the
glue between governance systems is exactly where the catastrophic mistakes live. Substrat is
the opinionated bundle where the seams are the product.

## When Substrat is the wrong tool

The boundary is as much a part of the definition as the category. Reach for something else
when:

- **You're building a single-tenant internal tool.** Without a tenancy tree or a per-tenant
  compliance surface, most of the kernel is dead weight — Retool, Power Apps, and the BaaS
  platforms own that shape.
- **One tenant is data- or scale-heavy.** The scope-per-customer model suits many
  operationally-rich tenants, not one tenant with hundreds of millions of hot rows.
- **The moat is deep domain logic, not foundation cost.** Accounting, payroll, core
  banking — decades of domain depth. Integrate those; don't rebuild them.
- **The foundation isn't your binding constraint.** Consumer-scale apps, ML-first products,
  realtime-collaboration tools — different physics, where tenancy and audit aren't the
  bottleneck.

Substrat fits where apps are **structurally repetitive but operationally rich**:
workflow-shaped B2B products whose foundation — tenancy, permissions, audit, GDPR — is the
expensive, identical part, and whose differentiation is vocabulary, states, and compliance
content. Where the foundation isn't the cost driver, the substrate stops paying rent.
