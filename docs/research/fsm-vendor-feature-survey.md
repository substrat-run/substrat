---
status: historical
layer: plan
description: Feature survey of the Nordic FSM market, surveyed 2026-07-13.
---

# The FSM vendor — complete feature survey

Status: v1.0 · Surveyed: 2026-07-13 · Source: the vendor's public website (tool pages,
package matrix, add-on directory, integration directory, industry pages) **including
visual analysis of every product UI screenshot published there**.

> Anonymized per the master plan's convention: **the FSM vendor** = the incumbent
> field-service-software vendor (§8.1 bridge, §8.4 competitor/acquisition question).
> Company and product names, URLs, and staff names are deliberately omitted from this
> repo. Vendor facts: Gothenburg-based, 30+ years in business, ISO 27001:2022 certified,
> Swedish/Norwegian/English UI, single responsive web app ("no app required").
>
> Screenshot-evidence caveat: the marketing pages for the quality system, O&M manuals,
> and customer portal reuse byte-identical screenshots from other modules — those three
> modules' own UIs are not publicly shown.

## 1. The core object graph (synthesized from all screenshots)

Everything hangs off one spine, visible in every screen's top navigation
(Kunder · Anläggningar · Aggregat · Order · Offerter · Projekt · Avtal · Fasta besök ·
Leverantörsfakturor · Processer · Register · Inställningar):

```
Customer (kund, incl. avvikande fakturakund = deviating invoice recipient)
 └─ Facility (anläggning: geolocation, standing warnings/access notes, door codes)
     └─ Equipment unit (aggregat: serial no, placement, refrigerant, periodic-control flag)
         └─ Work order (the invoicing atom)
             ├─ Order lines (typed: material / resource-time / partial-invoice / UE-subcontractor;
             │   each with article ref, own+supplier art.no, technician, qty + correction,
             │   internal flag, per-line GL account)
             ├─ Protocols/checklists, documents (per-document public/not-public flag)
             ├─ Participants (technicians), category (color-coded: Akut/Service/Montage)
             └─ Customer invoices (Utkast → Godkänd)
```

**Order-generating containers** — three objects that spawn work orders:
- **Quote (offert)** → on approval auto-creates an Order, Project, *or* Contract,
  per the estimate template's rules.
- **Project (projekt)** → holds many orders (incl. ÄTA orders with separate economics).
- **Contract (avtal)** → generates recurring-visit orders (fasta besök) per its rules.

**Status vocabularies observed in the UI:**
- Work order: `Planerad → Aktiv → Åtgärdad → Attesterad` (+ `Kvittera` sign-off action;
  mobile `Acceptera` for technician job acceptance)
- Customer invoice: `Utkast → Godkänd`
- Supplier invoice: `Mottagen → Utredning → Under attest → Godkänd / Avslagen`
- Quote: `Förfrågan → Skickad / Kostnadsförslag → Godkänd / Avslagen / Ersatt`
- Contract: `Godkänt / Icke godkänt / Uppsagt`

## 2. Tool-by-tool

### 2.1 Work orders (arbetsorder) — the center of the product

"The work order is the document you use for your invoicing." All time and cost
consolidate here; it doubles as payroll basis.

- Order detail: left master-data panel (customer, work site w/ move action, responsible
  technician, contact, start/end date+time, PO number/märkning, fakturatyp, category)
  + tabs Översikt/Rader; actions Skicka, Kvittera.
- Facility-level **standing alerts** surface on every order ("dog on premises",
  "door code 2295, key in reception") — editable, persistent site notes.
- Three text areas with **Snabbtext** (quick-text snippets): arbetsbeskrivning, utfört
  arbete, interna anteckningar (internal, hidden from customer).
- Line grid: filters Alla/Material/Resurser/Delfaktura; quantities with corrections
  ("8 (+2) tim"); per-line GL accounts (konto 3051/3048/3120); internal-only flag;
  supplier + own article numbers; external-subcontractor (UE) lines.
- Line import directly from wholesaler (grossist EDI) or supplier invoice.
- **Documentation types** control which artifacts (servicerapport, leverantörsfaktura,
  protocols) accompany the fakturaunderlag exported to accounting — "konterat och klart".
