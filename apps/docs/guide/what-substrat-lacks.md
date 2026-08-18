# What Substrat doesn't have (yet)

A page that only lists strengths is a document nobody trusts twice. This one names the gaps,
says which are deliberate refusals and which are simply unbuilt, and separates the two —
because "we chose not to" and "we haven't got to it" are different admissions, and blurring
them is how these documents start lying.

If you are evaluating Substrat, read this page before the marketing one. It is the faster
way to find out whether the answer is no.

## How claims are labelled

Everywhere in these docs, a capability is one of three things:

| label | means |
|---|---|
| **shipped** | it exists in the repo, it is exercised by tests or by a running deployment, and you can go read the code today |
| **built, unproven** | the code exists and works, but it hasn't survived the load, the customer count, or the second use case that would make it a fact |
| **bet** | a design position we believe and have not yet earned the right to assert |

Substrat is 0.x. Most of the platform is in the first column, the engine-reuse thesis is in
the second, and the market thesis is in the third.

## The gaps

| Capability | Who has it | Where we are |
|---|---|---|
| **Integration catalogue** | Zapier, Power Automate (1000+ connectors), Nango (400+) | **Genuine gap, and the most practical one.** One production connector. The [connector framework](/connectors/) is right; the library is a rounding error |
| **Certifications** (SOC 2, ISO 27001, HIPAA) | Every enterprise incumbent — and several AI app builders | **Genuine gap, and the sharpest one relative to our own pitch.** We sell trust and cannot yet hand a procurement officer the one page that prices it |
| **DSAR *access-request* export** (GDPR Art. 15) | Anyone selling GDPR compliance as a feature | **Half-built, and it's the visible half.** Art. 17 erasure ships with a receipt; the Art. 15 export that answers *"what do you hold about me"* does not, and neither half has a UI. Odd from outside — we do the cryptographically hard part and not the part a customer asks for first |
| **Full-text + semantic search** | Essentially everyone | **Planned, unbuilt.** Table stakes in every B2B app, and ugly to retrofit |
| **Localization** | Every mature vertical product | **Planned, unbuilt.** Today it is an `// i18n key` comment. Retrofits here are miserable |
| **Realtime subscriptions / presence** | Supabase, Convex | **Planned, unbuilt.** Nearly free on scope DOs — which is why not building it yet is a choice rather than a constraint |
| **Native mobile + offline sync** | The enterprise low-code tier | **Planned, scoped hard, unbuilt.** Append-only capture flows only; general offline CRUD is a sync/conflict tarpit |
| **Data import / legacy migration tooling** | Salesforce Data Loader, Odoo import | **Planned, unbuilt** — and it is the biggest sales barrier, since every sale is a migration out of an incumbent. We are greenfield-only today |
| **Billing your customers out of the box** | Open SaaS (Stripe), the app builders' payment primitives | **Partial.** [Metering](/engines/metering/) and entitlements exist for *platform* billing; the vertical-bills-its-own-customers rail is engine territory and not shipped |
| **Marketplace + third-party ecosystem** | AppExchange, Odoo Apps, OutSystems Forge | **Planned, unbuilt.** A design doc is not an ecosystem, and ecosystems take years |
| **End-user report / dashboard builder** | Salesforce, Odoo, Retool, Power BI | **Deliberate refusal** — resist configurability until a customer pays for it. It will still lose a bake-off, and knowing why doesn't make the demo go better |
| **No-code admin customization** | Salesforce Flow, Odoo Studio, Dataverse | **Deliberate refusal.** No visual process builder — that is a tarpit. Defensible, and it means an admin cannot change behavior without a developer |
| **Click-to-edit visual building** | Lovable, Bolt, Base44, Retool | **Two-thirds answered, one-third a real gap.** *Instant preview* we have both ways (Vite HMR locally, a preview pane over a live devserver in the hosted builder) — but that is parity with any decent framework, not a win. *Figma* works through an MCP server or a pasted screenshot, and [Manyfold](/verticals/manyfold) is the evidence: a 13-screen design-system handover recreated as a working vertical. It is setup, though, not a button. *Click-to-edit* we genuinely lack, and the gap is **audience, not technology** — it exists so someone with no terminal and no vocabulary for the change can still make it |
| **Permissive licence** | Rails, Wasp, Medusa (MIT) | **Deliberate**, and a real adoption barrier. Contracts and the build surface are Apache-2.0; the runtime is AGPL + commercial with escrow. That is a different bargain from MIT, and some builders will simply not take it |
| **A fully self-hostable *platform*** | Odoo, Frappe, Medusa, Rails, Wasp | **Partial, and the split is the honest bit.** The vertical *runtime* self-hosts today — published, AGPL, one dependency, [contract-tested on two adapters](/reference/contract-tests). The multi-tenant *hosting product* — router, control plane, PR-preview forking, per-tenant database minting — is private and Cloudflare-native. Escrow answers "can we keep running"; it does not answer "can we run the platform ourselves" |
| **Environment/ALM breadth** | Salesforce, Dataverse | **We win the part that matters and lose the breadth.** A per-PR fork of prod that runs the PR's own code arrives in minutes and reaps itself, where a full-copy enterprise sandbox refreshes on the order of days. What they have and we don't is everything *around* it: change sets, deployment pipelines, org-wide metadata compare |
| **Ecosystem, hiring pool, twenty years of answers** | Rails, and it isn't close | **Structural.** Nothing to do but say it |

