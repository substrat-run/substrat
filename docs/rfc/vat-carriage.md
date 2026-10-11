---
status: proposed
layer: kernel
description: Concept spec for VAT carriage in engine-invoicing (#326) — a rate and a tax amount on a line, a per-rate decomposition frozen at export. Argued against the currency work that already shipped and against K-39; recommends per-line carriage and leaves the replace-or-additive question to a human.
---

# RFC: VAT carriage in `engine-invoicing`

**Status: proposed. Nothing here is agreed.** It is the concept spec that
[`strategy/commerce-gaps.md`](../strategy/commerce-gaps.md) §6.2 item 6 asks for *"reviewed
before code"*, requested by [#326](https://github.com/substrat-run/substrat/issues/326). It
recommends; a human decides. The decisions it asks for are collected in §9.

**This is not legal or tax advice, and the engine it describes would not give any.** Every
rate in this document is an *illustrative input a producer supplies*, never a rule the
engine knows. The only statements about what a legal invoice contains are the ones
[`commerce-gaps.md`](../strategy/commerce-gaps.md) §4.1 already makes.

Written against `origin/main` at `f2683d45d`. File and line references are to that tree.

---

## 1. The need, as the issue states it

#326 is filed by the author of a third consumer — a coworking-style vertical, a multi-operator
product — and describes itself as a use case, not a bug. It adds one data point to
[`commerce-gaps.md`](../strategy/commerce-gaps.md) §4.1, which already concluded that VAT
*carriage* (as distinct from *determination*) belongs in the engine because two consumers in
two domains (`workorder.completed`, `commerce.order-placed`) both bill customers who owe VAT.

What the third consumer adds:

| Stream (as the issue lists it) | Event | Illustrative rate |
|---|---|---|
| Recurring fee | `commerce.order-placed` | 25% |
| Usage overage | `commerce.order-placed` | 25% |
| An upsell on a booking | `commerce.order-placed` | 12% |

1. **Several rates on one document.** The engine appends deliveries for one customer to the
   *one open* underlag (find-or-create, `engines/invoicing/src/index.ts:457`), so a single
   document holds lines at different rates. A document-level rate cannot describe it.
2. **The basis is shown to the end customer**, not only handed to an accounting system. A
   basis that cannot say how its total splits is a weak answer to "why am I billed this".
3. **Accrual.** Lines land on the open basis over weeks and freeze at export. A split derived
   at export time would have to re-derive a rate for lines written long before, under
   possibly changed configuration. Writing the rate **on the line, when the line is written**,
   is the only version that stays correct across a rate change.

The issue explicitly does **not** ask for determination, rate tables, OSS or reverse-charge
logic. This spec keeps that line.

## 2. What the engine carries today

| Layer | What exists | Where |
|---|---|---|
| Line columns | `qty`, `unit`, `unit_price_amount`, `currency`, `line_total_amount` (+ provenance) | migration `0002`, `index.ts:185-200` |
| Producer input | `billable[]` with `unitPrice: Money`, `lineTotal: Money` — three separate Zod views, one per consumed event, none importing a producer | `index.ts:218-280` |
| Total | summed with `addMoney` on read; it throws on mixed currencies | `index.ts:365-400` |
| Currency | per **line**; `assertSingleCurrency` refuses a mixed delivery at write time (`currency_mismatch`); `declaredCurrency` on `invoicing/export` labels an *empty* basis's zero (#967) | `index.ts:386-400`, `:418-436`, `operations.ts` |
| Read shapes | `underlagDetail = { underlag, lines, total: string }`; `underlagListRow` adds `total: string` | `schemas.ts` |
| Emitted events | `invoicing.underlag-updated` **v1** `{ underlagId, addedLines, source }`; `invoicing.underlag-exported` **v2** `{ underlagId, number, total: Money }` | `events.ts` |

`grep -i vat engines/invoicing/src` returns nothing. A producer that knows a line's rate has
nowhere to put it: the consumers' Zod views would **strip** an unknown `vatRate` key
(Zod objects drop unknown keys by default), so today it would vanish silently rather than
fail.

**What is missing, precisely:** (a) a rate and a tax amount on a *delivered* line; (b) the
same on a *stored* line; (c) a per-rate decomposition of the document; (d) that
decomposition on the export event, the artifact an accounting hand-off reads; (e) the
guarantee that (d) cannot change after export.

(e) is nearly free: every write path already checks `status`, and there is no in-scope
export, so an exported basis is unreachable for writes
([`engines/invoicing.md`](../engines/invoicing.md) §4). Carrying the rate *in the rows* means
the existing invariant covers it with no new code path.

### 2.1 What the shipped currency work changes about the argument

[`commerce-gaps.md`](../strategy/commerce-gaps.md) §4.1 and the issue's fourth acceptance
criterion say VAT and currency *"touch the same total"* and should be **sequenced together**.
That can no longer happen: currency shipped alone — currency on every line, the
single-currency guard, `declaredCurrency`, and the v2 bump of the export event to
`total: Money`. The argument has to be re-made against a total that already has a currency:

- **VAT is now additive over a shipped shape**, not co-designed with it. That is a cost
  (a second payload change on the export event) and also a simplification: the tax amount
  inherits a currency discipline that already exists and is already tested.
- **The "same total" concern survives in a narrower form**: a tax amount in a different
  currency from its line would be a new way to build a mixed-currency document. §6 closes it.
- **Hoisting currency onto the underlag row**, which the engine's own comments call the
  honest fix for the empty-basis zero, is *independent* of this work, but any migration here
  should not make it harder (§5.3).

## 3. Options

Three shapes, all inside the same split: **carriage** (the line *has* a rate; the document
*decomposes*) is the engine's business; **determination** (which rate applies) is not.

### Option A — rate and tax amount on each line; breakdown derived

Each line optionally carries `vat_rate` (a decimal string, e.g. `"25"` or `"0"`) and
`vat_amount` (a decimal string in the line's currency). The producer supplies the **rate**;
the engine computes the **amount** from the line total — or accepts the producer's amount, see
§9 Q3. The per-rate breakdown `[{ rate, net, tax }]` is *computed* from the lines, on read
and at export, and the export event carries it.

- ✅ The rate is frozen **with the line**, which is exactly the accrual argument in §1.3.
- ✅ Immutability needs nothing new (§2).
- ✅ The breakdown is derived, so it cannot disagree with the lines.
- ❌ Every producer payload grows a field; three consumers' Zod views change.
- ❌ Rounding has to be decided somewhere (§9 Q2).

### Option B — a tax-breakdown object on the document only

The producer sends (or the engine stores) a per-rate breakdown, not a per-line rate.

- ✅ Smaller change to the stored shape for a producer that already computes totals per rate.
- ❌ A delivery covers *part* of a document; the document's breakdown is the *sum* of several
  deliveries'. B therefore either stores one breakdown row per delivery and sums them — which
  is A with a coarser grain — or gives up the accrual property.
- ❌ A line item with no rate in its own row cannot be explained to the end customer (§1.2).
- ❌ A stored breakdown can disagree with the lines it summarises; A's derived one cannot.

### Option C — leave carriage to the vertical, with a declared extension point

This is a real position, not a strawman, and the platform's own rules favour it by default:
*"a vertical needing extra data on an engine entity adds its own side table keyed by the
engine's id — never a column upstream"* (CLAUDE.md, D-28). A vertical already consumes
`invoicing.underlag-updated` into a side table; it could store a rate per line there, compute
its own breakdown, and render it. A *declared extension point* (e.g. an opaque per-line
`attributes` bag the engine stores and republishes untouched) would make that tidier.

Its strengths:

- Zero change to a shipped engine surface; no K-39 replace; no migration; no new invariant.
- Respects that "reshaping" of tax can differ per vertical — some may need a tax *code*, an
  account, or a jurisdiction note, not only a rate.
- A vertical can ship today.

Why it is not recommended anyway:

- **The rate and the line id never meet inside the vertical.** A vertical can read the lines
  back through `invoicing/get`, which returns them with ids, so a side table keyed by line id
  is reachable without any banned read. The difficulty is correlation and ordering: the
  vertical knows the rate when it *emits* the delivery, but the engine mints the line id
  afterwards, in the consumer. `underlag-updated` carries `addedLines` (a count), not the
  line ids. So the vertical must wait for the event, call `invoicing/get`, and match its
  rates to lines by position or by `(document, article, description)` — a heuristic, with a
  window in which a line exists unrated — or keep a parallel record per emitted delivery. It
  works, and a careful vertical can make it correct; it is the engine's own state being
  re-joined from outside.
- **The invariant that matters is the engine's.** "An exported document's decomposition is
  frozen" is only true if the decomposition lives where immutability is enforced. A side table
  is writable by the vertical after export; the engine cannot promise otherwise.
- **The consumer of the export event cannot see a side table.** `underlag-exported` is the
  artifact an accounting hand-off reads. Under C it would carry a net total with no
  decomposition, and each consumer would have to be told to join a vertical's private table.
- **Three consumers need it.** One has asked (#326); the other two are inferred in
  `commerce-gaps.md` §4.1 from the fact that both bill customers who owe VAT. On that
  evidence C is paid for once per vertical.

C remains the right answer for the parts of tax this spec leaves out (§7): a tax *code*,
exemption reason or jurisdiction note is exactly what an opaque, vertical-owned extension
point is for. **A and C are not exclusive**; A is the carriage, C is whatever else a vertical
needs beside it.

### Comparison

| | A per-line rate + amount | B document breakdown | C vertical side table |
|---|---|---|---|
| Rate frozen with the line | yes | no | only if the vertical does it |
| Breakdown can disagree with lines | no (derived) | yes | yes |
| Immutable after export, engine-enforced | yes | partly | no |
| On the export event for a connector | yes | yes | no |
| Engine payload / schema change | yes | yes | none |
| Producer changes | optional field | optional field | none |
| Cost to ship | highest | medium | lowest |

## 4. Recommendation

**Option A**, with the breakdown computed by the engine, and determination, rate tables and
tax codes out of scope. Concretely:

1. Producers may add `vatRate` (optional, decimal string) to each `billable[]` line in the
   three consumed events. Absent means **unspecified**, not zero (§5.2).
2. The engine stores `vat_rate` and `vat_amount` on `invoicing_lines`, both nullable.
3. `invoicing/get` returns them on each line and a `vatBreakdown` beside `total`.
4. `invoicing.underlag-exported` carries the breakdown.

**Costs, stated plainly:** one migration on `invoicing_lines` (a human checkpoint); three
consumers' Zod views; two read shapes; and the export event's payload change, which §5 shows
is the expensive part. The recommendation does **not** bundle any of the §7 items.

## 5. K-39 consequences

K-39 narrows D-28: *"until dispatch routes on `(type, schemaVersion)`, a payload change is a
REPLACE, and dual-emit is not an available option."* Consumer dispatch selects on type alone,
so emitting two versions would deliver both to the same consumer — for the export event, an
accounting hand-off, a double invoice. The precedent is the v2 bump of
`invoicing.underlag-exported` (`events.ts` header; `test/event-versions.test.ts`).

### 5.1 Which surfaces change

| Surface | Change | Kind |
|---|---|---|
| `commerce.order-placed`, `workorder.completed`, `timesheet.period-closed` (**producers' events**) | optional `vatRate` on each `billable[]` entry | additive field on an event invoicing does **not** own |
| `invoicing_lines` table | `vat_rate`, `vat_amount` nullable columns (migration `0003`) | schema is private (D-28); append-only migration, **human checkpoint** |
| `underlagLine` entity shape | two nullable fields | additive on a published read shape |
| `underlagDetail` | `vatBreakdown`, per-line fields | additive on a published read shape |
| `underlagListRow` | none required | — |
| `invoicing.underlag-updated` (v1) | none | unchanged |
| `invoicing.underlag-exported` (v2) | `vatBreakdown: [{ rate, net, tax }]`, and `total` possibly gross | **the K-39 question** |

The three producer events are owned by their producers; invoicing parses its own view of
each. An optional field there is a change to the *producer's* payload, made by the
producer, and invoicing tolerates its absence — the same tolerance the defensive parse
exists for (`events.ts` header).

### 5.2 The question this spec does not settle: is an additive optional field on the exported payload a replace?

Both readings are defensible, and the rule does not decide the case, so it is a decision
(§9 Q1). **Be clear about where the recorded positions stand:**
`commerce-gaps.md` §4.1 says VAT *"lands additively (new optional line fields,
`schemaVersion` bump on the emitted payload)"*, and #326's third criterion repeats it
(adding a *"dual-emit window"*, which K-39 has since made unavailable). The repo's own
earlier analysis therefore leans to a bump. Reading 1 below **departs from §4.1**; it is
presented because the case for it is real, not because the question is closed.

**Reading 1 — it is additive; no bump, no replace.**
D-28's text is: *"emitted payload fields frozen once shipped (`schemaVersion` bump +
dual-emit window for real changes)"*. The turn is on "real changes": a new field leaves every
existing field as it was. (CLAUDE.md paraphrases the same rule as *"rename/remove/retype means
a `schemaVersion` bump"*, which reads the same way; that wording is CLAUDE.md's, not D-28's.)
K-39 keeps the rest of D-28 *"untouched"*. The nearest recorded precedent is D-22's
export-schema diff (`tools/export-schema-diff.mts`, #1705): for an *exported vertical event*
it refuses a removed, retyped or newly-required field at an unchanged version and states that
*"a new export, or a new optional field, is additive"*. That is a different rule (vertical exports, not engine
events), but it is the closest statement of what the platform treats as breaking. A consumer
using Zod's default object parsing ignores the extra key; **no consumer in this repo parses
strictly** — a search for `.strict()` finds only a vertical's own input union
(`demos/ticket0/spec/model.ts`), not an event consumer, and invoicing's three consumed events
use plain `z.object`. A bump would impose a replace — a guaranteed dead-letter in every
consumer that was fine — to protect against a break that does not occur.

**Reading 2 — any payload change is a replace.**
K-39's text is *"a payload change is a REPLACE"*, not *"a breaking change"*, and both
`commerce-gaps.md` §4.1 and #326 ask for a `schemaVersion` bump. The reasoning is also not
about parsing alone: a consumer that ignores `vatBreakdown` and reads `total` is **silently
wrong** if `total` ever changes meaning (net vs gross, §5.4), and a consumer cannot tell a
payload that *has* the breakdown and chose to ignore it from one that lacks it. A version
number is the only machine-readable "this event now says more". Consumers outside this
repo may parse strictly; the repo cannot see them (the engines are on public npm).

**What each costs.**

| | Reading 1 (additive) | Reading 2 (replace → export v3) |
|---|---|---|
| Existing consumers | keep working, unaware of VAT | dead-letter until updated |
| Loud signal that the shape changed | none | yes, by design |
| Safe if `total` keeps its meaning | yes | yes |
| Safe if `total` changes meaning | **no** | yes |
| Precedent | D-22's diff calls a new optional field additive (vertical exports only); `commerce-gaps.md` §4.1 and #326 say bump | v2 (`total: Money`), which changed a field's type |
| Consumers today | none **in this repo** (`connectors/*` and `apps/*` do not read `underlag-exported`; `connections.md` §1 describes an accounting connector as unwritten). That says nothing about consumers outside it: the engine is on public npm | same |

**A bridge:** do Reading 1 *and* keep `total` meaning exactly what it means now (the **net**
sum), so nothing is silently wrong; add the breakdown alongside. That is only available if
`total` is not redefined, which §5.4 recommends. Under it, Reading 1 is safe; Reading 2 buys
only the version marker.

**Recommendation, weakly held, and a departure from §4.1:** Reading 1 with `total`
unchanged. Weigh the D-22 precedent and the absence of strict consumers in the repo against
§4.1, the issue, and consumers the repo cannot see. It is the human's call because it sets
a precedent for what K-39 means for every other engine.

**What would gate it.** There is no mechanical gate for an additive field on an *engine*
event. `lint:export-schemas` reads only a vertical's `model.json` exports. The engine's
guards are `invoicingEventVersions` and `test/event-versions.test.ts`, which pin the
*version* — they would fail on a bump to v3 (a deliberate edit of `SHIPPED`), and stay silent
on a new field. Reading 1 would be held by a test written for it, and a payload-shape check
for engine events does not exist.

### 5.3 Upcasting and old data

- **No upcast exists or is possible for the events.** A replace has no v1 emission to
  translate; consumers of the old shape fail loudly (K-39). An additive field needs none.
- **Stored rows:** migration `0003` adds the two columns `NULL`. Existing lines get `NULL`,
  **never an invented rate** — the same rule migration `0002` applied to per-line provenance
  (*"it was never captured, so it cannot be invented"*).
- **Rebuild-vs-ALTER:** `0002` rebuilt the table because a column became nullable. `0003`
  only adds nullable columns, so `ALTER TABLE … ADD COLUMN` suffices — no copy, and the
  journal's `RENAME TO` handling is not exercised.
- **Documents open at upgrade time:** an open underlag may mix pre-upgrade lines (`NULL`) and
  later lines (rated). The breakdown must say so (§5.5), not drop the `NULL` lines.
- **Already-exported documents** are immutable and keep their v2 event; there is no backfill,
  by the same invariant that makes them evidence.

### 5.4 Does `total` change meaning?

`total` is today the sum of line totals, and the engine does not know whether those are net
or gross. VAT carriage forces the question. **Recommended: `total` stays exactly the sum of
line totals, unchanged in value and in name**, and the breakdown states how the producer's
figures relate (§9 Q4). Redefining it is what would turn Reading 1 unsafe (§5.2).

### 5.5 Mixed rated and unrated lines at export

A basis can contain lines with no rate. The breakdown has a distinct bucket for them
(`rate: null`) rather than folding them into `0`. Whether export **refuses** a basis
containing unrated lines, **allows** it, or does so per vertical configuration is §9 Q5. The
current behaviour — an unrated basis exports — must remain available to a vertical that never
supplies a rate, or this is not additive.

## 6. Interaction with currency

- `vat_amount` is `Money` in the **line's** currency. It is not a separate currency field; the
  line's `currency` column covers both.
- `assertSingleCurrency` already inspects `unitPrice` and `lineTotal`; a producer-supplied
  tax `Money` joins the same set, so a tax in another currency is `currency_mismatch` at write
  time and dead-letters like any mixed delivery.
- The breakdown's `net` and `tax` per rate are sums over one currency, and reuse `addMoney`,
  which throws on a mismatch — defence in depth, as for `total`.
- `declaredCurrency` for an **empty** basis is unaffected; an empty breakdown is `[]`.
- Rounding: `mulDecimal` rounds half away from zero at the sixth decimal (it adds half a unit to the absolute value, so a negative line rounds symmetrically) (`packages/contracts/src/money.ts`).
  What that means for a *monetary* minor unit is a question about display and the
  accounting system, not something this spec asserts (§9 Q2).

## 7. Out of scope

Determination (which rate applies); rate tables; OSS, reverse charge and exemptions; a tax
*code*, account or exemption reason (the natural use of Option C's extension point); credit
notes (`commerce-gaps.md` §4.4 — and how a negative line interacts with a breakdown is a
question for that spec); per-shipment invoicing (§4.5); reconstructing rates for existing
rows; any connector that consumes the breakdown; platform billing, which is
[#39](https://github.com/substrat-run/substrat/issues/39), not this.

## 8. Phased plan

| Phase | What | Gate |
|---|---|---|
| 0 | This RFC; corrected note in `engines/invoicing.md` | human decision on §9 |
| 1 | Migration `0003` (nullable columns); optional `vatRate` in the three Zod views; lines store it; read shapes extended; tests: seam, `currency_mismatch` with tax, replay | **migration diff** checkpoint |
| 2 | `vatBreakdown` computed at read and at export; the export-event decision (§5.2); immutability test that an exported breakdown cannot move | human-chosen shape. No mechanical gate covers an engine event's payload (`lint:export-schemas` reads vertical `model.json` exports only): a bump is held by `invoicingEventVersions` and `test/event-versions.test.ts`; an additive field needs a new payload-shape test written in phase 2 |
| 3 | Producers: the shop demo and others supply `vatRate` from their own configuration; docs pages and the engines' published `events.md` | none |

Phases 1 and 2 can ship separately: phase 1 alone stores and shows rates with no change to any
emitted event.

## 9. Decisions asked of the human

1. **K-39 reading (§5.2).** Is an additive optional field on `invoicing.underlag-exported` a
   replace (export → v3) or not? This sets precedent beyond invoicing.
2. **Rounding (§6).** Round per line and sum, or round per rate on the sum? The two can differ
   by a minor unit on a long document. The repo's docs state no rule; the choice is
   the operator's to make and to document.
3. **Who computes the tax amount.** The engine derives it from the rate and the line total
   (one rule, no disagreement), or the producer supplies it (producers can follow a rule the
   engine does not know)?
4. **Net or gross (§5.4).** Is a producer's `lineTotal` net of tax? If a vertical's prices are
   tax-inclusive, the engine needs a flag or the vertical must convert. Recommended: net only,
   stated, with inclusive pricing left to the vertical.
5. **Unrated lines at export (§5.5).** Allow, refuse, or configurable?
6. **Whether to also offer Option C's extension point** for tax codes and exemption notes,
   separately from this work.
7. **Rate representation.** A percentage decimal string, as proposed, or a basis-point integer?
8. **Breakdown grouping key.** Group on the rate alone, or also on something a vertical may
   later supply (a tax code, §7)? Grouping on rate alone is what this spec assumes.
9. **`vatRate` validation.** What the engine accepts: range (is above 100 allowed?), scale,
   negatives, and whether `"0"` and *absent* are distinct at the schema level (this spec
   says they are: absent is *unspecified*, §5.2).
10. **Phase order.** May phase 1 (store and show rates; no change to any emitted event) ship
    **before** Q1 is decided? §8 says it can; this is the explicit ask.

## 10. Verification this spec relies on

Everything in §2 and §5.1 is read off the tree, not recalled: `engines/invoicing/src`
(`index.ts`, `events.ts`, `entities.ts`, `schemas.ts`, `operations.ts`), `packages/contracts/src/money.ts`,
[K-39](../decisions/K-039-payload-changes-are-loud-failure-replaces-until-dispatch-rou.md) and
[D-28](../decisions/D-028-engine-compatibility-surface-pinned.md). The claim that no code in
`connectors/` or `apps/` reads `invoicing.underlag-exported` is a search over those
directories on this commit. Phase 1 must prove its SQL against the real driver, not strings.
