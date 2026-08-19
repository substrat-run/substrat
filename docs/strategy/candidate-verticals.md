---
status: canonical
layer: plan
description: Living catalog of application categories. Falsifies the engine set; not a roadmap.
---

# Candidate verticals

A living catalog of application categories, ranked by fit with the Substrat model, with
the specific problem we would solve for each. Companion to [master-plan.md](../master-plan.md)
§7.5 (market notes) and §7.7 (the niche-vertical cost curve).

**This list is not a roadmap.** Its job is to falsify the engine set. Nothing enters
without naming (a) the concrete problem we solve that the buyer cannot buy today, (b) the
engines it exercises, and (c) what it would tell us if it turned out not to fit.

## 1. The fit test

**Does the product's value live in governed state transitions?** Is the thing customers
pay for a record of who did what, when, under what authority, and what may legally follow —
with rules about which transitions are allowed and an obligation to prove it later?

If instead the value lives in **computation** (optimizers, tax engines, solvers),
**rendering and delivery** (CMS, media, storefronts at scale), or **throughput**
(telemetry, chat, ad serving), the kernel is overhead wrapped around data with no
invariants to enforce.

Three amplifiers, in order of strength:

1. **Small-N, high-ACV, compliance-touched** — §7.7's ICP. Foundation cost, not demand, is
   the binding constraint.
2. **Nested tenancy** — chains, franchises, federations, municipalities, management
   companies. Structurally differentiating; almost nobody else does it well.
3. **Longevity** — records that must outlive the vendor. Our AGPL + pure-SQLite exit
   (§5.7, §9) is real where the field's portability claims are theatre (§7.8).

## 2. The primitive layer

Categories are not atomic. Almost every one decomposes into three or four recurring shapes
plus vocabulary. That decomposition is the platform thesis, and it is testable.

| Shape | Engine status |
|---|---|
| Work item / case — arrives, assigned, moves through states, closes | ✅ `workorder` |
| Booking — scarce resource in time | ✅ `booking` |
| Record of examination — checklist → signed, immutable artifact | ✅ `protocol` |
| Claim / ledger — owed, append-only | ✅ `invoicing` |
| Membership / roster — who belongs, in what role, paying what | candidate — lives in `demos/rally` |
| Registry with validity — true until a date: certificate, licence, permit, insurance | candidate |
| Application → assessment → decision — with eligibility, recusal, appeal | candidate |
| Plan / assignment over time — shifts, capacity, who works when | candidate |
| Asset lifecycle / custody chain — ownership, movement, condition | candidate (named in §3) |
| Deliberative body — motions, quorum, votes, minutes | candidate |

Per §3's *engines are extracted, not designed*, none of the candidates gets built until a
second vertical with a different shape needs it. Section 6 records which candidate is
closest to qualifying.

## 3. Shapes are global; the statute is local

Every primitive is jurisdiction-neutral. What differs by country is the **rulebook bolted
onto it** — which transitions are legal, which deadlines bind, what must be retained.

A vertical is therefore *one primitive stack + one jurisdiction's rulebook*. Two
consequences:

- **Global horizontals cannot take these markets.** Serving them means carrying N
  rulebooks, which destroys their unit economics — §7.7's cost curve applied across
  borders rather than across seat counts.
- **It is the portfolio's replication path.** The same stack re-skinned per jurisdiction
  is a new vertical at a fraction of the cost. BRF → HOA → condominio → syndic → strata →
  RWA is one product wearing six legal costumes. **Prefer first verticals with high
  replication potential over those with merely good local fit.**

### 3.1 Discovery method: follow the mandated audit trail

The sharpest lead filter available. Find a law that requires an auditable record and the
market is pre-qualified: the buyer is legally obliged to want what the kernel sells and
cannot negotiate it away. Keep this table alive — each new mandate is a market appearing
on a published schedule.

