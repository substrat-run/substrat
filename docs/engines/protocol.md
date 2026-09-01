---
status: built
layer: kernel
description: Protocol and checklist engine. OQ11 decided and logged as K-38.
---

# `engine-protocol` — protocols, checklists and the sign-freezes invariant

Status: **built** — the engine ships on npm; OQ11 decided (§6), its log entry still unratified

> **Relationship to canon.** Master plan §5/§6 and the decision log rule; this document
> proposes, it doesn't decide. It exists to be reviewed against decisions 26 (engine
> extension model), 27 (placement spectrum, extraction discipline) and to set up the
> resolution of kernel-design **open question 11** (cross-engine transition guards),
> which is explicitly "decide when the protocol engine lands."

## 1. What this is

Protocols/checklists with the sign → immutable invariant: egenkontroller, installation
protocols, service checklists — the FSM vendor's core compliance artifact (demo concept
§4). A protocol **template** defines sections and items (checkboxes, values,
measurements, free text, photo refs); an **instance** binds a template to an entity
(`workorder`, later anything); technicians **fill** it; a **signature** freezes it
forever. Content — which templates exist, what they contain, branschprotokoll packs —
is 100% vertical-owned. The engine owns only the invariants.

## 2. Placement (decision 27) and the extraction discipline

Placement tests, applied:

- **Guarantee-surface coupling**: signed-immutability, append-only fill history, and
  the audit trail are compliance-grade guarantees a vertical must inherit, not
  reimplement — too much guarantee surface for a template.
- **Reshaping need**: every vertical reshapes content (templates, vocabulary, which
  protocols are mandatory when) — too much reshaping for an integration.

Middle of the spectrum → engine form is right, **but decision 27 forbids designing it
ahead**: engines are extracted at the second vertical. So the build order is the
discipline, rehearsed at demo scale:

1. **Milestone A — Callout vertical code.** Protocol tables, fill flow, in-app sign,
   immutability enforcement live in `demos/callout/src` as vertical operations. No new
   package. The FSM demo gains its egenkontroll beat.
2. **Milestone B — the second shape forces extraction.** Handlebar needs a service
   checklist with a different shape (per-bike condition report; customer counter-sign
   at pickup). Extract `engines/protocol`: invariants move to the engine, both
   verticals' templates stay behind as content. The extraction diff is the proof the
   plan's least-proven hypothesis wants (§3), at rehearsal scale.
3. **Milestone C — the guard.** With two verticals gating transitions on signatures,
   decide open question 11 on real material (§6 below). *Built: both poles exist and
   each carries the case it fits. Filed as **K-38** (awaiting ratification).*
4. **Milestone D — the third shape forces the seam open.** A CRM whose central artefact is a
   priced *avtal* signed by all parties with BankID via Scrive fits the engine's attestation
   half exactly and its content half not at all — and exposed a freeze-window defect affecting
   checklists too. Content becomes a discriminated `kind`, and freezing becomes a transition
   separate from signing (§5.1, §5.3). Note the extraction discipline held in reverse here:
   the second consumer of the *attestation* half is what justified generalising it, and
   splitting it into its own engine was rejected because D-19's star topology forbids an
   engine importing an engine — checklists-on-top-of-signing is not a legal shape.

Each milestone is agent-loop material (runs 003–005): A extends a vertical, B is an
*extraction* — a benchmark shape no run has tested — and C is a kernel change behind
a manifest surface.

## 3. Domain model (engine-owned after extraction)

