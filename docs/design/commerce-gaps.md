---
status: historical
layer: plan
description: Commerce capability gap walk, 2026-07-17. See NOTE in docs/README.md.
---

# Commerce capability gaps — a checklist walk

Status: **historical** — a gap walk dated 2026-07-17; decides nothing. **§6.1 is now out of date**: every engine has a test script and `packages/engine-test-kit` exists.

> **Relationship to canon.** Master plan §6 and the decision log rule; this document
> proposes, it doesn't decide. It exists because a richer storefront demo was floated as
> a way to surface requirements we don't handle. This walks that feature surface directly
> instead, against decision **27** (placement spectrum; *engines are extracted at the
> second vertical, never designed ahead*), decision **19** (star topology), decision
> **20** (invoicing is an engine at most; reskontra is a connector boundary) and master
> plan **§7.9** (accounting is integrate-never-rebuild).
>
> **The discipline this document must not break.** D-27 pins engine extraction to the
> second vertical *precisely because* engine reuse is the plan's least-proven hypothesis.
> A gap analysis is an almost irresistible invitation to design engines ahead of demand.
> Nothing below authorises a build. Where a capability plausibly ends up in an engine,
> the note says *which second vertical would force it* — and if that vertical does not
> exist, the answer is "not yet", not "roadmap".

## 1. Why not just adopt a storefront template

The proposal was Next.js Commerce (or similar) as a ready-made demo, on the theory that a
realistic shop surfaces requirements a thin skin hides. The instinct is right; the vehicle
is wrong on three counts.

1. **Its readiness is its coupling.** Next.js Commerce's data layer *is* the Shopify
   Storefront API. Rewiring it to Substrat rewrites the part that made it ready-made and
   keeps the CSS.
2. **The gaps aren't in the storefront.** Everything in §3 and §4 below was found by
   reading `demos/shop/src/module.ts` and `engines/invoicing/src/index.ts`. A prettier
   checkout surfaces none of it — the holes are in the module and engine layers.
3. **`demos/*` are deliberately thin.** Copy-and-own Vite skins, private, never
   published. The demo's job is to prove three theses (a zero-engine vertical is
   legitimate; `engine-invoicing` reuses across a domain boundary; no-oversell holds
   under concurrent checkout). None of them gets more true with better typography.

Polish, if wanted for the 15-minute demo, is a separate and much cheaper problem: a design
pass on the existing skin, no framework change.

## 2. Method

Each capability gets D-27's two tests, in D-27's own terms:

- **Guarantee-surface coupling** — must this data live inside the permission / audit /
  GDPR / reporting surface a vertical inherits rather than reimplements?
- **Reshaping need** — how much does each vertical need to reshape it?

High coupling + high reshaping + **shared invariants** + **a second vertical that already
needs it** → engine. High reshaping without shared invariants → vertical code or template.
No reshaping need → integrate. Per D-27, an engine is only the right form in the *middle*.

## 3. Defects, not gaps

These are wrong today, independent of any commerce roadmap. They are listed first because
a gap analysis should not bury live bugs under a wishlist.

### 3.1 `underlagTotal` sums across currencies and silently lies

`engines/invoicing/src/index.ts` stores `currency` **per line** and totals with
`addDecimal`, which ignores currency entirely:

```ts
.reduce((sum, r) => addDecimal(sum, r.line_total_amount), '0')
```

Contracts already ships the correct primitive — `addMoney` **throws** on currency
mismatch. The engine bypasses it. Two lines in different currencies on one underlag
produce a nonsense total, and `invoicing.underlag-exported` emits `total` as a bare string
with no currency at all. Multi-currency isn't unsupported here; it's *silently wrong*,
which is worse. Note the emitted field is frozen by D-28 — correcting `total` to a `money`
means a `schemaVersion` bump and a dual-emit window.

### 3.2 `onWorkOrderCompleted` is not idempotent

`onCommerceOrderPlaced` dedups explicitly on `source_id`. `onWorkOrderCompleted` does not
— it relies on find-or-create plus the kernel delivery journal. A redelivery duplicates
its lines. The two consumers in the same engine disagree about whether redelivery is
possible, and only one of them is right.