**The pattern worth noticing:** almost every gap is *breadth* — catalogues, ecosystems,
certifications, years. Almost every strength is *depth of guarantee*. That is the honest
shape of a young platform with an unusual foundation, and it says exactly who should not buy
yet: anyone whose decision turns on connector count, an admin-configurable report builder, or
a certificate we don't have.

## The weaknesses that aren't a feature list

- **Engine reuse across verticals has no field precedent.** Nobody has shown hardened domain
  engines shared across products *without forking*. Two disciplines de-risk it — engines are
  **extracted** from working verticals, never designed up front, and the placement rules bound
  what may become one — but it remains the least-proven thing here. **[built, unproven]**
- **Single-vendor runtime concentration.** The hosted path is Cloudflare end to end. The
  adapter rule and the always-green SQLite adapter are the mitigation, not a denial.
- **Design authority is concentrated.** Both human checkpoints and most of the architectural
  taste sit with a very small team. Escrow protects a customer's ability to keep running; it
  does not protect against a bus.
- **Enforcement is a slow argument.** It asks a buyer to follow a claim about runtime
  architecture before they can price it. An inherited certification is the version a
  procurement officer prices in one sentence — and it isn't there yet.
- **The egress sandbox has a documented hole.** Outbound traffic is bounded by a
  [declared per-version allowlist](/concepts/platform), enforced at the egress seam. Durable
  Object subrequests are a known gap. Don't call it airtight; it isn't yet.

## When Substrat is simply the wrong tool

These are "no"s, not missing features. The boundary is part of the definition — the full
reasoning is on [How Substrat compares](/guide/comparisons#when-substrat-is-the-wrong-tool).

- **Single-tenant internal tooling** — Retool and the low-code platforms own that shape.
- **A data- or scale-heavy single tenant** — the scope-per-customer model suits many
  operationally-rich tenants, not one tenant with hundreds of millions of hot rows.
- **Deep-domain-moat products** — accounting, payroll, core banking. Integrate; never rebuild.
- **Products whose foundation isn't the binding constraint** — consumer scale, ML-first,
  realtime-collaboration-first, dev tools.
- **Anything single-tenant and simple** — Rails or Wasp will beat us, and it isn't close.

## Why this page exists

Because the product is a trust claim, and a trust claim that hides its gaps is the one thing
that cannot survive being checked. If something here has changed and this page hasn't, that
is a bug — [tell us](https://github.com/substrat-run/substrat/issues).
