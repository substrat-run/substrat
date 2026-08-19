---
status: accepted
layer: plan
description: Accepted as D-32. The long form of its argument; still cited by D-45/K-37.
---

# Proposal: hosting as the monetization boundary; certification inheritance as the paid layer

**Status: accepted and merged — this is [master-plan.md](../master-plan.md) decision 32**
(2026-07-18, "Hosting is the monetization boundary; certification inheritance is the paid
layer"). All four edits proposed below landed — the decision-log row, the §6 build/buy row
("Certification & assurance programme"), the §7.4 paragraph ("Certification is what makes
the trust moat legible") and the §5.7 amendment ("What travels on exit, and what does
not"). **This document remains live, not historical**: it is the long form of D-32's
argument, and both [D-45](../master-plan.md#12-decision-log) and
[K-37](../design/kernel-design.md#14-design-log) (2026-08-08) cite its §3
shared-responsibility line as normative when scoping subject erasure — *"we provide
extraction, they define scope"*.

The sections below are preserved as written, insertion points included, because they are
the reasoning D-32 compresses into one row. Where this document and the master plan
disagree, the master plan wins.

## Why this exists

The plan has GDPR machinery as a build (§6), the "trust page early" lesson (§7.8), and the
adapter/escrow story (§5.7) — but **no position on certification**. That gap matters more
than it looks, because certification is the mechanism that converts §4's enforcement
architecture into something a procurement officer can price, and because deciding it
determines what hosting *is*: a delivery mode, or the product boundary.

The claim in one line: **the parts the platform provides are the parts AI gets dangerously
wrong, the parts a small vertical cannot certify alone, and the parts that only exist if
someone operates them.** Those three facts point at the same boundary.

### The precision the word "certify" hides

ISO 27001 certifies an **ISMS with a declared scope**; SOC 2 is an attestation on a
**service organization's controls**. Both attach to an organization operating a service,
never to a codebase. So the mechanism is not "Substrat is certified, therefore your app
is" — it is the **inherited-controls / shared-responsibility model**, as the hyperscalers
use it: we get certified as an operator, a vertical inherits a documented subset, and the
remainder sits in the vertical's own much smaller scope. SOC 2 already carries the honest
half of this as **complementary user entity controls** — the formal "here is what you must
still do." Writing that list truthfully is what makes the claim credible rather than
marketing.

| Inherits almost fully | Shared | Never transfers |
|---|---|---|
| Physical/infra security, availability, DR, encryption at rest and in transit, key management, backup and PITR, tenant isolation, audit-log integrity, migration governance, dependency and vulnerability management | Access control (we provide the mechanism, the vertical owns the grants), incident response (we detect platform, they own domain), DSAR fulfilment (we provide extraction, they define scope) | Lawful basis and processing purposes, retention decisions, staff vetting, support processes, domain correctness, **and the configuration** |

The last cell is the load-bearing one. **A perfectly certified platform, misconfigured, is
still a breach** — which makes the certification story and the two human checkpoints (§4)
the same mechanism seen from opposite ends. The permission diff exists precisely because
the one thing that cannot be inherited is whether *this* tenant's grants are right.

---

## Draft 1 — Decision log entry

**Insert as row 32 in §12**, after decision 31.

| # | Date | Decision | Rationale |
|---|---|---|---|
| 32 | 2026-07-18 | **Hosting is the monetization boundary; certification inheritance is the paid layer.** §5.7's Cloudflare-vs-pure-adapter split is a *portability* boundary and stays exactly as written; this decision names the *commercial* one, which sits elsewhere: inherited controls exist only where someone operates the controls, so the compliance product is purchasable only as an operated service. Consequences: (1) the AGPL build stays **fully functional and genuinely exitable** — no feature is withheld to create a paid tier, because the paid layer is not code; (2) the hosted service pursues **ISO 27001 + SOC 2 Type II first**, then GDPR Art. 28 processor-chain hygiene and EU Cloud CoC, then **EN 301 549/WCAG conformance in the app shell** (the most inheritable item on the list, since accessibility is a component-library property), with sector regimes (21 CFR Part 11, TISAX, C5, ENS, HITRUST) chased **on demand per segment, never speculatively**; (3) the auditor-facing evidence export becomes a product surface alongside §7.8's SIEM export; (4) self-hosters inherit **nothing** operationally and are served instead by a published **compliance pack** — control mapping plus evidence tooling — that gives their own auditor a running start; (5) **trajectory, not claim**: until an audit is complete the trust page publishes the roadmap and the architecture argument, never implied controls. Explicitly **not** decided here: timeline, headcount, hosting-org legal home, or whether Substrat is processor or sub-processor per deployment shape | Certification is a **fixed cost with the same shape as the foundation build** — roughly identical whether the vertical has 50 seats or 50,000 — so §7.7's cost curve repeats one level up, and the substrate collapses it the same way it collapses the build: fixed cost becomes per-tenant fee. The ICP makes this binding rather than nice: small-N/high-ACV/compliance-touched buyers are *defined* by procurement gates, and a three-person vertical cannot economically carry an ISMS. It also answers a question the plan had left open — **how to monetize AGPL without crippling the open version.** Open-core withholds features, which makes the free product deliberately worse and turns §5.7's exit story into the same theatre §7.8 says buyers have been trained to disbelieve; compliance-as-the-paid-layer withholds nothing and **cannot be copied by forking, because it is not code**. Most of what an audit costs is evidence that controls *operated*, and the kernel emits that structurally (audit spine, permission model, migration journal, per-scope PITR) — so the defensible claim is not "you are certified" but "your evidence is continuous rather than a quarterly fire drill," which is both stronger and true. Pricing follows: what is bought is insurance-shaped (risk transferred, cost avoided, nothing consumed), which argues for §9's value-based platform fee over per-scope metering. Honest costs, all real: SOC 2 Type II requires an **observation window of controls operating in production with real tenants**, so this cannot be front-run — the hosting business must exist and be unremarkable before the clock starts, which fixes the sequence as owned verticals → host them (tenant zero) → certify → open the §6.3 licensing channel with certification as the headline; being an operator means on-call, incident management, access reviews, vendor and sub-processor management, continuity testing and a permanent ISMS, most of which is not engineering headcount; and hosting converts a kernel isolation bug from embarrassing into a **reportable breach across the fleet** — §4 already knew the stakes, this decision makes us the party who answers for them. Amends the framing of 25 (dual licensing) without changing its terms |

---

## Draft 2 — §6 build/buy row

**Insert into the §6 capability table**, adjacent to the GDPR machinery row.

| Capability | Placement | Notes |
|---|---|---|
| Certification & assurance programme | **Build** | Not a kernel component but a kernel *obligation*, and the only row whose cost is mostly not engineering. ISMS, control mapping, evidence pipeline, auditor-facing export, CUEC list, trust page, sub-processor register, DPA templates. Placement-spectrum note (decision 27): the *evidence* is guarantee-surface-coupled and therefore inside — it is generated from the same spine that enforces the controls, and a compliance product reading a second, reconstructed history would be the exact leak the kernel exists to prevent. The *audit* is bought (external auditor, by definition). Compliance-automation vendors (Vanta/Drata-class) are an adapter-shaped buy for the workflow, never for the evidence itself |

---

## Draft 3 — §7.4 paragraph

**Append to §7.4 (Convergence risks)**, after the existing "latent channel" paragraph.

> **Certification is what makes the trust moat legible.** The enforcement argument is
> strong and slow: it asks a buyer to follow a claim about runtime architecture before
> they can value it. Inherited certification is the same moat stated in a sentence a
> procurement officer prices immediately — *you inherit our controls and your audit
> evidence generates itself* — which matters more than depth in early GTM. It also splits
> cleanly by audience, and the split determines where to push it. To **buyers of
> verticals** it is invisible plumbing: they never learn Substrat exists, they only notice
> the vertical cleared procurement, so it is a win-rate lever and not a message. To
> **builders of verticals** — the licensing quadrant, where the substrate business lives —
> it is plausibly the strongest purchase driver available, because engines save them
> months of build while certification saves them a market entry they might never manage
> alone. That completes the convergence answer: Lovable and Supabase can converge on
> capability, and neither converges on being an audited operator of someone else's
> regulated workload.

---

## Draft 4 — §5.7 amendment

**Append to §5.7**, after the paragraph ending "…the pure-SQLite adapter stays green in CI
forever."

> **What travels on exit, and what does not.** The escrow claim stays literally true —
> code, schema, data and a runnable single-node host all leave with the customer, which is
> the point of the two-adapter rule. What does not travel is the **operated** half: our
> certifications, our evidence pipeline, our incident response, our audited backups. That
> is true of every hosted service in existence, and the plan states it plainly rather than
> letting a buyer discover it during an audit — §7.8's own lesson is that this field has
> trained buyers to disbelieve portability claims, so the credible move is to name the
> limit before anyone asks. The gap is narrowed, not closed, by the compliance pack
> (decision 32): control mapping and evidence tooling published for self-hosters, giving
> their auditor a running start on a scope they now own entirely.

---

## What I need decided

1. **Is the boundary right?** The proposal makes *operation* the paid thing rather than
   any feature. That is a larger commitment than a §6 row — it shapes pricing (§9), the
   licensing channel (§6.3 of [candidate-verticals.md](../candidate-verticals.md)), and
   arguably the company's headcount profile.
2. **Sequencing.** Drafted as important-now, urgent-later, with the Type II observation
   window as the hard constraint. Worth disagreeing with if you think the licensing
   channel should open earlier on a trajectory claim alone.
3. **Processor or sub-processor**, and the hosting org's legal home — deliberately left
   open, but it interacts with the kernel-legal-home question already in §11.
4. **Whether the accessibility line survives.** EN 301 549 conformance in the app shell is
   the highest-leverage inheritance in the list and the least glamorous; it is also the
   one most likely to be cut for looking like a detail.