- Partial invoicing (delfakturering) with account plan; live TB/TG (contribution
  margin/ratio) per order.
- Flexible pricing per invoice recipient: netto+påslag / brutto−rabatt / eget pris.
- Mobile: technician **accepts** assignment, tabs Översikt/Protokoll/Rader, add
  aggregat/utrustning/deltagare, per-document "Ej publik" badge.
- **Map view**: orders, facilities, vehicles, POIs on one map; cluster pins; filial
  selector; "Följ position" live GPS.

Entities implied: everything in §1 plus Article register (own vs supplier numbering),
Vehicle (GPS), Filial scoping.

### 2.2 Time reporting (tidrapportering)

- Hours reported on the work order from the field; photos/documents/drawings inline.
- **Time clock (stämpelklocka)**: all time classed billable (debiteringstid) vs internal
  (interntid); flows to payroll system automatically.
- Office matrix view: employees × days, cells "8 (2)" = worked (deviation) hours,
  color-coded approval states, Löneunderlag (payroll-basis) filter, day/week/2w/month.
- Technician self-service balances: **kompsaldo, flexsaldo, övertid** per month + total.
- Debiteringsgrad (billing rate) per employee; attendance/absence statistics.
- Mileage log (körjournal): odometer entry tied to the work order.
- **Personalliggare**: PL-nummer on project + linked order; UE companies with their
  employees in the same project; audit extract as XML/PDF (Skatteverket inspections).
- Unassigned-job pickup from mobile.

### 2.3 Scheduling (schemaläggning)

- Dispatch board: resources × timeline (day→month zoom), drag-and-drop.
- **Job queue (jobbkö)** — 59 unplanned orders in the sidebar sorted by start date,
  fed by contracts ("Periodisk läckagekontroll enligt avtal … besök 2 av N").
- Resources = people (role subtitles: kyltekniker, lärling, admin) **and equipment**
  (drill rig, refrigeration container, truck w/ trailer) **and rental objects**
  (hyresobjekt with rental-cost orders).
- Absence events as first-class bars: semester, sjuk, VAB, föräldraledig, kurs.
- Staff groups (personalgrupper) filter the board; categories color-coded.
- Same map view for geo-dispatch (vehicles vs jobs vs facilities).

### 2.4 Automatic pricing (automatisk prissättning)

**Prisbild** (price picture) is a first-class object attached to customer/contract:

- Header: number, name, category, optional **supplier scope**, flags: "derive labor
  price from employee's wage type (löneart)", "use net price", audit trail, and a
  **"Testa artikelpris"** simulator.
- Explicit price lines: article, unit, purchase price → sales price, markup %,
  discount %, **minimum billable quantity** (e.g. labor min 1.5 h), internal flag
  (restid non-billable), **mandatory action-code flag** (every reported hour must carry
  an åtgärd), check-in-compatible flag. Examples: labor 400→515 kr/h, electrician
  450→500, service van fixed + per-km, refrigerant R407C 800→1150 kr/kg,
  congestion-toll pass-through, UE pass-through.
- **Cascading price rules** below the lines: scope selector (varugrupp / supplier type /
  line type / article) × price basis (purchase vs sales) × discount/markup %. Examples:
  fee product-group exempt from discount; refrigerant group 2%; "Leverantörstyp UE" →
  inköpspris +10%; fallback rules per line type. Specificity cascade: article line >
  group rule > type default.
- Price sources: supplier-invoice lines, wholesaler EDI lines, manual entry. The two
  standard Swedish grossist models (netto vs brutto-lista) both supported.

### 2.5 Project management (projekthantering)

- Project list: forecast cost vs actual, price, invoiced (progress donuts), performed vs
  remaining hours (negatives shown), **TG%** per project, project types (Entreprenad,
  Samlingsprojekt–Service, Privat). Project numbers reusable per filial.
- Project detail: tabs **Översikt / Planering / Ekonomi / Karta**; master data incl.
  linked originating quote, payment model (fast pris / löpande / betalplan),
  resultatenhet + kostnadsbärare (accounting dimensions), filial.