**The five tables and their columns live in one place, and it is not here:**
[`apps/docs/engines/protocol/model.md`](../../apps/docs/engines/protocol/model.md),
published at [substrat.net/engines/protocol/model](https://substrat.net/engines/protocol/model).
This page restated them until the copy disagreed with the engine — it gave
`protocol_instances.status` as `('open' | 'signed' | 'voided')`, three of the four states
the engine actually has (`pending_signature`, the state `requestSignatures` moves an
instance into, was missing), carried none of the freeze or document-binding columns
(`frozen_hash`, `frozen_at`, `bound_hash`, the content ref) and still marked
`protocol_signature_requests` as forthcoming
"milestone D" work that shipped. That is what [`docs/README.md`](../README.md) means by
*nothing belongs in both*.

What stays here is the reasoning the published page does not carry — the design choices to
challenge in review:

- **Responses are append-only** (edit = new row). The fill history is itself audit
  material ("value changed from 4.2 to 5.1 before signing"), and it makes offline
  capture (master plan open question) event-shaped by construction.
- **Templates version immutably**; an instance pins (key, version) at instantiation.
  Editing a template never rewrites what a signed document referred to.
- **Voiding, not deleting**: a signed protocol can be superseded (`voided` + reason +
  event + replacement instance), never mutated or removed.

## 4. Invariants (what the engine *is*)

1. Freeze freezes: any write to a frozen instance's content fails at the engine. Freezing
   happens at in-app signature, or at dispatch for an external flow (§5.1).
2. `content_hash` = hash over template content + the frozen content, stored on the instance as
   `frozen_hash` at freeze time; every signature must match it, and it is verifiable against
   replayed state. One recipe per content kind (§5.3).
3. Exactly one `primary` signature per instance; counter-signatures (customer at pickup) are
   additional signature rows on the same frozen content, never new content. A signatory never
   signs the same instance twice — stated over *signatories*, so it holds for external parties.
4. Append-only responses, bound to an unfrozen checklist instance.
5. Every mutation emits a fat payload — a consumer never needs a cross-module read. The
   nine events, with what each announces, are at
   [`apps/docs/engines/protocol/events.md`](../../apps/docs/engines/protocol/events.md).
6. Every operation checks a permission. The keys are at
   [`apps/docs/engines/protocol/surface.md#permissions`](../../apps/docs/engines/protocol/surface.md#permissions)
   — this page listed nine of the ten until `protocol:attach`, the attachment write gate,
   was added to the engine and never to the copy. What belongs here is *why* there are that
   many: `sign` is deliberately separate from `fill` (the FSM reality — the technician
   fills, sometimes only the arbetsledare signs), and `record-signature` is deliberately
   separate from all of them because it speaks for an external provider rather than for a
   person.

## 5. Signature model: provider-agnostic evidence

A signature records a **signatory** + `method` + `content_hash` + optional `evidence_ref`
(attachment). Methods:

- **`in-app`** (always available): the authenticated principal taps sign. Integrity comes from
  the engine (hash, immutability, spine event) — the everyday field case, no third party,
  works self-hosted/escrow. Freezing and signing coincide, which is sound *because* it is
  synchronous.
- **`bankid` / `scrive` / …**: a connector in the integrations hub runs the external flow.

### 5.1 The correction (milestone D)

The original draft of this section claimed the connector case would "arrive later through the
SAME operation shape with upgraded evidence", and the code carried that claim in
`signProtocol`'s doc comment. **That was wrong**, and it was wrong in a way that also left a
hole in the freeze invariant. `signProtocol` takes three things from ambient context that an
external flow cannot supply:

| | in-app | external provider |
|---|---|---|
| who signs | `ctx.principal` | a person with **no account in the system** |
| when | now | days later, at the provider's timestamp |
| freeze | at signature | at **dispatch** |

The third is the sharp one and it is not a contract-shaped problem. With freeze welded to
signing, an instance sitting at a provider stays `open` — and therefore *writable* — for the
entire days-long window, so the document the signatory saw and the content the hash is
computed over can diverge with nothing detecting it. **That applies to a checklist signed with
BankID exactly as much as to a priced contract**, so it is an asynchronous-signing defect, not
a document-content one.

The missing concept was a noun: the **signature request**.

```
open ──requestSignatures──> pending_signature ──all parties signed──> signed
  │                                │
  │                                └── cancelSignatureRequests ──> open (renegotiate)
  └──signProtocol (in-app)──────────────────────────────────────> signed
```

- `pending_signature` is frozen: no fill, no rebind. The drift window closes.
- The hash is computed **once**, at dispatch, and every returning signature must match it.
- The signatory becomes data rather than context:
  `{ kind: 'principal', ref: PrincipalId } | { kind: 'external', ref: DataSubjectId }`.
  The external form follows `engines/booking`'s `partyRef` — opaque and shreddable. A
  personnummer must never appear there; it is `direct` PII in a row immutability makes
  permanent. The provider's party id goes in `evidence_ref`.
- Multi-party falls out: an instance reaches `signed` only when **every** requested party has
  signed. A declined request is not "pending" but is not a signature either, so completion is
  counted over `status = 'signed'`, not over the absence of pending rows.
- Cancelling **thaws** and clears the frozen hash. Signatures already collected are kept as
  history but were taken over the old hash and can never satisfy the new one: a party who
  signed v1 has not signed v2.

`method`/`evidence_ref` were reserved slots with no code path able to write them. They now
have one.

### 5.2 The return path, and what is still missing

The engine emits `protocol.signatures-requested`, a connector dispatches it, and the return
path now exists — both kernel gaps this section used to list are closed:

- **ingress** — a capability URL minted per dispatch and mounted on the control plane, with a
  poll floor underneath it when no callback URL is configured (#96)
- **inbound authority seam** — `getConnectorScope(connectionId, scopeId)` opens a scope stub
  whose authority is the connection's own grants, so a provider's callback needs no
  `PrincipalId` (#97)

What is still missing is outside the engine: the consuming vertical must schedule the
reconciliation poll itself, and BankID-to-sign is disabled on the Scrive testbed account, so
the real signing round-trip is unverified.

`recordSignature` is called across that seam and is gated by its own permission key,
`protocol:record-signature`, held by **no human role** in any demo — a connection holds it. eIDAS
advanced/qualified remains an evidence-quality upgrade — but only once the flow producing it
exists. The engine never imports a vendor SDK.

### 5.3 Two content kinds (milestone D)

The attestation half was always content-agnostic; only `fill` and the template shape were
checklist-specific. That seam is now exposed as a discriminated `kind`:

- **`checklist`** — the original shape. Templates predating the discriminant carry no `kind`
  and parse as checklist; their stored `content_json` is **never rewritten**, because the hash
  covers that string verbatim and a migration touching it would invalidate every signature
  ever made. The checklist hash recipe is byte-identical to the one that shipped.
- **`document`** — content the engine never sees. The vertical owns the rows, computes their
  hash, and binds `(contentRef, contentHash)`.

The alternative — modelling a contract as a degenerate one-item checklist with the real
content in the vertical — was rejected: the engine would attest to the sentence "I accept this
contract" and nothing else, producing a signature that *looks* like evidence and is not.
`documentContent.hashRecipe` is required so the method for reproducing the hash is written
where an auditor finds it. The engine proves the signature was made over that hash and that it
has not moved; it cannot prove the vertical's rows still hash to it, and says so.

## 6. The guard (open question 11) — both poles, built

"Obligatorisk för status": completing a work order requires protocol X signed. The two
poles from kernel-design, **both now implemented**, each carrying the case it fits.

### Pole 1 — vertical-composed (milestone A, shipped)

The vertical's `complete` operation calls the protocol engine's in-scope predicate
(`requireSigned(ctx, entityRef, templateKey)`) before the engine's `completeWorkOrder`.
Same pattern as the pricing moment; zero kernel machinery. Weakness (named in the open
question): it's glue an edit can silently drop — invisible to review, weak for
compliance.

**It is still the right pole when the policy is CONDITIONAL on vertical data.**
Callout owes an egenkontroll only on `montage` orders (`demos/callout/src/module.ts`):
`order.kind` is Callout vocabulary, and the kernel must never learn it. That guard
stays glue, on purpose.

### Pole 2 — manifest-declared (milestone C, shipped)

A module's **manifest** declares an unconditional pre-condition on an operation; another
module **contributes** the named predicate. Handlebar (`demos/handlebar`):

```ts
// manifest (the vertical — the layer that owns "what is mandatory when")
guards: [{
  before: 'bike-shop/close-repair',        // any registered OPERATION
  predicate: 'protocol/all-signed',        // a named predicate some module contributes
  config: {                                // opaque to the kernel; the predicate parses it
    templateKey: 'tillstandsrapport',
    entityType: 'workorder',
    entityIdFrom: 'orderId',               // which input field carries the entity id
    countersigned: true,                   // the customer accepted it at pickup
  },
}]

// registration (the engine — contributes the code half, wires nothing)
export const protocolModule: ModuleRegistration = {
  manifest: protocolManifest,
  predicates: { 'protocol/all-signed': allSignedPredicate },
  operations: { … },
};

// kernel contract
export type GuardPredicate = (
  ctx: OperationContext,
  config: Record<string, unknown>,
  input: unknown,
) => void | Promise<void>;        // throws → BLOCK; returns → allow
```

**Where it fires:** inside the scope actor task and inside the operation's own
`BEGIN IMMEDIATE … COMMIT`, immediately *before* the handler. A throw rolls the
transaction back exactly like a handler throw — no row, no event, fail closed.

**Resolution is late, and that is deliberate.** Registration order is caller-controlled
(a vertical may register before the engine whose predicate it wires), so a fast-fail at
`registerModule` would reject wiring that is merely *early*. Predicates therefore resolve
at invoke; an unresolvable name **blocks** the guarded operation ("unknown guard
predicate"). A typo can never widen a gate, only close one. What *is* enforced eagerly is
the half the kernel can see whole: predicate names are global and may not collide.

Star topology holds: the workorder engine knows nothing of protocols; the protocol engine
knows nothing of bike shops; the vertical manifest wires them. Because the gate is
manifest surface, adding or **dropping** it lands in the reviewable diff — the property
vertical-composed glue lacks.

### The rule, stated once

> Manifest guards are **unconditional gates on an operation**. Policy conditional on
> vertical data stays **vertical-composed glue** inside the operation.

### Pole 2's complement — operation withdrawal (what makes the guard *enforceable*)

A guard binds the **operation it names**. On its own that makes a gate *reviewable* but
not *enforceable*: Handlebar gates `bike-shop/close-repair`, while the engine's own
`workorder/close` would stay registered — and any caller holding `workorder:close` could
walk around the gate. (Confirmed in the demo before this landed: sign without
counter-signing, `bike-shop/close-repair` blocks, plain `workorder/close` closes it
anyway.) Gating `workorder/close` directly is not the answer: it would make the gate
unconditional for *every* repair, and a punktering carries no condition report.

The fix is the missing half of the surface — a manifest may **withdraw** another module's
default binding:

```ts
// bike-shop manifest
withdraws: ['workorder/close'],   // the name stops resolving in THIS host
```

- **Withdrawal removes the BINDING, not the capability.** The engine's in-scope
  `closeWorkOrder(ctx, …)` stays exported and composable — it is exactly what the
  vertical's guarded `bike-shop/close-repair` calls. The engine loses a default door, not
  a function.
- **Order-independent.** A vertical may register before or after the engine it withdraws
  from; the host keeps a `withdrawn` set, `defineOperation` skips a withdrawn name, and a
  manifest that withdraws an already-registered operation removes it from the map.
- **Fails closed and looks like nothing special.** A withdrawn operation is
  indistinguishable from one that was never registered: `unknown operation`.
- **Opt-in, never self-inflicted.** Callout withdraws nothing and keeps
  `workorder/close`. A module withdrawing its *own* operation throws — it is meaningless
  and would hide bugs.

Guard + withdrawal together: **the only door to `closed` in Handlebar is the vertical's
pickup ceremony, and the kernel refuses it until the customer has counter-signed.** The
gate is now in the manifest diff *and* in the execution path.

## 7. Explicit non-goals (v0)

Conditional/branching templates, scheduled/recurring instantiation, PDF rendering,
photo capture pipeline (attachment contract covers storage), offline sync (binds to the
master-plan offline question, not solved here), template marketplace.

Milestone D adds two more: the engine does not **render** a document (a `document` instance
holds a ref and a hash, never bytes), and it does not **reconcile** a vertical's content
against a bound hash — recomputation is the vertical's obligation, declared in `hashRecipe`.

## 8. Review questions for the human

1. ~~Rehearsal (A/B) vs direct engine build?~~ **Resolved 2026-07-14: rehearsal.**
   Milestone A ships as Callout vertical code; extraction happens at milestone B.
2. Is append-only responses right, or is latest-value-with-audit-log enough?
3. Counter-signature as second signature row on frozen content — does the bike-shop
   pickup flow actually need the customer to sign *after* content freezes, or before?
4. ~~Guard proposal: is `before:`-operation granularity right, or do guards belong on
   engine *transitions* (status values) rather than operations?~~ **Resolved 2026-07-14
   (milestone C): OPERATIONS.** Transitions were rejected on three counts. (a) *The
   kernel would have to learn engine internals*: a transition key like
   `workorder: in_progress → completed` only means something if the kernel knows that
   engine's status vocabulary and its state machine — exactly the domain knowledge the
   three-layer rule keeps out of layer 1. Operations are already the kernel's own
   vocabulary (it registers them, it invokes them, it wraps them in a transaction). (b)
   *There is no interception point*: a transition happens deep inside an engine's
   in-scope function, called from a vertical's handler inside an open transaction — the
   kernel never sees it, so enforcing there would mean a callback surface reaching into
   engine code (the star topology's collapse). The operation boundary is the only place
   the kernel legitimately stands between a caller and domain code. (c) *Transitions are
   the wrong unit of review*: what compliance cares about is "closing a repair requires
   the customer's counter-signature", a business moment the vertical names. It is an
   operation. The cost of the choice — a guard binds one operation, so the engine's
   default binding for the same transition was an unguarded path — is paid by
   withdrawal (§6), not by more guard machinery.
5. ~~Should a vertical be able to withdraw / re-bind an engine's default operations (so
   `workorder/close` cannot bypass `bike-shop/close-repair`)?~~ **Resolved 2026-07-14:
   yes — `withdraws: string[]` on the manifest, order-independent, opt-in, binding-only.
   The bypass is closed; the demo asserts `workorder/close` is now `unknown operation`
   in Handlebar's host while Callout keeps it.**
