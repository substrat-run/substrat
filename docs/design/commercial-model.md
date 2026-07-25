# Commercial model — tiers, marketplace, and what may be metered

**Status:** design synthesis, **not ratified**. This doc expands master-plan §9 (Commercial
structure) and decision 32 ([hosting-and-certification](../proposals/hosting-and-certification.md))
into an operational pricing position: the tier ladder, the self-serve floor math, the
enterprise SKU, the marketplace, and the metering discipline. The master-plan decision log
stays the authority — where a number here is a *proposal* it says so; where it restates a
decision it cites it. Concrete figures (bundle price, per-scope rate, take rate) are
starting points for a real pricing exercise, not committed prices.

The whole model falls out of six invariants. Every section below is one of them applied.

> 1. **Cost-plus for commodity; margin only for labour or transferred risk.** Hosting is
>    commodity infra → cost-plus, no markup (D-30). A maintained connector or an operated
>    compliance programme is skilled labour / insurance → margin is fair.
> 2. **Meter everything, bill the few** (D-30, "meter, don't bill"). The spine makes every
>    invocation countable; almost none of them appear on an invoice.
> 3. **No open-core; the paid layer is operated, not code** (decision 32). No feature is
>    withheld to build a tier. The AGPL build stays fully functional and exitable.
> 4. **Never meter platform-native growth — or spine granularity.** Per-operation billing is
>    the ServiceNow trap (§7.8) and, for us, an incentive to starve the audit spine.
> 5. **Two user populations, priced asymmetrically** (§9). Staff seats are the *vertical's*
>    revenue; end-users are bundled MAU, never seat-priced.
> 6. **Price by vertical shape** (§7.7). Many-scope verticals monetize through per-scope and
>    network meters; small-N/high-ACV through a value-based platform fee + engine licensing.
>    Do not flat-rate the kernel across verticals.

## 1. The tier ladder

Three tiers. The trial is a funnel, not revenue; self-serve is the credit-card floor;
certified/enterprise recoups the fixed investments (CF Enterprise, certification).

| Tier | Who | Price shape | Notes |
|---|---|---|---|
| **Trial / preview** | anyone evaluating | free | preview scopes, seeded data, **no production binding** — agents build here (Replit-incident lesson, §7.8). Zero marginal cost; the funnel. |
| **Self-serve** | vetted builders (deploy model B) | **~$49/mo bundle** + cost-plus overage, spend-capped | live production, standard WfP, bundled MAU, standard retention, community trust page. Ships early — **no CF Enterprise, no certification in the critical path.** |
| **Certified / Enterprise** | small-N, high-ACV, compliance-touched | value-based, negotiated | the operated compliance envelope + sovereignty + SSO/SCIM + SLA. Recoups CF Enterprise + certification because it is the tier that consumes them. |

### 1.1 The self-serve floor is fixed and shared, not per-scope

Verified 2026 Cloudflare costs for the whole self-serve fleet (not per tenant):

| Line | Cost | Includes |
|---|---|---|
| Workers for Platforms | **$25/mo** | 20M requests, 60M CPU-ms, **1,000 scripts**; overage $0.30/M req, $0.02/M CPU-ms, $0.02/script; subrequests not billed |
| Advanced Certificate Manager | **$10/mo** per zone | wildcard certs (one subdomain level), up to 50 hosts/cert — covers `*.<tenant>.substrat.run` |

