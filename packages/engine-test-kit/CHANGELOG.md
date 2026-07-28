# @substrat-run/engine-test-kit

## 0.0.20

### Patch Changes

- Updated dependencies [bc6d0fa]
  - @substrat-run/contracts@0.22.0
  - @substrat-run/kernel@0.22.0
  - @substrat-run/adapter-sqlite@0.22.0

## 0.0.19

### Patch Changes

- @substrat-run/contracts@0.21.0
- @substrat-run/kernel@0.21.0
- @substrat-run/adapter-sqlite@0.21.0

## 0.0.18

### Patch Changes

- Updated dependencies [d18d788]
- Updated dependencies [a39a024]
  - @substrat-run/contracts@0.20.0
  - @substrat-run/kernel@0.20.0
  - @substrat-run/adapter-sqlite@0.20.0

## 0.0.17

### Patch Changes

- Updated dependencies [b4a6bee]
  - @substrat-run/contracts@0.19.0
  - @substrat-run/kernel@0.19.0
  - @substrat-run/adapter-sqlite@0.19.0

## 0.0.16

### Patch Changes

- Updated dependencies [d18a247]
  - @substrat-run/contracts@0.18.0
  - @substrat-run/kernel@0.18.0
  - @substrat-run/adapter-sqlite@0.18.0

## 0.0.15

### Patch Changes

- @substrat-run/contracts@0.17.0
- @substrat-run/kernel@0.17.0
- @substrat-run/adapter-sqlite@0.17.0

## 0.0.14

### Patch Changes

- Updated dependencies [b23c0a7]
- Updated dependencies [81e9408]
  - @substrat-run/contracts@0.16.0
  - @substrat-run/kernel@0.16.0
  - @substrat-run/adapter-sqlite@0.16.0

## 0.0.13

### Patch Changes

- Updated dependencies [cd32011]
- Updated dependencies [ec89a88]
  - @substrat-run/adapter-sqlite@0.15.0
  - @substrat-run/contracts@0.15.0
  - @substrat-run/kernel@0.15.0

## 0.0.12

### Patch Changes

- Updated dependencies [6a7768a]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
  - @substrat-run/contracts@0.14.0
  - @substrat-run/adapter-sqlite@0.14.0
  - @substrat-run/kernel@0.14.0

## 0.0.11

### Patch Changes

- Updated dependencies [74c9d7b]
  - @substrat-run/kernel@0.13.0
  - @substrat-run/adapter-sqlite@0.13.0
  - @substrat-run/contracts@0.13.0

## 0.0.10

### Patch Changes

- Updated dependencies [73c0cdb]
- Updated dependencies [1dff2bd]
- Updated dependencies [66e752b]
- Updated dependencies [0572a3b]
  - @substrat-run/contracts@0.12.0
  - @substrat-run/adapter-sqlite@0.12.0
  - @substrat-run/kernel@0.12.0

## 0.0.9

### Patch Changes

- Updated dependencies [7e17b16]
- Updated dependencies [858912e]
- Updated dependencies [e4db6ed]
- Updated dependencies [e4db6ed]
  - @substrat-run/kernel@0.11.0
  - @substrat-run/adapter-sqlite@0.11.0
  - @substrat-run/contracts@0.11.0

## 0.0.8

### Patch Changes

- Updated dependencies [9c1f0bb]
- Updated dependencies [113160a]
- Updated dependencies [3fb38da]
- Updated dependencies [2becfd5]
- Updated dependencies [d881f75]
  - @substrat-run/contracts@0.10.0
  - @substrat-run/kernel@0.10.0
  - @substrat-run/adapter-sqlite@0.10.0

## 0.0.7

### Patch Changes