- Economy: donut + matrix of Intäkt/Kostnad/Timmar/TB/TB-per-tim across
  **Beräknat / Prognos / Utfall / Avvikelse**; forecast snapshots with change history.
- **ÄTA** as first-class: convert an order to ÄTA *in the field*, or quote-then-order
  from the project; ÄTA economics reported separately (footer totals: ej fakturerat ÄTA,
  fakturerat ÄTA, kostnad ÄTA, TB ÄTA).
- Purchasing from the project (beställningsunderlag to suppliers); personalliggare via
  PL-nummer; Gantt view over years with rich filtering; **Karta tab plots drill holes /
  work geographically** (Azure Maps basemap, pin/line/polygon drawing tools).

### 2.6 Estimates & quotes (kalkyl och offert)

- **Kalkylmallar** (estimate templates) carry the rules: which articles are pre-selected,
  which quote texts attach, and **what an approval creates** (order / project /
  contract). Excel import supported; output as Word and HTML.
- Quote list: status pipeline, **probability scoring (0–3 flames)**, link column showing
  the object created on approval, template types incl. Norwegian variants and
  ROT-with-schablon for private persons.
- Quote detail: header sections (rubriker) rolling up hours/cost/markup/price;
  line items with internal flags; totals with TB, TB/tim, TG, moms; three rich-text
  blocks (offerttext, ordertext, villkorstext) with **merge fields (mallvärde)**;
  validity period; sent/approved/rejected dates.

### 2.7 Contracts (avtal)

- Contract types: **UA 2008, UA 2022** (industry standard agreements), Standard, custom
  with own text; **SKVP contract text bundled for KYL-certified companies**; contract
  emailed for signature from the system.
- **Index escalation (indexuppräkning)**: choice of index and index value per invoicing
  occasion, automatic escalation, custom start month, deviating handling, per-line
  index participation (Prisindex checkbox per contract line), option to print index on
  the invoice. List shows Avtalsvärde / Indexvärde / **Aktuellt värde** per contract.
- Contract detail ties together four tables: lines (with covered **aggregat**), covered
  equipment (serial, placement, periodic-control flag + count), **fasta besök**
  (recurring visits with next date), and the orders generated under the contract.
- Invoice bases generated in bulk up to a date or one-by-one; **förskott vs efterskott**
  (invoice before or after the visit); periodization; invoicing history per contract.
- A contract can span multiple facilities or have none.

### 2.8 Inventory (lager)

- **Unlimited warehouse locations; a lagerställe can be a service vehicle** — down to
  bin level ("Bagaget" = the trunk, "Gång B" = aisle B).
- Article card: dual own/supplier article numbers (+ barcode), type, unit, supplier,
  sales/list/purchase price, markup, discount, category.
- Per warehouse: reorder point, order quantity, available, **reservations**, balance.
- Transaction ledger per article: typed (orderrad / inventering / korrigering /
  transfer), ±qty, price, **physical vs economic balance**, user-attributed notes.
- Purchase orders: for stock, order, or project; sent to supplier from the system;
  **goods receipt with partial-delivery tracking** (inleverans events); auto-flagging
  at reorder point with suggested quantities.
- Technicians take/return articles on work orders from any location incl. their van.
- Stocktaking in-app or export→update→re-import.

### 2.9 Supplier invoices (leverantörsfaktura) — priced as a payment service

- **Invoice interpretation** (fakturatolkning): Peppol e-invoice, email, or paper;
  vouchers created directly, no duplicate entry.
- Five-state pipeline with workflow filter tabs: Mina / Mottagna / Utredning /
  Under attest / Alla; statuses Mottagen → Utredning → Under attest → Godkänd/Avslagen.
- List shows three-way linkage: invoice → work order (with the order's own status
  inline) → facility; also non-facility targets (an employee, "Omkostnader"/overheads);
  credit-note and **reverse-charge VAT (omvänd moms)** flags; multi-currency code.