### 3.3 The docs promise guarantees the code doesn't have

`apps/docs/engines/invoicing.md` states that "find-or-create, the kernel's delivery
journal, and **a source-id guard** keep the handlers idempotent on redelivery" — describing
a guard only one of the two consumers has (§3.2). It also presents totals computed with
`addDecimal` as *the* sanctioned exactness guarantee, which is precisely the currency
defect (§3.1) offered as a feature.

This is worse than an undocumented bug. A published engine whose docs promise an
idempotency it lacks is a correctness claim we are actively making to users. The doc and
the code have to be fixed together, and the tests in §6.1 are what stop them drifting
apart again.

### 3.4 `cancelled` is a dead state

`demos/shop` declares `status IN ('placed','fulfilled','closed','cancelled')` in the
CHECK constraint and in the TypeScript union. **No operation ever sets it.** The state
machine has a state nothing can reach — the schema asserts a capability the module does
not have. Either build §4.3 or drop the state; a state machine that lies about its own
reachable set is worse than one that admits it's small.

## 4. The walk

| Capability | Coupling | Reshaping | Second vertical exists? | Placement |
| --- | --- | --- | --- | --- |
"Second vertical?" is only the gate for **extraction** (D-27). Where the engine already
exists, the column instead records whether the shared-invariant evidence is in.

| Capability | Coupling | Reshaping | Evidence it's shared | Placement |
| --- | --- | --- | --- | --- |
| VAT carriage (§4.1) | High | Low | **Yes — two consumers, shipped** | Engine, additively |
| VAT determination (§4.1) | Low | High | — | Integrate (§7.9) |
| Shipping address (§4.2) | **PII** | High | No | Vertical + open question |
| Cancellation (§4.3) | Low | High | No | Vertical code |
| Credit notes (§4.4) | High | Low | One domain only | Engine *when* forced |
| Partial fulfilment (§4.5) | Low | High | No | Vertical code |
| Subscriptions (§4.6) | High | Med | **None** | Not yet — do not design |
| Payments | — | — | — | **Already decided** (D-20) |

### 4.1 VAT — the one gap where D-27's gate is already met

There is **no VAT anywhere**: zero hits across the vertical, all three engines, and
contracts. (A grep for `vat` returns 12 false positives from *pri**vat**e*,
*deri**vat**ion*, *reser**vat**ion*.) A Swedish coffee retailer issuing a fakturaunderlag
with no VAT line is not a credible invoice, and the underlag is precisely the artifact
handed to Fortnox/Visma — which need per-line VAT to accept it.

The useful split, and the reason §7.9 doesn't settle this:

- **VAT determination** — *which* rate applies to this line, for this customer, in this
  jurisdiction (reverse charge, OSS, exemptions). Rules-heavy, jurisdictional, changes by
  legislation not by us. **Integrate.** §7.9 governs.
- **VAT carriage** — the underlag line *has* a rate, the document total *decomposes* into
  net + VAT per rate, and an exported document's decomposition is frozen with it. That's
  an invariant about what a legal invoice **is**, inherited by every vertical that bills.
  **Engine.**

A precision point, because it's easy to misapply D-27 here: invoicing is **already
extracted**, so the second-vertical rule — which governs *extraction* — isn't the gate for
this. The question is only whether VAT carriage is engine-shaped or vertical-specific, and
the evidence that it's shared rather than vertical vocabulary is that `engine-invoicing`
already has **two consumers in two domains** (`workorder.completed` and
`commerce.order-placed`) and *both* bill Swedish customers who owe VAT. Nothing here is
being designed ahead of demand; the demand is in the repo.

Under D-28 this lands additively (new optional line fields, `schemaVersion` bump on the
emitted payload). It interacts with §3.1 — fixing currency and adding VAT touch the same
total — which is an argument for sequencing them together rather than a reason to delay
either.

### 4.2 Shipping address — the PII question the kernel may not answer

Zero hits for address, shipping, postal, carrier, tracking. `fulfil-order` is a pure
status flip; "fulfilled" currently means *someone clicked a button*.

