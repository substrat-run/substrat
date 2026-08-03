---
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/engine-protocol': minor
'@substrat-run/connector-scrive': minor
---

Connectors can land attachments; Scrive lands the sealed signed PDF (#476 step 2).

#473 gave attachment bytes a home, but its `attachments()` surface is minted per
`PrincipalId` — and a connector's return path acts as a *connection*, not a person,
so it had no way to store a provider artifact (bytes cannot ride `getConnectorScope`'s
`invoke` pipe). This adds the missing seam and the first consumer:

- **`ScopeHost.getConnectorAttachments(connectionId, scopeId)`** — the mirror of
  `getConnectorScope` for bytes: the same `ScopeAttachments` surface, same
  (tenant, vertical, active) door, but every gate checked against the connection's
  `connection:<id>` grants, and `createdBy` attributed to the connection. Implemented
  in both adapters (the Cloudflare ScopeDO threads the connection subject through the
  attachment gate exactly as `invoke` does) and covered on each.
- **`engine-protocol`** declares an explicit `protocol:attach` write permission on its
  `protocol` attachment target (read stays `protocol:read`). A signing connection is
  granted `protocol:attach` and nothing else — it can land the sealed PDF but not
  browse the scope's attachments. No human role holds it yet.
- **`connector-scrive`** fetches `files/main` once the document is `closed` and every
  party is recorded, and lands it as a `customer`-visible attachment on the protocol
  instance. Marked in the dispatch ledger (`sealedAttachmentId`) so a re-poll never
  downloads or stores a second copy; a store that is not yet provisioned is reported
  and retried next poll, never allowed to undo a recorded signature.
