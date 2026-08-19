---
status: historical
layer: plan
description: How platform incumbents handle extension, upgrades, tenancy.
---

# Platform-with-modules landscape: Odoo, SAP, Salesforce, and the kernel-shaped alternatives

*2026-07-14. Deep-research pass (5 search angles, 25 sources fetched, 122 claims extracted,
top 25 adversarially verified 3-0 each, 0 refuted). Answers three questions: is Substrat an
Odoo competitor; do companies build real products on these platforms or internal tools; and
what does each incumbent's history teach that the design already absorbs or still misses.
Complements master-plan §7 (which covers the modern neighbors: LCAP, prompt-to-app, BaaS).*

## 1. The organizing split: org-shaped platforms vs kernel-shaped foundations

The verified evidence divides the field into two categories, and the division answers the
positioning question directly:

- **Org-shaped platforms** (Odoo, SAP S/4HANA, Salesforce, and — unverified this pass but
  almost certainly — ServiceNow, Power Platform): single-organization systems where
  extension happens inside or beside a **vendor-owned core**. The platform's tenants are
  the vendor's customers. A builder cannot serve *their own* customers multi-tenant from
  inside the platform.
- **Kernel-shaped foundations** (Medusa, Supabase): code in the builder's repo,
  module-owned schema, runtime-enforced isolation. The builder's customers are the
  builder's tenants.

Three dividing tests fall out of the evidence: (a) who owns domain schema — vendor core vs
builder modules; (b) whose customers are tenants — the platform's orgs vs the builder's own;
(c) where domain logic lives — vendor runtime/metadata vs code in the builder's repo.
Substrat sits on the kernel side of all three. **It is not an Odoo competitor; it is a
kernel in the Medusa/Supabase lineage, aimed at a shape (builder-owned multi-tenant vertical
SaaS) that none of the org-shaped platforms natively supports.**

## 2. Odoo, in depth

### Extension model and the upgrade treadmill