Reshaping is high (every vertical shapes addresses differently) which points at vertical
code — a side table keyed by the order id, per D-28's rule about never adding a column
upstream. But an address is **personal data**, and D-27's coupling test names GDPR
explicitly. That raises a question this document cannot answer from the docs:

> **Proposed open question.** Does the kernel offer an erasure/retention guarantee that
> vertical-owned PII in a vertical's own side table inherits? Events carry `piiClass`, but
> a `piiClass` on the event says nothing about the table. If erasure is a kernel
> guarantee, address data in a vertical side table may sit *outside* the guarantee surface
> that D-27's own test says it must sit inside — and every vertical storing a customer
> address re-implements erasure, which is the exact failure the test exists to prevent.

**Answered, and the answer is "not yet — so don't put the address there" (#37, D-45).** The
kernel now has an erasure primitive: `shredSubject` redacts every classified event keyed to
a data subject and destroys the key that seals those payloads inside every backup the
platform holds. It reaches the **spine**. It does not reach a vertical's own table, because
nothing classifies a table — which is exactly the gap this question named, now measured
rather than suspected.

So the reshaping argument above still points at vertical code, and the GDPR argument still
points away from it, and the tie is not broken yet. What breaks it is a declared
`onSubjectErased` hook the kernel calls inside the erasure, letting a module delete its own
rows for that subject under the platform's audit — deferred to its own issue because it is
a new module-facing contract and D-28 governs it from the first line. Until it exists, a
vertical storing a shipping address is holding personal data no kernel guarantee covers,
and §4.2's placement should be read as blocked on that hook rather than settled.

Carriers/rates/labels are a connector boundary and not in scope here.

### 4.3 Cancellation — cheap, and it exposes three real invariants

Vertical code: the shop owns its order state machine (D-26/D-27; nothing shared to reuse
yet). The value isn't the feature, it's what it forces us to answer.

**Trap 1 — the reservation ledger.** `checkout` decrements `on_hand` **and** flips the
cart to `placed` in one transaction, so the unit leaves the shelf and its reservation
stops counting together (`reservedNow` only counts lines on `status = 'open'` carts). That
is correct. But it means cancelling must *restock* — `on_hand + qty` — and only when the
goods didn't ship. Cancel-after-fulfil is therefore **not** the same operation as
cancel-before-fulfil, and no-oversell is exactly the invariant a careless restock breaks.

**Trap 2 — the exported underlag.** An exported underlag is immutable, enforced in the
engine. Cancelling an invoiced order therefore **cannot** edit the billing document. The
only correct move is a compensating document (§4.4). This is worth stating plainly: the
engine's immutability invariant is *already right*, and it forces the accounting-correct
answer before anyone reasons about it. That's the star topology working — the vertical
cannot fix this by reaching into invoicing's tables (R5), so it must go through an engine
surface that doesn't exist yet.

**Trap 3 — negative lines already mean something.** A first draft of this document called
negative lines an accidental hazard. That was wrong, and the correction is the more
interesting finding. Negative lines are **deliberate, shipped and documented**: `checkout`
pushes a `rabatt` line whose `unitPrice` and `lineTotal` are a negated `moneyOf`, so the
underlag total stays net; the scenario test asserts both lines; and `engine-invoicing`'s
own docs page describes the mechanism.

So the gap is not that negatives are possible. It is that **one representation now serves
two different meanings**, and nothing marks which is which:

- a **discount** — a reduction *within* the document being assembled;
- a **credit note** — a reversal *of a different, already-exported* document.

Export-immutability means a reversal can never land on the underlag it reverses (§4.4); it
would arrive as a negative line on a *new* underlag, structurally identical to a discount,
with no link column pointing at what it reverses. An auditor reading `invoicing_lines`
cannot tell a coffee discount from a €4,000 credit. That is a modelling gap, not a type
hole — and it argues the credit-note surface in §4.4 needs its own line semantics, not
just a sign.

### 4.4 Credit notes — engine-shaped, but not yet forced

A credit note has invoicing's own invariant (a document, immutable once issued, linked to
what it reverses). Coupling is high, reshaping low: the *shape* is shared, the vocabulary
isn't. That reads engine.