| Jurisdiction | Mandate | Shape it forces |
|---|---|---|
| US | 21 CFR Part 11 | audit trails + e-signatures, by statute |
| US (states) | Metrc seed-to-sale | custody chain |
| US | Davis-Bacon certified payroll · DOT driver qualification files | ledger · registry-with-validity |
| US | IDEA / IEP records | documents + deadlines + consent + appeal |
| UK | Building Safety Act "golden thread" | asset-lifetime auditable record |
| UK | DBS · Right to Work | registry-with-validity |
| DE | Lieferkettensorgfaltspflichtengesetz | supply-chain due-diligence record |
| EU | GDPR Art. 30 register · Whistleblower Directive · CSRD assurance · EUDR | provenance provable to an auditor |
| AU | NDIS provider obligations · Working with Children Checks | booking + claim + registry |
| Global | WADA whereabouts · GCP for clinical trials | immutable records |

EUDR is the one to study: an EU rule that forces traceability onto Brazilian, Indonesian
and West African producers. **Compliance shapes get exported across borders** — an
EU-shaped product can be handed a non-EU market by statute.

## 4. Buyer classes

The buyer need not be a company. Several of the highest-fit buyers are institutions whose
product *is* a governed record, and they are near-universally on legacy software:

- **Regulators and licensing bodies** — nursing boards, bar associations, trade licensing.
- **Certification, accreditation and audit bodies** — ISO, organic, halal/kosher, FSC, Qualiopi.
- **Federations** — sports federations licensing athletes and officials; nested tenancy is literal.
- **Cooperatives and mutuals** — SACCOs, credit unions, agricultural co-ops, mutual insurers.
- **Courts, tribunals, arbitration and mediation bodies** — at small-jurisdiction scale.
- **Funds and schemes** — multi-employer benefit funds, small pension schemes, apprenticeship funds.
- **Franchise networks** — brand standards, royalties, territory rights.
- **Works councils and co-determination bodies** — Betriebsrat, CSE; statutory quorum and minutes.

## 5. The ranking

### Tier 1 — flagship fit

The product is a legally defensible record. We solve something they cannot buy today.

**1. Regulators, licensing and professional bodies.** The register *is* the legal
instrument: a wrong entry means someone practising illegally, or a career destroyed. They
need every decision traceable to the authority that made it, appeals that reopen a case
without rewriting history, and a public register derived from private case files. Today
this is bespoke .NET from 2009, or Access. We solve: application→decision→registry as
governed state; the applicant sees only their own case through an entity-narrowed grant;
an audit spine that survives judicial review. Same product sells to hundreds of bodies
across professions and countries.
*Engines: application/decision (new), registry-with-validity (new), protocol.*

**2. Certification, accreditation and audit bodies.** Their certificate is worthless if the
audit behind it cannot be reproduced — and under ISO 17021/17065 the body is *itself*
audited on impartiality and records. Auditors are external parties who must see only their
own assignments. We solve: the audit→finding→corrective-action→certificate chain with
immutability at each hop; nested tenancy for scheme→region→client; per-auditor entity
grants. Highest replication ratio in the list — thousands of small bodies, one shape.
*Engines: protocol, registry-with-validity (new), workorder.*

**3. Statutory compliance registers.** Whistleblowing channels, GDPR Art. 30 registers,
SAM/OSHA, chemical inventories, supply-chain due diligence. These registers exist *solely*
to be produced under scrutiny, usually by an adversarial reader. Whistleblowing carries an
access requirement most tools simply fail: the case must be invisible to the implicated
manager, provably, at runtime. We solve: that is runtime permission enforcement, not a
feature flag — **the single best demonstration of the moat** — plus retention and DSAR as
kernel product.
*Engines: workorder, protocol. Kernel-heavy; a near-pure kernel demo.*

