---
"@substrat-run/contracts": minor
"@substrat-run/kernel": minor
"@substrat-run/control-plane-api": minor
"@substrat-run/connector-fortnox": minor
"@substrat-run/connector-planima": patch
"@substrat-run/control-plane-client": patch
"@substrat-run/dev-issuer": patch
---

- A connection binding declares the kind of data it lands, and a Fortnox binding is either a ledger or a supplier-invoice binding; one scope holds one kind, and the ledger sweep reports a supplier-invoice binding as unsupported instead of syncing it (#2706).
- The automatic landing pass writes a Fortnox or Planima binding after it has validated the declaration, and grants the connection's permission right after (#2706).
- A store driver registration carries its isolation basis, and every store-driver release reader takes the approved release instead of a compiled pin (#2707, #2713).
- A mail-sending connection's verified senders are data: the control-plane API lists them (`GET …/connections/:id/senders`, and `mailSenders` on the connection's detail) and sends a test message through the connection (#2714).
- `ControlPlaneBuilderClient.rollOutStoreDriver` documents that it rolls out an approved release (#2713).
- The dev issuer answers a refused `/dev/token` request as `application/problem+json` (#2711).