Source: [WfP pricing](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/platform/pricing/),
[ACM](https://developers.cloudflare.com/ssl/edge-certificates/advanced-certificate-manager/).

**Consequence:** the ~$35/mo floor is *flat to ~1,000 scopes / 20M requests* and shared
across the entire self-serve base. Marginal infra cost per additional scope ≈ $0 in the
early regime; one paying tenant covers the whole floor. So a $49 bundle clears the fixed
cost immediately, and the per-scope floor you charge is near-pure contribution, not infra
recovery. Anchors: Supabase Pro $25, Lovable prosumer ~$25 — below the $1–3k/mo it costs to
assemble the stack à la carte (§7.6).

### 1.2 What the $35 floor does *not* include (the real variable meter)

Compute + certs only. These scale per tenant and are transparent **cost-plus** (D-30):

- **Per-scope data** — D1 / Durable Objects / R2 storage and reads/writes (the real driver).
- **Queues, AI-gateway model spend, email/SMS transport** — each an adapter with its own cost.
- **Custom hostnames** (tenant vanity domains) — Cloudflare for SaaS, **separate from ACM**
  (~$0.10/hostname/mo beyond the included allotment). Budget separately or the feature blows
  the floor.
- **Regional Services / DLS** — not here; the CF Enterprise commit, in the certified tier only.

### 1.3 The $49 bundle (proposal)

Vercel-shaped bundle, one deviation: **overage is cost-plus, not marked-up profit** — the
counter-position to Vercel's surprise-bill reputation, and a trust-page asset. Add
**spend caps + alerts** (D-30 gives the meter; the cap prevents the surprise bill). Profit
lives in the license meters on top, never in hosting markup.

| Included | Suggested allowance | Maps to |
|---|---|---|
| Tenant + scopes | 1 tenant, 3 active scopes (then per-scope overage) | the per-scope unit (§9 meter 1) |
| Requests | slice of the 20M pool, e.g. 1M/mo | WfP included tier |
| End-user MAU | bundled, e.g. 1,000 (overage cost-plus) | Clerk shape; never seat-priced |
| Storage | a few GB, then cost-plus | the real variable driver |
| Logs | short retention (3–7 days) | *long* retention is the enterprise SKU |
| Audit log | always on, unlimited existence | never charged for existing (§7.8) |

Free trial month: preview-scope (zero abuse surface) or a capped production month with the
spend cap on from day one. Safe because self-serve launches as deploy **model B** — vetted,
named builders through human admission ([self-serve-deploy](self-serve-deploy.md) §7). Tighten
to preview-only when open self-serve (model A) lands.

## 2. The enterprise SKU — operated, not withheld

Decision 32 forbids open-core: *"no feature is withheld to create a paid tier, because the
paid layer is not code."* So an item may enter the enterprise tier for exactly two reasons:

- **(A) it is an operated guarantee** — insurance-shaped, real only when someone runs the
  controls; nothing consumed.
- **(B) it passes through a real operating cost** — a CF add-on, a storage sink, a per-connection
  vendor fee; cost-plus per D-30.

| Enterprise feature | Why (A/B) | Grounding |
|---|---|---|
| Certification inheritance — ISO 27001 / SOC 2 Type II evidence, compliance pack, auditor export, DPA, sub-processor register, CUEC list | A | decision 32; §6 |
| EU/US jurisdiction **enforcement** (residency guarantee) | B — Regional Services is a **CF Enterprise add-on** | [control-plane](control-plane.md) §; jurisdiction default `global` |
| Support / SLA / incident response / access reviews | A | decision 32 |
| Audited support impersonation (view-as-user) | A | §7.8; master-plan platform-ops row |
| Long audit retention, field history, SIEM export | B — Tier-2 storage sink beyond the hot window | §7.8; control-plane hot-storage note |
| Enterprise SSO / SCIM connections | B — WorkOS-class ~$65–125/conn/mo | §7.6 |
| Dedicated isolation posture | B | §7.8 control/data-plane split |

**Must NOT be gated** (ships in AGPL, works for everyone — gating any of these turns the exit
story into the theatre buyers disbelieve, §7.8):

- DSAR export, crypto-shredding erasure, retention *policies* — a selling point in the free
  build (§6, "nobody sells it in this shape").
- The audit log's existence, the permission model, migration governance, per-scope PITR — the
  spine. Charge for *retaining it longer* (a real storage cost), never for it existing.
- The SSO *capability* in the app shell. Only enterprise *connections* (which cost you
  per-connection) are metered.

Self-hosters inherit **nothing** operationally and are served by the published compliance
pack — which is honest and cannot be forked around, because it is not code.

## 3. Value-based enterprise pricing

Certification/compliance is insurance-shaped (risk transferred, nothing consumed), which
argues for a **value-based platform fee over per-scope metering** (decision 32). Price a
*fraction* of value delivered; leave the customer most of the surplus.

**Worked example — a Playtomic-scale operator** (~4.7M users, ~20k clubs, €346M transacted,
**€29M net revenue** 2025; [Global Padel Report](https://www.sportstourismnews.com/playtomic-global-padel-report-2025-the-global-sport-of-the-future/)):

- Value stack: avoided build+operate of the foundation (~€500k–1M+/yr for a company this
  size), avoided in-house SOC 2 / ISO 27001 (~€100–300k/yr), and risk transfer on a
  cross-tenant leak across millions of PII records (existential → structurally impossible).
- Capture rate: Salesforce Shield anchors 10–30% of net spend (§7.8); OutSystems runs
  $36k entry → $100k+ enterprise (§7). **But the hard ceiling is the customer's P&L** — an
  infra vendor taking more than a few percent of net revenue is unsustainable. €29M net →
  **~1–2% = €150k–500k/yr** is the credible band.
- **Do not list per-scope at scale**: 10k clubs × €20/scope/mo = €2.4M/yr (>8% of their net
  revenue), a non-starter. Structure as a **committed annual deal** — volume-discounted
  per-scope + a few bps on transacted volume (5–10 bps on €346M ≈ €170–350k) + the
  compliance/SLA envelope. Converges on the same band from two directions.

**Honesty:** an established, profitable operator is the *hardest* enterprise sale (sunk
build, switching risk). The number is far easier to realize from a growing operator who has
not yet built the foundation. For an incumbent the only wedge is compliance inheritance +
sovereignty, not "savings."

## 4. The marketplace

Not one catalog — **three sellable object types**, each with its own unit and trust bar:

| Object | Unit | Trust bar | Opens |
|---|---|---|---|
| **Verticals** (turnkey apps) | 70/30 revenue split (§4.1) | sandboxed by runtime enforcement | earliest (deploy model B → A) |
| **Engines** (licensed modules) | per-tenant/mo + small rev-share kicker (§9 meter 2) | kernel-side under CLA | with the licensing channel |
| **Connectors** (capabilities) | per-connection/mo (§5) | **host code** — highest bar | curated longest |

Why Substrat can host *turnkey* third-party apps where a normal PaaS cannot: **runtime
enforcement is the moat.** A stranger's vertical still cannot cross a tenant boundary, forge
the audit spine, or skip a permission check — the kernel enforces it mechanically. So a buyer
runs a stranger's app on certified infra without every app needing its own audit. This is the
endgame of `substrat push`.

Phasing follows the deploy trust models ([self-serve-deploy](self-serve-deploy.md) §3): our
verticals → vetted builders (model B) → open marketplace (model A, gated on the inspecting
build sandbox §6.1 and abuse metering §6.4). Once strangers' code runs on the certified
fleet, a kernel isolation bug is *"a reportable breach across the fleet"* (decision 32) — the
marketplace and certification maturity advance together.

Typical marketplace apps — the ICP shape (small-N, high-ACV, compliance-touched,
record+workflow), composable from existing engines: **HR/personnel** (canonical: universal,
PII-dense = GDPR is our moat not the builder's, workflow+record shaped), field service,
BRF/property portals, booking-shaped (clubs/studios/clinics/rental), inspections/checklists,
member organizations, case management. **Anti-list** (§7.9): deep-domain-moat products
(payroll *calculation*, accounting core, banking), real-time/high-frequency, consumer-scale
social. "HR" is great; "HR that computes Swedish payroll tax" is a Fortnox *connector*.

### 4.1 Take-rate — two lanes

The take rate scales with how much you provide. The pitch is **"powered-by," not app-store
tax**: the builder writes only the vertical (screens, vocabulary, pricing, roles); you run
everything else. 30% is fair because you do ~70% of the work — and defensible because the
**AGPL + pure-SQLite eject is real** (§9), which is the antidote to the walled-garden critique
Apple earns.

| Lane | Price | For |
|---|---|---|
| **Fully-managed** | ~30% all-in, taken at the payment rail; zero upfront | builders who want to do nothing but build — the Shopify/Substack model, aligned incentives |
| **BYO-GTM** | per-scope hosting floor + ~10–15% commission | builders bringing their own GTM/support/domain work |

Decide **gross vs net** before quoting 30%: "30% of gross, we absorb processing + chargebacks"
vs "30% net, builder absorbs them" are very different economics.

### 4.2 Payment rail — Stripe Connect, behind an adapter

Stripe Connect is the purpose-built split mechanism; `application_fee_amount` /
`application_fee_percent` does "we take 30% directly" at settlement, and resolves §9's
"never audit their P&L" rule — you meter the gross *payment*, not their books. Connect also
gives connected-account onboarding, KYC/AML, payouts, and tax forms for free.

- **Charge type = the lane.** Destination charges (you control the flow, builder is payee via
  `on_behalf_of`) = fully-managed lane. Direct charges (connected account is merchant) = BYO-GTM.
- **Keep it behind the billing adapter** (§5.7): Stripe Connect is the *default* rail, not the
  hardcoded one. Swedish B2B frequently pays by **invoice**, so a card-only marketplace misses
  real behavior — an invoice-rail alternate (Fortnox / Peppol) sits behind the same
  `MarketplaceBillingRail` port.

### 4.3 Merchant of record

Not legally required, but **effectively expected for the managed lane** — MoR is the
money-and-tax half of "we manage everything," and it is *why* a 30% cut is accepted (Apple is
MoR). A bare facilitator taking 30% while the builder still handles their own VAT/refunds
breaks the promise.

- Stripe Connect is **not** a tax MoR — with Connect, *you* (destination) or the *builder*
  (direct) remain merchant of record for VAT. Third-party MoR (Lemon Squeezy / Paddle /
  Stripe Managed Payments, from the July-2024 Lemon Squeezy acquisition) charges ~5% + $0.50
  and is built for **single-seller SaaS, not marketplace splits** —
  ([comparison](https://www.globalsolo.global/blog/stripe-vs-paddle-vs-lemon-squeezy-2026)).
  The clean "MoR **and** 70/30 split" is not, today, one turnkey product.
- **B2B reverse-charge is the escape hatch.** Cross-border B2B in the EU reverse-charges VAT
  to the buyer, collapsing most of what a heavyweight MoR solves. So **be your own MoR** for
  B2B (Connect for the split + Stripe Tax + a handful of VAT registrations) rather than rent
  one; reserve third-party MoR for a B2C/global-consumer expansion. **Validate the specific
  VAT setup with a tax advisor** — not asserted here.

## 5. Connectors as paid marketplace objects

Per-connection recurring pricing is doctrine (§9 revenue stream c): **table-stakes bundled,
premium per-connection**; anchors Fieldly EDI 399 SEK/mo, Merge $65/account/mo, Nango
$1/connection (§9). The maintenance-cost instinct is the correct justification, and it is the
one place margin over cost is *right*:

- **A maintained connector is skilled labour + a decaying liability**, not commodity infra.
  Third-party APIs change, deprecate, rotate auth. A connector that ships and rots fails
  *silently in production* — worse than none. The per-connection fee **funds the SLA of
  keeping it alive**; revenue matched to obligation. (Consistent with D-30: you are not
  reselling infra, you are selling the guarantee it keeps working.)

| Tier | Examples | Price |
|---|---|---|
| Table-stakes, bundled | Fortnox, BankID, Swish | included (gating basic viability = ServiceNow trap) |
| Premium, per-connection | EDI grossist packs, branschprotokoll, e-sign (Scrive), sector-specific | ~200–500 SEK/mo/connection |
| Long-tail / third-party | community-contributed | rev-share, highest admission bar |

**The trust caveat that separates connectors from apps:** connectors are **host code, never
module code** — they hold credentials and make network calls, which the runtime-enforcement
moat does *not* sandbox. A third-party connector is a credential-exfiltration and
reportable-breach surface, not just a broken screen. So: keep connectors first-party /
tightly-admitted **much longer** than verticals; "installing" one provisions a per-tenant
connection with OAuth/token entry, not a toggle; and first-party premium connectors carry
*your* SLA when they break.

## 6. What may be metered — meter everything, bill the few

The spine makes every invocation countable and per-tenant attributable — a real edge. But
bill per-invocation **only** when the invocation is:

- **(a) real marginal cost to you** — a connector call out, an AI-gateway model call, an
  outbound webhook (metering *tracks cost*, D-30 permits); or
- **(b) a discrete cross-boundary transaction the customer recognizes** — a cross-tenant
  arbetsorder, an e-signature, an EDI dispatch (§9 meter 4, the network-transaction fee).

**Never** bill per ordinary operation (create work order, permission check, event emit, screen
load). That is the ServiceNow custom-table trap (§7.8) — *and*, uniquely for us, it prices
customers against our own invariant: every mutation *must* emit a fat event, so per-event
billing incentivizes emitting fewer, coarser events, **starving the audit spine** the whole
value rests on. Same logic as "never charge for the audit log existing," one level deeper:
don't charge for its *granularity* either.

Metering every invocation still earns its keep without billing on it: it powers (1) the
network-transaction meter, (2) cost-plus attribution for the usage tier, (3) abuse detection
and spend caps, (4) compliance evidence. **Meter, don't bill.**

## 7. Bootstrap: services before the platform exists

Selling hours to build the first verticals is §9's cold-start out of the N=1 problem — but
only one framing builds the platform:

- **Design-partner–funded engine development** — customer funds engine/vertical v1 as paid
  work, **IP stays kernel-side under CLA**, engine then licenses per-tenant/mo. Every hour sold
  leaves a licensable asset.
- **Generic app-building consulting** — same hours, bespoke output, no reusable asset. An
  agency. The failure mode §9 warns against ("a development partnership wearing a platform
  license as a costume").

Discipline: price the handover explicitly, keep the CLA, convert partnership → arm's-length
pricing at the **second external consumer**, and ring-fence services as a customer-acquisition
/ engine-funding cost — never let it become the P&L, or roadmap attention follows the billable
work and the substrate stops getting built.

## 8. Open questions

1. Actual numbers — bundle price, per-scope rate, MAU allowance, enterprise bands — need a
   real pricing exercise against live cost data; the figures here are anchored starting points.
2. Gross vs net on the 30% take, and who bears Stripe processing + chargebacks per charge type.
3. Whether Stripe Managed Payments (MoR) and Connect (marketplace split) ever combine into one
   product — would change the MoR build/buy decision.
4. The specific EU VAT / MoR legal setup (registrations, reverse-charge handling, processor vs
   sub-processor per deployment shape — decision 32 left the last one open) — a tax-advisor item.
5. Connector admission for third parties — the strictest admission model, gated on certification
   maturity and the §6.4 abuse/egress story.
6. Enterprise-tier trigger: at what point a self-serve tenant needs CF Enterprise / Regional
   Services, and how that upgrade is priced and provisioned.
