---
description: "Templates, instances, responses and signature requests across five tables: immutable template versions, the checklist and document content kinds, and provider-agnostic signature evidence."
---

# Domain model & invariants

## Templates, instances, responses, signatures

Five concepts, mirrored by five tables (migrations `0001-init` and
`0002-signature-requests`, inside each scope's own database):

- **`protocol_templates`** — `key`, `version`, `title`, and `content_json`. Immutable per
  `(key, version)`: new content is a **new version**, never an edit. Content comes in two
  **kinds** (below): a `checklist` of sections → items, or an opaque `document`.
- **`protocol_instances`** — a template pinned at `(key, version)` bound to an
  `entity_type`/`entity_id`, with `status` `open` → `pending_signature` → `signed`, or
  `voided`. Carries the `frozen_hash` once content freezes, plus the `content_ref`/`bound_hash`
  a document instance binds.
- **`protocol_signature_requests`** — one row per party a document was sent to for signature:
  `party_label`, `party_kind`, `method`, `status`, `external_ref`. The noun that makes
  asynchronous, multi-party signing expressible.
- **`protocol_responses`** — append-only fill entries: `item_key`, `value_json`, `note`,
  `responded_by`, `responded_at`. **Latest-per-item wins**, ordered by append (`rowid`,
  same-millisecond safe) — the history *is* audit material ("value changed from 4.2 to 5.1
  before signing").
- **`protocol_signatures`** — `signed_by` (the signatory's reference), `signatory_kind`
  (`principal`/`external`), `kind` (`primary`/`counter`), `method`, `content_hash`, optional
  `evidence_ref` and `request_id`. Exactly one `primary` per signed instance.

The template pins at instantiation **forever**: editing a template tomorrow never rewrites
what a signed document referred to.

## The invariants

1. **Freeze freezes.** Content is writable only while an instance is `open`. Freezing happens
   either at in-app signature or at `requestSignatures`, and from that moment fills and
   rebinds fail at the engine.
2. **Verifiable content hash.** At freeze time the engine computes a SHA-256 and stores it as
   the instance's `frozen_hash`. Every signature must match it. The recipe is the contract —
   anyone can replay it against the stored rows and compare. One recipe per content kind:

   ```
   checklist: '<key>@<version>\n<content_json>\n' + 'item=value_json\n' per item, sorted by key
   document:  '<key>@<version>\n<content_json>\ndocument:<boundHash>\n'
   ```

   The checklist recipe is byte-identical to the one that shipped originally, so signatures
   made before the document kind existed still verify. The hash is Web Crypto
   (`globalThis.crypto`), so the same code runs in Node, Workers, and the browser.
3. **Counter-signature on frozen content.** A counter-signature (the customer at pickup) is a
   *second signature row* on the **same** frozen content — the engine recomputes the hash and
   it must equal the primary's, so a counter-sign can never silently attach to changed
   content. A principal never counter-signs what they primary-signed, and never counter-signs
   twice.
4. **Append-only responses**, bound to an open instance.
5. **Every mutation emits a fat event** ([events](./events)) — a consumer never needs a
   cross-module read.
6. **Void, not delete.** A superseded protocol is `voided` (with a reason and an event), never
   mutated or removed; a replacement is a new instance.

## Two content kinds

The attestation half of this engine — the hash, the freeze, the signatures, the guards — was
always content-agnostic. Only `fill` and the template shape were checklist-specific. That seam
is exposed as a discriminated `kind`:

- **`checklist`** — sections → items, filled response-by-response. Item types are `check`
  (boolean), `value` (a measurement — decimal string, with an optional `unit` like `MΩ`), and
  `text`. Templates written before the discriminant existed carry no `kind` and parse as
  `checklist`; their stored `content_json` is never rewritten, because the hash covers that
  string verbatim.
- **`document`** — content the engine **never sees**. A priced avtal, a styrelserapport, a
  PDF: the vertical owns the rows, computes their hash, and binds `(contentRef, contentHash)`
  to the instance with `bindDocument`. Rebinding is allowed while open — an avtal's price
  moves during negotiation — and each rebind moves what a signature will attest to.

::: tip Why not model a contract as a one-item checklist?
Because the engine would then attest to the sentence "I accept this contract" and nothing
else. The hash covers template content plus responses; if the real content lives in your
vertical, a degenerate checklist produces a signature that looks like evidence and is not.
The `document` kind says out loud what is actually true: the signature is over a hash the
vertical computed. `documentContent.hashRecipe` is a **required** field for exactly that
reason — a signature over an unreproducible hash is worth nothing, so the method for
reproducing it has to be written where an auditor will find it.

What the engine proves for a document: this signature was made over exactly this hash, at
this time, by this signatory, and the hash has not changed since. What it cannot prove: that
your rows still hash to it. That check is yours — see Meridian's `hr/verify-contract` for
what owning it looks like.
:::

## The signature model: provider-agnostic evidence

A signature records its signatory + `method` + `content_hash` + optional `evidence_ref`.

The **`in-app`** method is the everyday field case: the authenticated principal taps sign, and
integrity comes from the engine itself — the hash, the immutability, the spine event. No third
party, works self-hosted. Freezing and signing coincide, which is sound precisely *because* it
is synchronous: there is no window between what the signer saw and what was hashed.

**External providers (BankID via Scrive, …) are a different operation shape, not the same one
with better evidence.** Three things that `signProtocol` takes from ambient context are not
available:

| | in-app | external provider |
|---|---|---|
| who signs | `ctx.principal` | a person with **no account** |
| when | now | days later, at the provider's timestamp |
| freeze | at signature | at **dispatch** — or the document drifts while it is out |

So the external path is `requestSignatures` → *(days)* → `recordSignature`, and the signatory
is data rather than context:

```ts
signatory:
  | { kind: 'principal'; ref: PrincipalId }
  | { kind: 'external';  ref: DataSubjectId }   // opaque, shreddable
```

::: danger Never put a personnummer in `ref`
It is `direct` PII, and `subjectId` on the emitted event is what crypto-shredding keys the
erasure on. A `DataSubjectId` is shreddable; a personnummer written into a signature row is a
GDPR liability that immutability makes permanent. The provider's own party identifier belongs
in `evidence_ref`. This follows `engines/booking`'s `partyRef` for the same reason.
:::

eIDAS advanced/qualified levels *are* an evidence-quality upgrade — but only once the flow
that produces them exists. The engine never imports a vendor SDK. (See
[Composing](./composing#reaching-the-outside-world) for what is and is not built.)

## The lifecycle

<StateMachine engine="protocol" />

`pending_signature` is frozen: no fill, no rebind. It is the state that closes the drift
window — with freeze welded to signing, an instance sitting at a provider for days stayed
`open` and writable, so the document the customer saw could differ from the one that was
hashed, undetected.

An instance reaches `signed` only when **every** requested party has signed. A declined or
expired request is not "pending", but it is not a signature either — treating it as completion
would mark an avtal fully executed that a party refused. An unresolved refusal holds the
instance frozen until someone explicitly withdraws the request set, which is a separate,
permissioned, audited act.

Cancelling **thaws**: status returns to `open` and `frozen_hash` clears, so the next request
freezes fresh content at a fresh hash. Signatures already collected are kept — they are
append-only history attesting to content that really was frozen — but they were taken over the
old hash and can never satisfy the new one. A party who signed v1 has not signed v2.

## Sign is separate from fill

`protocol:fill` and `protocol:sign` are deliberately distinct permissions. The field reality:
the technician fills the protocol, but only the *arbetsledare* signs it.

Filling records the responder as `ctx.principal`; signing records the signer. Attribution
comes from the ambient context, never from the input — you cannot sign as someone else by
passing their id.