- **Rule-based attest routing** to responsible technician / arbetsledare /
  projektledare; **mobile attestation** with approve/forward/reject against the embedded
  original PDF, comment threads between attestants.
- Konteringsmallar auto-code recurring purchases; **cost split by vehicle registration
  number** (fuel-card invoices → cost centers/orders per vehicle).
- Market-unique claim: **transfer article lines from supplier invoice directly onto the
  customer invoice** (re-billing without retyping).
- PO matching + warehouse receipt (with Lager module); auto-attachment of supplier
  invoices to projects — supports samverkansprojekt / öppen redovisning (open book).

### 2.10 Protocols & checklists (protokoll och checklistor)

- **Template editor**: typed checkpoints (heading / check / note / value), per-template
  flags (auto-create, hide N/A points, two-column, collapsible, applies-to facility or
  aggregat, fill-before-order-starts, use signature) and — critical —
  **"Obligatorisk för status"**: checklist completion gates order status transitions.
- Attachment targets: work order, facility, system, equipment unit, or recurring-visit
  series (so contract-agreed moments always execute).
- Mobile filling: progress counter (7/8), per-checkpoint assessment dropdown, note,
  **photo attachment, and a "Skapa aktivitet" button** spawning a follow-up task from a
  checkpoint.
- Customer-facing PDF protocol with the Swedish assessment scale
  **X=OK · 1=bör åtgärdas · 2=skall åtgärdas · A=klart · −=ej relevant**, technician,
  facility/property designation, and on-glass digital signature.
- "Not OK" items aggregate into **åtgärdslistor** (action lists) → one click generates a
  remedial order or quote.
- Ready templates per trade: F-gas registerföring, OVK, luftflödesprotokoll,
  borrprotokoll (SGU), egenkontroll, igångkörningsprotokoll, riskanalys.

### 2.11 Quality system (module "MAKCI")

- Quality/company manuals with **auto-updating sections from live registers** (employee
  register, equipment lists, training plans).
- ISO 9001 (58 requirements / 8 principles) and ISO 14001 templates; SWEDAC
  accreditation templates; screenshots reveal manual types incl. per-project quality
  plans, ISO/IEC 17020 pressurization accreditation, AFS 2001:1 work-environment,
  risk analysis per AFS.
- Deviation management: internal control reports, deviations tracked against objectives.
- One shared "Manualer" registry keyed to customer + facility with type taxonomy
  (Företagsmanual / Projektmanual / Kvalitetsmanual).

### 2.12 O&M manuals (drift- och skötselmanualer / DU-instruktioner)

- Templates per trade (kyl, VVS, ventilation); own reusable templates.
- Classic Swedish handover-binder structure: **pärmregister with 15 or 20 tabs**.
- Auto-population of facility data from the suite; delivery digital, print, or USB.
- Add-on includes a basic **drawing program with industry symbols**.

### 2.13 Customer portal ("KundOnline")

- Customer login: **fault reports (felanmälan) become work orders**; customers create
  orders, follow work status, access shared protocols/checklists/projects/documents.
- **Role-based permission matrix** — admin controls exactly which object types each
  portal user sees (fault reports, feedback, protocols).
- **Shared facility/equipment register** so company and customer name the same assets
  identically — cited as improving billing accuracy.
- Internal/external visibility flags exist down to order-line and document level
  ("Intern" checkbox, "Ej publik" badge).

## 3. Packages and pricing structure

Three tiers + one module; **no public pricing anywhere** ("pris på förfrågan");
counter-positioning: no startup fee, no hidden fees, free onboarding and support.