**4. Community and property associations.** BRF, HOA, condominio, syndic, strata, RWA.
Volunteers with annual turnover run legally consequential processes — assemblies, votes,
violation notices, architectural approvals, dues arrears — and every board handover loses
the history. We solve: nested tenancy (management company → association → unit → owner),
an owner portal through entity-narrowed grants, immutable minutes, dues ledger. Thousands
of tiny scopes makes per-scope pricing shine (§9). Best replication candidate in the list.
*Engines: membership (new), invoicing, deliberative (new), protocol.*

**5. Membership organizations.** Unions, clubs, chambers, federations, faith bodies,
studieförbund. The register is the organization's constitutional core and routinely holds
GDPR Art. 9 data — union affiliation, religion, minors' health notes. The SportAdmin
breach is the market proof, and a segment whose incumbent just leaked is pre-qualified.
We solve: Art. 9-grade access control with GDPR machinery as kernel product, dues ledger,
roles that differ per sub-scope, member self-service that never exposes the register.
*Engines: membership (new), invoicing, booking.*

**6. Grant and funding administration.** Stiftelser, kommunala föreningsbidrag, research
councils, NGO donor funds. Money flows on assessed applications and is clawed back when
the assessment cannot be evidenced; conflict-of-interest management on assessors is a
legal requirement, not an etiquette. We solve: application→assessment→decision with
**recusal enforced as a permission rather than a policy**, disbursement ledger, and
downstream redovisning as protocol. Small N, high ACV, audit is existential.
*Engines: application/decision (new), invoicing, protocol.*

**7. Regulated care and social services.** LSS, personlig assistans, hemtjänst, NDIS,
domiciliary care. The service delivered must be provable simultaneously to a payer
(Försäkringskassan, NDIA, local authority) and to an inspectorate, from the same records.
Staff turnover is high, so access must be scoped to current assignments only. We solve:
work order + booking + claim committed in one transaction, append-only time records,
per-client entity grants tied to the active roster. Highest compliance density on the list.
*Engines: workorder, booking, invoicing, plan/assignment (new).*

**8. Inspection and tillsyn.** Municipal miljö-, hälso- och livsmedelstillsyn; hiss,
lekplats, brandskydd. The inspection produces a legal instrument — föreläggande,
prohibition, fee — that must survive appeal. We solve: immutable-after-sign protocols, fee
ledger, decision→appeal state. **Caveat to test early:** inspectors work offline in the
field, and offline-first sync is not currently a kernel capability.
*Engines: protocol, invoicing, workorder.*

### Tier 2 — strong fit

Real governed state and compliance, but incumbents exist or the shape is partly commoditized.

**9. Asset lifetime records.** Building Safety Act golden thread, MRO airworthiness,
museum and archive collections, provenance. The record must outlive the vendor, the owner,
and often the building itself. That makes it an **exit-story problem** — and ours is real
where the field's are theatre (§7.8). Sharply differentiated; collections management is
still largely on FileMaker.
*Engines: asset/custody (new), protocol, documents.*

**10. Traceability and custody chain.** Food, pharma, cannabis (Metrc), EUDR commodities,
waste transfer notes. Recall speed and export-market access both depend on reconstructing
custody backwards from a batch. We solve: custody chain over the event spine, which
already answers "prove what happened." **Caveat:** per-item scanning at industrial volume
is a throughput shape — check N before committing.
*Engines: asset/custody (new), protocol.*

**11. Education administration.** Admissions (application→decision), IEP and special
education, attendance→funding, grades. Records with statutory consequences, held about
minors, with parental access rights and hard deadlines. Grades are immutable-after-set —
exactly the protocol invariant. **Go at the underserved edge** (special ed, admissions,
small independents), not the core SIS, where incumbents are entrenched.
*Engines: application/decision (new), protocol, plan/assignment (new).*

**12. Clinical-adjacent, non-clinical.** Physician credentialing and privileging, clinical
trial site management, IRB and ethics approvals, biobank consent. Credentialing is
registry-with-validity carrying patient-safety liability and is still run on spreadsheets.
**Stay out of the clinical record proper** — EHR/MDR is a different regulatory class and a
different company.
*Engines: registry-with-validity (new), protocol, application/decision (new).*

