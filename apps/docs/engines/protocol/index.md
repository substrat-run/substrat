# Protocol engine

`@substrat-run/engine-protocol` — **protocols and checklists with the sign → immutable
invariant**: self-inspections, installation protocols, service checklists, per-item condition
reports. A protocol is the compliance artifact a field-service or workshop business must be
able to produce, unaltered, years later.

The engine owns only the invariants. Template **content** — which protocols exist, what
sections and items they contain, which are mandatory when — is 100% vertical-owned. An
instance binds to any `EntityRef` — a work order, a bike's condition report, or an
employee's **onboarding checklist**, all three shipping in the demo verticals — and the
engine never knows the vertical's vocabulary. (The HR vertical even signs onboarding as the
*employee*, not a supervisor: same engine, the vertical's grant decides who signs.)

Both content kinds ship in [Meridian](/verticals/meridian#engines-composed): onboarding as a
`checklist`, and the **anställningsavtal** as a `document` signed by an employer principal
and a new hire who has no account yet. It is the worked example for everything below.

## At a glance

| | |
|---|---|
| **Package** | `@substrat-run/engine-protocol` |
| **Entitlement key** | `protocol` |
| **Owns** | version-pinned templates, append-only responses, freeze→immutable, a verifiable content hash, signature requests |
| **Emits** | 9 events, `protocol.instantiated` → `protocol.voided` ([events](./events)) |
| **Consumes** | nothing |
| **Permissions** | 9 (`protocol:create` · `fill` · `bind` · `request-signature` · `record-signature` · `sign` · `countersign` · `read` · `void`) |
| **Contributes** | the `protocol/all-signed` guard predicate — the only config-shaped surface in any engine |
| **Status** | product seed (0.x) — the extraction proof |

## What it owns

1. **Freeze freezes.** Content is writable only while an instance is `open` — whether it
   froze at an in-app signature or at dispatch to an external signing provider.
2. **Verifiable content hash.** SHA-256 over template content plus the frozen content —
   replayable against stored rows by anyone. One recipe per content kind.
3. **Counter-signature on frozen content.** A second signature whose hash must equal the
   primary's, so it can never silently attach to changed content.
4. **Append-only responses.** An edit is a new row; the history *is* audit material.
5. **Version-pinned templates.** An instance pins `(key, version)` at instantiation forever.
6. **Void, not delete.** A superseded protocol is voided with a reason, never removed.
7. **A signature is over a *frozen* hash, by a named signatory, at a stated time.** The
   signatory may be a principal or an **external person with no account**, which is what makes
   a BankID/Scrive flow expressible without pretending it is a synchronous in-app tap.

Details: [Domain model & invariants](./model).

## What it will not do

- **Template content** — sections, items, vocabulary, branschprotokoll packs are the
  vertical's. The engine validates fills against the pinned template shape; it authors no
  templates.
- **Talk to external signature providers** — the engine emits a request and a connector
  dispatches it; it imports no vendor SDK and makes no network call. The *inbound* half
  (ingress, and an authority seam letting a non-principal callback invoke an operation) is
  built and lives outside this engine too — see
  [the connector seam](/connectors/#the-seam-a-connector-plugs-into).
- **Render or reconcile a document** — a `document` instance holds a ref and a hash, never
  bytes, and recomputing that hash from your own rows is your obligation, not the engine's.
- **Branching/conditional templates, scheduled instantiation, PDF rendering, a photo
  pipeline, offline sync, a template marketplace** — explicit v0 non-goals.

## Is this a good match?

| Reach for it when | Look elsewhere when |
|---|---|
| Someone must **attest** to a set of answers, and that attestation must hold up later | You just need a form; a table and a timestamp are cheaper |
| "Prove this wasn't altered after signing" is a real question | Nobody will audit it |
| The person who fills is not always the person who signs | One actor does everything |
| A second party (customer at pickup) confirms the same content | There's no counterparty |
| Parties sign **asynchronously**, via a provider, possibly without accounts | Everyone signs in-app, in session |
| The signed thing is a **document you own** (an avtal), not a checklist | It is neither |
| The checklist's *content* is yours and changes over time | You want the engine to ship the checklists — it won't |

The clarifying question: **is the signature load-bearing?** If the value is in the answers,
you want a form. If the value is in *who stood behind the answers, and that they haven't
changed since* — that's this engine.

This engine is the **extraction proof**: it was forced out of vertical code only when a
*second* vertical (a bike shop's per-bike condition report) needed the same sign-immutability
invariant in a different shape. Engines get extracted when a second consumer proves the line,
not when someone predicts one.