| Feature | Grund | Standard | Komplett |
|---|---|---|---|
| Customer register + facilities, aggregat/system + components | ✓ | ✓ | ✓ |
| Work orders (service + recurring visits), customer history | ✓ | ✓ | ✓ |
| Checklists/protocols, planning calendar | ✓ | ✓ | ✓ |
| Hazardous-waste registration (farligt avfall) | ✓ | ✓ | ✓ |
| sv/no/en languages, support | ✓ | ✓ | ✓ |
| Time & material reporting, statistics, TB/TG | ✓ | ✓ | ✓ |
| Gross+net prices, prisbilder with price rules, partial invoicing | ✓ | ✓ | ✓ |
| EDI, payroll export, fakturaunderlag export, SGU, waste-to-EPA, Outlook, körjournal, custom integrations | ✓ | ✓ | ✓ |
| Contract mgmt with index; contract value + result | – | ✓ | ✓ |
| Inventory; inventory value | – | ✓ | ✓ |
| Projects: kalkyl+offert, real-time accounting, samverkan, ÄTA, betalplan w/ retained funds, prognoser, SVA, personalliggare | – | – | ✓ |

**Filial** (multi-branch: share customers, facilities, systems, orders across branches)
is a **separately quoted module**, not a tier — the same "nested tenancy sold as add-on"
pattern the master plan notes (§5.1).

Structural read: compliance (SGU, EPA waste, protocols) is in the *cheapest* tier —
compliance is table stakes, not upsell; project economics is the premium differentiator.

## 4. Add-on modules (all quote-priced)

| Module | What it does |
|---|---|
| Kyla-/värmemodul | Complete F-gas documentation: registerföring basis, kontrollrapporter, auto-compiled årsrapport (köldmedierapportering), risk assessment before gas pressurization |
| Ventilationsmodul OVK | Digital OVK protocols for certified firms + property/system/spare-part data |
| Borrmodul | Digital borrprotokoll, **direct submission to SGU Brunnsarkivet** from mobile |
| Skrivarmodul | Meter-reading (räkneverk) contract billing for print volumes; readings via 3manager or email template |
| Kundportal | As §2.13 |
| Kvalitetssystem MAKCI | As §2.11 |
| DU-Instruktioner | As §2.12 + drawing program |
| Riskbedömning | Developed with Kylentreprenörernas förening; risk analysis per AFS/PED, inspection checklists (fortlöpande tillsyn) |
| Tryckavsäkring | Pressure-relief calculation per "faktablad 10 v2" |

**Payment services** (transaction-priced): BankID signing (quotes/contracts/documents) ·
company lookup (bolagssök) · person lookup (privatsök) · supplier-invoice interpretation
(Peppol/email/paper) · SMS to technicians and customers.

## 5. Integration directory

- **Accounting — 27 systems**: Fortnox, Visma (Administration/Spiris/.Net/Mamut/
  Business/Business NXT/Global), Hogia, BL, Pyramid, SAP Business One, Microsoft
  Dynamics BC, 24SevenOffice, Unit4/Agresso, Briljant, Duett, Cordel, Monitor, Winbas,
  Symbrio, @work + heavy Norwegian coverage (PowerOffice GO, Tripletex, Xledger,
  UniMicro, Uni Økonomi). Direction: export customers/projects/fakturaunderlag,
  sometimes articles/payroll.
- **Payroll — 12**: Agda, Visma Lön variants, Hogia Lön, Kontek, Flex, Huldt & Lillevik
  + **PAXML** as the standard payroll-basis format (covers anything PAXML-compatible).
- **Authority reporting**: SGU Brunnsarkiv (drill protocols), Naturvårdsverket waste
  register.
- **Vehicle GPS — 6**: Abax, Automile, TelliQ, ViaTracks, Postrack, Tracksys (positions
  on the map, trip import to orders).
- **Other**: Rackbeat (stock sync), OneFlow (e-sign), 3Manager (printer meters),
  Microsoft Entra (SSO, on request), Outlook 365 (import fault reports from a mailbox),
  Zendesk, Creditsafe, Geposit.
- Wholesaler EDI is marketed via the pricing/work-order features (netto/brutto price
  files); individual grossist names are not published in the directory.

## 6. Industry verticals and their compliance anchors

