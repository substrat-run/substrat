# Events

The engine **emits 9 and consumes none** — protocols are driven by operations, not by
upstream facts.

```ts
events: {
  emits: [ /* the 9 below */ ],
  consumes: [],
}
```

## Emitted

| Event | v | piiClass | Payload |
|---|---|---|---|
| `protocol.instantiated` | 1 | none | instance id, template `(key, version)`, entity |
| `protocol.response-recorded` | 1 | pseudonymous | instance id, response id, item key, value |
| `protocol.content-bound` | 1 | none | instance id, document type, content ref, bound hash |
| `protocol.signatures-requested` | 1 | none | content hash, method, parties (label, kind, request id) |
| `protocol.signature-declined` | 1 | none | request id, party label, outcome, reason |
| `protocol.signatures-cancelled` | 1 | none | instance id, how many were withdrawn, reason |
| `protocol.signed` | 1 | pseudonymous | signatory, content hash, **frozen answers** |
| `protocol.countersigned` | 1 | pseudonymous | signatory, counter-signatory, hash, **frozen answers** |
| `protocol.voided` | 1 | pseudonymous | instance id, entity, previous status, reason |

`protocol.signatures-requested` is the connector's dispatch order: it carries the hash, the
parties and the content ref, so an executor never needs a read back into the scope to know
what to send where.

## The signature events carry the whole document

`protocol.signed` and `protocol.countersigned` are **fat events**: the frozen answers travel
in the payload alongside the content hash. A downstream consumer — an archival connector, a
compliance export — never queries back.

This matters more here than elsewhere. The point of the engine is that a signed protocol can
be produced *unaltered, years later*. An event carrying the hash but not the answers would
force the consumer to re-read tables that may have moved on, which is exactly the join the
snapshot discipline exists to prevent. The event **is** the archival record.

## PII and erasure

Events referencing a person carry `piiClass: 'pseudonymous'` and that person's `subjectId`.
A GDPR erasure crypto-shreds the person while the fact that a signed protocol exists survives.

**`subjectId` is not always the acting principal.** On a signature recorded from an external
provider it is the *signatory* — a `DataSubjectId` for someone with no account in the system
at all. That is what makes an external signature shreddable, and it is why a personnummer must
never be used as the signatory reference: it would be `direct` PII written into a row that
immutability makes permanent. The provider's own party identifier goes in `evidence_ref`.

That split is deliberate and slightly subtle: the *compliance* claim ("this protocol was
signed, and here is its hash") outlives the *personal* claim ("by this named individual").
The artifact stays verifiable; the person becomes unidentifiable.

## Evolution rules

Payload fields are **frozen once shipped**. New fields may be added; renaming, removing, or
retyping one means a `schemaVersion` bump.

Before bumping, read the
[invoicing engine's `underlag-exported` v2 note](/engines/invoicing/events#versioning):
consumer dispatch keys on event **type alone**, so dual-emitting two versions delivers *both*
to every consumer of that type. The "deprecation window" the conventions describe isn't
actually available until version routing exists.