**13. Booking of scarce shared resources.** Municipal facilities (Interbook GO is ancient),
marinas and berths, allotments, cemeteries. Allocation is rule-bound and political —
priority to youth clubs, tenure, waiting lists — and disputes need an audit trail.
Cemeteries book in perpetuity, which reprises the longevity argument.
*Engines: booking, invoicing, membership (new).*

**14. Franchise and multi-unit operations.** Nested tenancy is not a feature here, it is
the product: HQ needs brand-standards visibility without seeing unit financials; units
need autonomy. The permission tree is the entire design, and "view as user" (§7.8) is the
demo.
*Engines: protocol, invoicing, workorder.*

**15. Cooperatives, mutuals and microfinance.** SACCOs, chamas, credit unions, agricultural
co-ops with input credit and delivery ledgers. Regulator and donor audit at institutions
far too small for core banking, yet handling money. **Boundary discipline:** we do the
member register, governance and obligation ledger; the money rail is a connector (§7.5).
*Engines: membership (new), invoicing, deliberative (new).*

**16. Field service and work orders.** Proven (`demos/callout`) but crowded (§7.5). What we
solve is not FSM generally — it is vertical depth at niche scale: OVK, F-gas,
borrprotokoll→SGU, EDI grossist. The reference vertical, not the flagship market.
*Engines: workorder, invoicing, protocol.*

**17. Deliberative bodies.** Works councils, boards, tribunals, arbitration, member
elections. Decisions must be legally valid and are challengeable — a stämma decision taken
without quorum is void. Small, sharply defined, and appears inside categories 4, 5 and 15.
*Engines: deliberative (new), protocol.*

### Tier 3 — conditional: fits only if you build the right half

The seam matters more than the category. Most of the money is here, so is most of the risk.

| Category | Build | Integrate / avoid |
|---|---|---|
| **HR** | Personalakt (Art. 9 registry), rekrytering (application→decision), scheduling, tid/frånvaro, kompetens (registry-with-validity) | **Payroll** — regulatory tables + money movement (Hogia, Fortnox). Performance reviews: no invariants, no compliance, weak fit |
| **ERP** | Operational half: order → plock → leverans → service (`demos/shop`, `demos/handlebar`) | **Financial half** — huvudbok, reskontra, moms, konsolidering. §7.5 already drew this line |
| **Document control / QMS** | ISO ledningssystem, SOP versioning, policy attestation, medtech: version → approve → distribute → attest → retain | **Publishing CMS.** The fit is "controlled documents", never "content" |
| **CRM** | Regulated relationship management: KYC, jäv, samtycke, medlemsdialog | **Generic CRM** — few invariants, high seat counts, Salesforce owns it |
| **Insurance ops** | Claims (application→assessment→decision), MGA workflow, warranty administration | **Underwriting maths, actuarial, capital** |
| **Legal and professional services** | Matter management, conflicts checking, AML/PTL obligations | **Billing rails, document assembly at scale** |
| **ESG / environment** | Provenance and assurance trail for CSRD, EPR, carbon MRV | **Calculation and factor engines** |
| **Logistics and fleet** | Driver qualification files, tachograph compliance, dangerous goods, waste notes | **Route optimization** — a solver, therefore a connector |

The recurring rule: **if the value is an algorithm, it is a connector the engine calls, never an engine.**

### Tier 4 — weak fit

Real software, but the kernel is overhead rather than leverage. Low invariant density, low
compliance obligation, high seat counts, or strong incumbents on all three.

Generic project management and PSA · sales and marketing tooling · helpdesk and ITSM
(genuine state machines, but little compliance weight and a crowded field) · e-commerce
storefronts · the undifferentiated "internal tools" category Retool already serves.