| Industry | Compliance anchor | Distinctive features |
|---|---|---|
| Kyla (refrigeration) | **F-gas regulation**: on-site fill/drain registration at the machine, auto registerföring + kontrollrapport + årsrapport; periodic leakage-control orders generated from contracts | SKVP partnership "since 1989"; SKVP contract text; refrigerant articles/varugrupp; risk-assessment module w/ Kylentreprenörernas förening |
| Ventilation | **OVK** (statutory inspection) protocols | Air-flow protocols; property/system data access |
| El (electrical) | **Egenkontroll** + riskbedömning per elsäkerhet practice | Two shipped templates ("Mindre arbeten", "Kontroll efter utförande"); checklists mandatory before/after work or signature-gated; supplier-invoice→order material tie w/ auto-move of unused material to stock |
| Borr (drilling) | **SGU Brunnsarkivet** direct protocol submission | Meters-drilled + material on site; drill rigs as scheduled assets; drill holes plotted on project map |
| Skrivare (printers) | — | Meter-reading contract billing |
| Larm/säkerhet | — | (portal + protocols emphasized) |
| All | Farligt avfall → Naturvårdsverket; personalliggare (PL-nummer, XML/PDF audit export) | |

## 7. Cross-cutting product observations

1. **One integrated web app** — every module is a view over one data model (same nav,
   same patterns). Responsive; explicitly no native app; usable mid-job on any device.
2. **UI pattern language**: left master-data panel + tabbed detail + related-entity
   tables; saved list filters with live counts; column-settings gears; color-coded
   status icons and category dots; donut progress indicators; "Skicka" (send/email) on
   every major object; quick-text snippets; per-object audit fields.
3. **Compliance-as-moat**: every vertical is anchored on a statutory duty with a direct
   authority integration, several included in the cheapest tier; association
   co-development (SKVP, Kylentreprenörerna, SOEL) provides template content and trust.
4. **Economics runs through everything**: TB/TG on order, quote, project, and contract;
   forecast-vs-actual with deviation; per-line GL accounts; the work order *is* the
   fakturaunderlag. Positioning: no own accounting/payroll — "konterat och klart" export.
5. **Internal/external visibility is pervasive**: internal flags on order lines, price
   lines, quote lines; "Ej publik" documents; internal notes fields — one data model
   serving office, field, and customer-portal audiences.
6. **Nordic scope**: Norwegian demo data, Norwegian accounting/payroll integrations,
   sv/no/en UI.
7. **No public pricing**; quote-based sales with "no hidden fees" counter-positioning.

## 8. Implications for Substrat (deltas against current design docs)

Findings that should feed back into [the demo concept](../../demos/callout/spec/concept.md) and
future engine designs:

1. **The asset hierarchy is deeper than the demo models**: Customer → Facility →
   Aggregat (with serial, placement, refrigerant, periodic-control metadata) is the
   spine *everything* attaches to — protocols, contracts, standing site notes, portal
   sharing. Confirms the plan's asset-hierarchy engine; the demo's work-order engine
   should bind orders to an `EntityRef` asset from day one.
2. **Avtal is an engine, not vertical logic**: contract → covered aggregat → fasta
   besök → auto-generated orders → invoice bases with index escalation is generic
   machinery across all their verticals (and maps to PropCo's serviceavtal too).
   Candidate `engine-agreement` (post-demo).
3. **Prisbild's shape validates "pricing hook is vertical"** only partially — the
   *cascade mechanism* (article > group > type defaults, min-qty, internal flags) is
   generic; the *content* is vertical. Worth revisiting where that line sits.
4. **Status-gating checklists** ("obligatorisk för status") is a first-class engine
   feature: protocol completion blocks order state transitions — an invariant the
   protocol engine owns and the work-order engine must expose a hook for. Star-topology
   test case: this coupling must work via events/refs, not imports.
5. **Internal/external visibility flags** (line-level, document-level) are a kernel
   concern — they're the permission model applied to *fields and rows*, needed by the
   customer portal. Cheap to include in attachment contracts now, ugly to retrofit.
6. **Their Filial add-on is our native tenancy** — multi-branch data sharing is a paid
   bolt-on for them and a §5.1 differentiator for us. Demo should show two filialer
   sharing customers effortlessly.
7. **Quantity corrections** ("8 (+2) tim") and five-state supplier-invoice attestation
   are concrete UX details worth stealing for the engines' data models (corrections as
   append-only deltas fits the event-sourced spine naturally).