Per §4.3's trap 3, the surface is **not** "allow negative lines" — they are already
allowed and already mean *discount*. It is a distinct line semantic plus a link to the
reversed document, so the two are distinguishable in the table an accountant reads.

But per D-27 the gate is **not** met: only `demos/shop` would need it today. `workorder`
plausibly needs it second (a repair credited after invoicing) — and *that* is the moment
to extract, not before. Until then §4.3's cancel-after-export case stays explicitly
unsupported, which is an honest answer, and better than a speculative engine surface.

### 4.5 Partial fulfilment

`fulfil-order` is all-or-nothing. Real commerce ships partially, backorders the rest, and
invoices per shipment — which multiplies into §4.1 (VAT per shipment) and §4.4 (per-
shipment documents). Vertical code; low coupling; no shared invariant yet. Listed so the
demo stops implying we've thought about it.

### 4.6 Subscriptions — deliberately not analysed

Recurring billing is invariant-dense and would be tempting to call an engine. **Zero
verticals need it today.** D-27 is unambiguous: engines are extracted at the second
vertical, never designed ahead, because engine reuse is the least-proven hypothesis in the
plan. Designing a subscription engine off the back of a demo wishlist is the precise
failure mode D-27 exists to prevent. Recorded as a known absence; no further analysis
until a real vertical needs it.

## 5. What this says about the demo

The three theses `demos/shop` proves are all invariant claims, and every gap worth having
found is an invariant claim too. The template would have bought realistic *chrome* around
a module whose real holes are that a state is unreachable, a total silently mixes
currencies, a consumer isn't idempotent, and the docs promise a guard that isn't there.

If a richer feature surface is still wanted as a checklist, that's what §4 is. Mining it
was cheap; adopting it would not have been.

## 6. Suggested follow-ups

### 6.1 The precondition: engines have no tests

Discovered while scoping the §3 fixes, and it outranks everything else here.

`engines/{invoicing,workorder,protocol}` are **published packages** (`access: public`)
totalling ~1,715 lines of source with **zero dedicated tests**. None has a `test` script,
so the root `pnpm test` — which builds, then runs `test` in every workspace member — **skips engines
entirely**. They are exercised only as a side effect of the three demo scenarios, which
means:

- Engine invariants are asserted only through a seeded, multi-module, SQLite-backed world.
  A regression is caught only if a demo happens to walk that path.
- `underlagTotal` is never asserted directly — which is exactly how §3.1 survived.
- Demos run on SQLite only, so **the Cloudflare adapter has never executed an engine**.
- There is no engine analogue of `packages/contract-tests` — nothing asserts an engine
  behaves identically across adapters, which is the very guarantee D-14 buys for hosts.

Fixing §3.1 and §3.2 without a test target means fixing them blind and hoping a demo
notices the regression later. So the order is: **test target first, then the fixes, then
the docs.**

### 6.2 Order

Ordered by "is this a lie we're currently telling", not by size:

1. **Give engines a test target** (§6.1) — per-engine `test` script + a kernel-backed
   fixture so `pnpm test` reaches engine code directly rather than by demo side effect.
2. **Pin current correct behaviour, then fix §3.1** (currency) and **§3.2**
   (idempotency) — red tests first, so the fix is demonstrated rather than asserted.
   Note §3.1's emitted `total` field is frozen by D-28: correcting it to a `money` is a
   `schemaVersion` bump and a dual-emit window, and that part is a **human decision**, not
   a refactor.
3. **Fix §3.3** — the docs and the code together, in the same change as (2).
4. **Resolve §3.4** — build cancel (§4.3) or drop the state. Not both.
5. **Log the §4.2 open question** against kernel-design (PII erasure vs vertical side
   tables). It's the only finding here that might bear on the *kernel*.
6. **VAT carriage (§4.1)** — wants its own concept spec in the shape of
   `engine-protocol.md`, reviewed before code.
7. Everything else: **record and wait for a second vertical.**