### Tier 5 — anti-fit

Structurally wrong. Say no clearly and early; these are where an enthusiastic agent would
waste a quarter.

| Category | Why it fails the test |
|---|---|
| Analytics, BI, data platforms | Read-heavy, cross-tenant, columnar — the inverse of scope-isolated OLTP |
| Publishing CMS, media, content delivery | Value is rendering and CDN, not enforcement |
| Real-time collaboration | CRDTs, not state machines |
| Communications (chat, telephony, email) | Throughput, not governance |
| Developer tools, observability | Wrong buyer, wrong shape, no tenancy story worth paying for |
| Payments and banking core, payroll calculation, tax engines | Money movement and regulatory computation — §7.5's declared boundary |
| Optimization, simulation, CAD, heavy GIS | The product is an algorithm |
| Consumer apps and marketplaces | High-N/low-ACV inverts the pricing model; the moat is network effects |
| IoT telemetry ingest at scale | Throughput shape; the spine is an audit log, not a time-series store |

## 6. The second axis: leverage

Section 5 ranks on **differentiation** — what the buyer cannot get anywhere else. That is
the competitive argument. It is not the whole picture, because it says nothing about how
much of the finished application we hand over for free.

**Axis A — differentiation.** Can they buy this elsewhere? (Why us.)
**Axis B — leverage.** What fraction of the shipped app is kernel + engines + connectors +
common services, rather than bespoke vertical code? (Velocity, margin, and how many
verticals a small team can carry.)

The two are largely independent, and the portfolio decision needs both.

### 6.1 Why the seal is defensible

Leverage is not merely code we did not have to write. **The parts the platform provides
are exactly the parts AI gets dangerously wrong.** Vertical domain logic rendered as slop
is a bug — annoying, fixable, and visible in testing. Tenancy, permission checks, audit
spine and migrations rendered as slop is a breach, a fine, or a silently corrupted history
nobody notices for two years.

So the sealed boundary (§4 of the master plan) is not an arbitrary line drawn for
architectural taste. It falls precisely between *wrong is embarrassing* and *wrong is
catastrophic* — which is the reason a builder who would otherwise resent the constraint
accepts it. State it that way in positioning: we do not seal the fun parts.

### 6.2 Predicting leverage: is the domain variation content or logic?

The best single predictor of where a category lands on axis B. Inspection, certification
and protocol-shaped categories score unusually high because what varies between an
OVK-protokoll, a lekplatsbesiktning and an ISO 9001 audit is the **checklist itself** —
data, authored by a domain expert, not code. Same for grant eligibility criteria and
membership fee structures: configuration, not branches.

Categories whose variation is genuine *logic* — payer-specific claim rules, statutory
assessment procedures that differ per licensing body — burn the leverage back down, because
each customer needs code. When scoring a new candidate, ask what a second customer in the
same category would need: new rows, or new branches.

### 6.3 The quadrants

|  | **High leverage** | **Low leverage** |
|---|---|---|
| **High differentiation** | **Own it.** Regulated care · community associations · certification bodies · inspection & tillsyn · membership orgs · grant administration | **Prove it.** Whistleblowing channel · regulators & licensing · asset lifetime records |
| **Low differentiation** | **License it.** Field service · scarce-resource booking · franchise ops · scheduling | **Skip it.** Tiers 4–5 |

**Own it** — high on both. The core portfolio: we ship fast *and* the buyer has nowhere
else to go. Every one of these should be a candidate for a vertical we build ourselves.

**Prove it** — differentiated, but the app is small, so the absolute time saved is modest
and the margin thin. These are lighthouse assets, not revenue lines. **This corrects §9's
enthusiasm for the whistleblowing channel:** it is the best possible *proof* of the moat
and a weak *business*, because the entire application is roughly a kernel demo with a
form on top. Build it to sell everything else. Regulators and licensing bodies land here
for a different reason — high differentiation, but each body's statutory rules are bespoke,
so the leverage that should exist gets eaten by per-customer work. Serve them via partners
or professional services, not as a product line.