- Odoo Community Edition has **no official cross-version upgrade path**. Odoo S.A.'s
  migration scripts are closed-source and Enterprise-only
  ([upgrade.odoo.com](https://upgrade.odoo.com) requires an Enterprise subscription code);
  Community upgrades depend entirely on the OCA's
  [OpenUpgrade](https://github.com/OCA/OpenUpgrade), whose own docs state Odoo CE "does not
  support migrations from one major release to another." The platform's upgrade treadmill
  is outsourced either to a paid vendor service or to a nonprofit collective. (Verified 3-0,
  primary sources.)
- OpenUpgrade is **structurally fragile**: every installed module needs Python/SQL
  migration scripts across its full dependency chain for every version hop (migrating
  `account` requires scripts for `base`, `product`, `uom`). The OCA's own blog admits "this
  project is difficult to finance"; Odoo 17's base migration finished roughly a year after
  release, and even the post-2024 funded roadmap targets only a "minimum usable version"
  ~3 months after each Odoo release
  ([OCA blog](https://www.odoo-community.org/blog/news-updates-1/openupgrade-187)).
  (Verified 3-0.)
- Major versions break modules as a matter of course: Odoo 19 changed the ORM, the QWeb
  rendering engine, and the frontend framework (OWL 2), so third-party modules require
  code-level porting, not re-installation. (Extracted from practitioner sources; consistent
  with the verified OpenUpgrade picture but not itself in the verified set.)

This is the concrete mechanism behind "the Odoo addon treadmill" cited in master-plan §3
and decision 19: N modules × M versions × dependency chains, with migration authorship
falling on whoever owns the module.

### Tenancy: single-org shaped, including the vendor's own PaaS

- **Odoo.sh is one project per GitHub repository** with no documented reselling or
  customer-hosting mechanism; dbfilter-based multi-database hosting (the standard
  multi-tenant Odoo pattern) is not supported on it. Versions are permanently blocked at
  6 years ("no exceptions possible" — [Odoo.sh FAQ](https://www.odoo.sh/faq)) and incur a
  25% surcharge past 3.5 years. The platform vendor's own PaaS is not shaped for ISVs
  serving their own customers. (Verified 3-0.)
- Odoo's built-in multi-company feature is **not multi-tenancy**: companies share the
  module set, version, and admin pool; unrelated tenants cannot safely share a database.
  Builders who run multi-tenant Odoo SaaS do it **self-hosted**, typically one Postgres
  database per tenant with shared code, with home-built provisioning around it.
  (Extracted, consistent across practitioner sources; not in the verified top-25.)

### Ecosystem reality: real products exist, but the gravity is integration work

The honest answer to "do companies build real products on Odoo": **yes, but it is the
exception, and the platform gives them nothing for it.** The dominant ecosystem shape is
per-customer implementations by integrator partners (project income). Verticalized
commercial products on Odoo exist (e.g. construction ERP distributions), and commercial
kits exist specifically to help partners convert to recurring-revenue SaaS hosting — which
is itself evidence that the platform lacks the primitive. Anyone doing it owns the
provisioning, tenancy, and upgrade machinery themselves, on self-hosted infrastructure,
against the OpenUpgrade treadmill. (Ecosystem-shape claims rest on practitioner/blog
sources; the *absence* of a supported path is verified via Odoo's own docs.)

## 3. SAP: the canonical schema-openness lesson

- **Clean core is SAP's retreat from decades of Z-code pain.** SAP's own framing: classic
  extensibility "allows you to modify the standard SAP code itself. Hence, upgrade effort
  increases and agility/innovation speed decreases." The methodology's goal is
  bidirectional upgrade-safety ("extensions should not break an upgrade and upgrades should
  not break an extension") via a zero-modification policy and released/whitelisted APIs
  only. Exactly three sanctioned extension paths remain: key-user in-app, on-stack ABAP
  Cloud ("Embedded Steampunk"), and side-by-side on BTP
  ([SAP community, extensibility options](https://community.sap.com/t5/enterprise-resource-planning-blog-posts-by-sap/sap-s-4hana-extensibility-options-for-clean-core-journey/ba-p/13568992)).
  (Verified 3-0.)
- **The strict rule then failed too, in the other direction.** The binary clean/not-clean
  classification proved "too restrictive and not applicable for systems with a lot of
  existing custom code," forcing the August 2025 retreat to graded A–D levels
  ([Aug 2025 guide](https://community.sap.com/t5/technology-blog-posts-by-sap/abap-extensibility-guide-clean-core-for-sap-s-4hana-cloud-august-2025/ba-p/14175399)).
  Level D — direct modifications, write access to SAP tables, implicit enhancements — is
  the defined anti-pattern. Enforcement is technical in public cloud, governance-only
  on-premise. (Verified 3-0; SAP calls this an "evolution," the retreat reading is
  interpretive.)
- **ISV SaaS means leaving the core entirely**: partners who want to sell SaaS must run
  side-by-side on BTP, touching S/4HANA only via remote released APIs, with CAP providing
  multitenancy through configuration
  ([CAP multitenancy docs](https://cap.cloud.sap/docs/guides/multitenancy/)). SAP could
  not retrofit builder-owned tenancy into the ERP — it built a separate kernel beside it.
  (Verified 3-0.)

Two lessons, not one. The first (seal the schema, publish typed extension points) is
already decision 26. The second is subtler: **a sealing rule that offers no graded path
for messy reality gets renegotiated under installed-base pressure.** A greenfield kernel
avoids SAP's retrofit problem, but the design should expect pressure on the seal (the
"vertical needs one more hook" moment) and answer it with sanctioned extension surface —
substates, custom fields, manifest-declared guards — rather than exceptions.

## 4. Salesforce: proof that real ISV products ship on a platform — and the price

Second-generation managed packaging (2GP) is a genuine, formal commercial-product channel:
built explicitly for AppExchange partners distributing to many customers, with the ISV's
source in their own version control as source of truth, and **vendor-controlled push
upgrades** into subscriber orgs without customer action
([2GP docs](https://developer.salesforce.com/docs/atlas.en-us.pkg2_dev.meta/pkg2_dev/sfdx_dev_dev2gp.htm)).
(Verified 3-0.)

Salesforce is the strongest existing proof that platforms *can* host commercial ISV
ecosystems — the AppExchange model is the closest analogue to "engines licensed to
strangers." But the ownership is authoring-only: Apex/metadata run solely on Salesforce's
proprietary runtime, are non-portable, and every end customer is a separate *Salesforce*
org — tenancy belongs to Salesforce, never to the ISV. The mechanism worth stealing is
push upgrades: the engine vendor (Substrat) owning migration execution into deployed
verticals, rather than mailing migration scripts OCA-style.

## 5. The kernel-shaped precedents

### Medusa: the closest architectural relative

Medusa v2's module system independently converges on several kernel-design decisions
(verified 3-0 against current docs):

- **Strict module isolation**: "a module is unaware of any resources other than its own" —
  no resolving another module's services, no touching its data models
  ([isolation docs](https://docs.medusajs.com/learn/fundamentals/modules/isolation)).
  Star topology, independently arrived at.
- **Cross-module associations via link tables with no foreign-key constraints**
  ([module links](https://docs.medusajs.com/learn/fundamentals/module-links)) — the same
  move as opaque `(entity_type, entity_id)` refs.
- **Per-module migrations as real TypeScript classes** (up/down, hand-writable, in the
  module's own directory) — the engines-own-their-tables-and-migrations pattern, shipping
  in production.
- Core modules are **swappable rather than forkable** (vendor-claimed, not independently
  proven at scale).

Where it stops short of Substrat: Medusa has **no native multi-tenancy** — multi-tenant
platforms on Medusa typically run one instance/database per tenant with orchestration
built around it — and no runtime permission enforcement comparable to the scope-DO model.
It validates the module architecture, not the tenancy or trust layer. Open question
whether any commercially significant vertical SaaS runs on it outside e-commerce.

### Supabase: proof of both halves of the bet, minus the opinion

- Supabase's recommended B2B tenancy model is **runtime enforcement in the database**
  (Postgres RLS + RBAC, "no custom middleware, no tenant-routing code" —
  [supabase.com/solutions/b2b-saas](https://supabase.com/solutions/b2b-saas)), and real
  commercial SaaS companies are built on it: Resend (5,000+ paying customers), Mobbin
  (200k-user Firebase migration, third-party corroborated), Shotgun, Quilia. (Verified 3-0;
  case-study percentages are vendor numbers.)

This proves the two propositions Substrat rests on — DB/runtime-enforced tenancy as a
product spine, and companies building real businesses on a kernel-shaped foundation. The
delta is master-plan §4's point: RLS is builder-*configured* enforcement (the vibe-coding
foot-gun), not substrate-default enforcement, and Supabase is app-shaped (no nested B2B
tenancy, no engines, no compliance machinery).

### Frappe/ERPNext (unverified this pass)

Frappe's own framing — "everything is a DocType," schema defined via metadata without
code — puts it on the **platform side of the code-ownership test** despite being open
source and having a real app-on-framework story: domain schema lives in framework
metadata, not builder-owned migrations. The closest open-source analogue to
"engines on a kernel," but built on the metadata-driven model §5.5 rejects. Its upgrade
story vs OpenUpgrade remains an open question.

## 6. Not covered by verification (flagged, not established)

ServiceNow (the custom-table licensing guide and scoped-app upgrade pain), SharePoint /
Power Platform (list-view thresholds, Dataverse ISV tenancy), and the small open-source
kernels (Tryton, OFBiz, Moqui, Corteza) produced sources but no claims that survived the
verification cut. Master-plan §7.8's ServiceNow custom-table true-up point and the
SharePoint list-view scaling citation (kernel-design §7.5) stand on their earlier sourcing,
not on this pass. The category argument in §1 rests on the five verified platforms and
should not be read as exhaustive.

## 7. Synthesis: positioning and the lesson ledger

**Is Substrat an Odoo competitor?** No — different category, same *market gravity*. Odoo
is a single-org application platform implemented per customer by integrators; Substrat is
a foundation for builders who sell to *their* customers multi-tenant. They collide only in
the indirect sense that a vertical built on Substrat may compete with an integrator's
Odoo implementation for the same end customer (the §8.4 FSM case). "Kernel, not platform"
(decision 1) is not just architecture — it is the category boundary the evidence draws.

**Lessons already absorbed by the design** (incumbent scar tissue → existing decision):

| Incumbent scar | Substrat counterpart |
|---|---|
| SAP Z-code → clean core (sealed core, typed extension points) | Sealed engine schema + substates/custom fields (decision 26) |
| SAP Level D (write access to vendor tables = anti-pattern) | Engines own tables; verticals never touch them (§3, decision 6) |
| Odoo addon N×M dependency treadmill | Star topology, N kernel contracts (decision 19) |
| OpenUpgrade (community-outsourced migrations, chronically behind) | Migrations are first-class module code (§5.5) |
| Medusa module isolation + link tables | Opaque refs, engines never import siblings (§3) — independent convergence |
| Supabase RLS (runtime tenancy, but builder-configured) | Enforcement as substrate default, not configuration (§4) |
| Salesforce 2GP (authoring-only ownership, vendor tenancy) | AGPL + eject path; builder owns code *and* tenancy (§9) |

**Lessons not yet fully absorbed — the gaps this pass surfaces:**

1. **Upgrade execution as a kernel product obligation.** The single most documented failure
   across the org-shaped platforms is the upgrade treadmill, and the single most effective
   mechanism is Salesforce's push upgrades. Substrat's engines are semver'd modules with
   migrations-as-code, but *who runs an engine upgrade across every deployed vertical and
   scope, and what happens when a vertical's substates/custom fields sit on the migrated
   tables* is not yet pinned as a first-class kernel workflow. OpenUpgrade is the
   counterfactual: treat cross-version migration as someone else's problem and it becomes
   the ecosystem's defining pain. Candidate for the open-questions list / a kernel-design
   section.
2. **Plan for pressure on the seal.** SAP's 2025 concession shows even the right sealing
   rule gets renegotiated when real installed bases hit it. Decision 26's extension surface
   is the pressure valve; the discipline is answering future "one more hook" demands by
   *extending the manifest vocabulary* (as with substates), never by granting schema
   exceptions.
3. **The novel surface has no precedent to copy.** Nested B2B tenancy as first-class,
   typed/indexed custom fields on sealed engines, and agent-first authoring appear in no
   verified incumbent. Where the design absorbs incumbents' lessons it stands on their
   scar tissue; here it stands on its own reasoning — these are the components where
   contract tests and the reference verticals carry the proof burden alone.

**Open questions from this pass** (beyond master-plan §11): named companies running real
multi-tenant vertical SaaS on self-hosted Odoo and their actual upgrade cadence; whether
the Medusa-style kernel pattern is proven outside e-commerce; Frappe's DocType model and
upgrade story as the nearest open-source contrast; ServiceNow/Power Platform failure modes
under verification.
