---
'@substrat-run/boundary-lint': patch
---

`bankid-transport-hop.ts` joins the default harness list beside `bankid-transport-node.ts`: it is the auth adapter's hosted BankID transport, a declared network boundary that calls the platform's sign-in relay.