**License it** — this is the most useful reframe the second axis produces. Field service is
crowded (§7.5) and I demoted it in §5 accordingly. On axis B it is the archetype of the
*substrate* business: a partner can ship a credible FSM vertical in weeks because the
engines already exist. Crowded markets are not worthless markets — they are the wrong
*business model* for us. They are where the kernel sells to third-party verticals rather
than where we build. "We build the substrate, they build the verticals" (§2 of the master
plan) has a concrete target list, and this is it.

### 6.4 Leverage compounds per market, not per shape

Engines are shape-specific; **connectors are market-specific**. Fortnox, BankID, Swish,
Kivra, Peppol and fastAPI are reusable across every Swedish vertical and worth nothing in
Ohio.

This cuts against §3's replication argument and the tension is worth holding honestly.
Shape-replication (BRF → HOA → condominio) says go wide geographically. Connector-leverage
says go deep in one market first. Resolution: **replicate shape within a market before
replicating across jurisdictions.** Swedish BRF → samfällighet → coworking → förening
share a connector fleet, a language, a payment rail and a compliance regime; the second
Swedish vertical is dramatically cheaper than the first American one, even when the
American one reuses more engine code.

Jurisdiction-hopping is a later and more expensive move than it looked in §3, and it
should be priced as a market-entry decision (new connector fleet, new statutory rulebook,
new GTM) rather than as a re-skin.

## 7. What the ranking says about engines

The top of the list is not asking for eight new engines. Four candidates carry Tier 1
almost entirely, in this order of evidence:

1. **Application → assessment → decision** — required by categories 1, 6, 11, 12 and the
   Tier 3 insurance and HR slices. The widest unmet shape in the catalog, and the one
   carrying the most legally consequential invariants (eligibility, recusal, appeal
   without history rewrite).
2. **Registry with validity** — categories 1, 2, 12, plus behörigheter in `demos/callout`,
   kompetens in HR, besiktningsintervall in fastighet, ledarlicenser in clubs. Small,
   sharply defined, and already appearing in four places — **closest to qualifying for
   extraction under §3's rule.**
3. **Membership** — categories 4, 5, 13, 15. Already implemented as vertical code in
   `demos/rally` (`rally_members`, append-only wallet ledger, klippkort subscriptions,
   entity-narrowed grants walking reservation → member). A second membership vertical is
   the extraction test.
4. **Deliberative body** — categories 4, 15, 17. Smallest and least urgent; may turn out
   to be `protocol` plus vocabulary, which is itself a useful finding.

## 8. Falsification notes

What would tell us the model is narrower than this document claims:

- **A Tier 1 category that needs to fork an engine** — §3's design test failing in the
  segment we rank highest.
- **Membership resisting extraction** — if coworking and unions want membership shaped
  incompatibly, the primitive is vertical vocabulary, not an engine, and Tier 1 gets
  more expensive.
- **Offline-first turning out to be load-bearing** (category 8, and field work generally) —
  that is a kernel capability we do not have and have not costed.
- **Replication proving harder than re-skinning** — if HOA is not mostly-BRF, §3's
  "one product, six costumes" claim is wrong and the portfolio economics change.

## 9. Immediate reads

- **Whistleblowing channel** (category 3) is the best near-pure-kernel demo available:
  legally mandatory across the EU for employers over 50, small enough to build quickly,
  and its core requirement — the implicated manager provably cannot see the case — is
  exactly the moat, made visible.
- **Coworking** (category 5) is the cleanest second membership vertical: booking +
  invoicing, no new engine required, and not Sweden-locked, so it also tests whether the
  compliance story travels.
- **Community associations** (category 4) is the strongest portfolio bet, because it is the
  only Tier 1 entry that replicates into six jurisdictions off one stack.