- 3336a17: **engine-protocol: signed documents and asynchronous, non-principal signatures.**

  The engine covered checklists signed in-app by the authenticated principal, now. It now
  covers documents the engine never sees, signed asynchronously by parties who may have no
  account at all — which is what a BankID/Scrive flow actually is.

  **Freezing is now a transition separate from signing.** This closes a real defect rather than
  adding a feature: freezing used to be a side effect of `signProtocol`, which was sound only
  because signing is synchronous. Anything asynchronous left the instance `open` — and
  therefore writable — for the entire time it sat at a provider, so the document a signatory
  saw could drift from the content that was hashed, with nothing detecting it. That affected
  checklists signed with BankID exactly as much as contracts.

  New state machine:

  ```
  open ──requestSignatures──> pending_signature ──all parties signed──> signed
    │                                │
    │                                └── cancelSignatureRequests ──> open (renegotiate)
    └──signProtocol (in-app)──────────────────────────────────────> signed
  ```

  - **`protocol_signature_requests`** — the missing noun. One row per party a document was sent
    to. Makes multi-party expressible: an instance reaches `signed` only when _every_ requested
    party has signed, and a declined request is not completion.
  - **Signatories are data, not context** — `{ kind: 'principal', ref: PrincipalId } | { kind:
'external', ref: DataSubjectId }`. The external form follows `engines/booking`'s `partyRef`:
    opaque and shreddable, so crypto-shredding can key erasure on someone with no principal.
    `method` and `evidence_ref` were reserved columns no code path could write; they now have one.
  - **Two content kinds** — `checklist` (unchanged) and `document`, whose content lives in the
    vertical and reaches the engine only as `(contentRef, contentHash)`. Modelling a contract as
    a degenerate one-item checklist was rejected: the engine would attest to the sentence "I
    accept this contract" and nothing else.

  Backward compatibility: the checklist hash recipe is byte-identical, and no stored
  `content_json` is rewritten (the hash covers that string verbatim), so **every signature made
  before this change still verifies**. Templates predating the `kind` discriminant parse as
  checklists. Migration `0002-signature-requests` rebuilds the three data tables and backfills
  `frozen_hash` from each instance's earliest signature; the upgrade path is covered by a test
  that starts a scope on `0001`, writes 0001-era rows, and brings the real migration list to it.

  New permission keys: `protocol:bind`, `protocol:request-signature`,
  `protocol:record-signature`. All three are held by **no role** in any demo — the third
  deliberately so, since it speaks for an external provider rather than for a person.

  Not built, and now tracked: webhook ingress (#96) and an inbound authority seam that would let
  a provider callback invoke a scope operation (#97). Both gaps are in the kernel, not the
  engine. `recordSignature` is shaped to be callable by that ingress when it lands.

  `@substrat-run/engine-test-kit`: `EmittedEvent` now exposes `piiClass` and `subjectId`, so a
  test can assert that an event names a data subject who is not the acting principal.

- Updated dependencies [27872cc]
  - @substrat-run/kernel@0.9.0
  - @substrat-run/adapter-sqlite@0.9.0
  - @substrat-run/contracts@0.9.0

## 0.0.6

### Patch Changes

- @substrat-run/contracts@0.8.0
- @substrat-run/kernel@0.8.0
- @substrat-run/adapter-sqlite@0.8.0

## 0.0.5

### Patch Changes

- Updated dependencies [c54637b]
- Updated dependencies [8c48c93]
- Updated dependencies [33fb5dd]
  - @substrat-run/contracts@0.7.0
  - @substrat-run/kernel@0.7.0
  - @substrat-run/adapter-sqlite@0.7.0

## 0.0.4

### Patch Changes

- @substrat-run/contracts@0.6.0
- @substrat-run/kernel@0.6.0
- @substrat-run/adapter-sqlite@0.6.0

## 0.0.3

### Patch Changes

- @substrat-run/contracts@0.5.0
- @substrat-run/kernel@0.5.0
- @substrat-run/adapter-sqlite@0.5.0

## 0.0.2

### Patch Changes

- Updated dependencies [6900431]
  - @substrat-run/contracts@0.4.0
  - @substrat-run/kernel@0.4.0
  - @substrat-run/adapter-sqlite@0.4.0
