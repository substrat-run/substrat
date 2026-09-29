---
'@substrat-run/connector-scrive': patch
---

The return path now attributes a Scrive signature by Scrive's own party id, which survives an edit made at Scrive. Before, it matched by list position with the party's name as a cross-check, so correcting a party's name or address at Scrive after sending made every later poll skip that party's signature without any report. The protocol instance stayed `pending_signature` while Scrive showed the document as signed.

- A dispatch stores each party's `providerPartyId`, read from `start`'s response.
- A dispatch made before this change gets its ids pinned by the first poll that finds the document still has the shape that was sent. Its stuck signatures are then recorded on that poll.
- A signature that still cannot be attributed is no longer dropped. It is kept on the ledger row as `needsAttention` and returned from both the reconcile and the sweep. The connection's activity view flags the row as "needs attention" and shows the reason next to the party.
