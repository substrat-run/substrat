---
'@substrat-run/boundary-lint': patch
---

`DEFAULT_HARNESS` gains the auth adapter's BankID files (`bankid.ts`, `bankid-plugin.ts`,
`bankid-transport-node.ts`) — the same class of declared boundary as `cimd-fetch.ts`: an
issuer calling BankID's mTLS RP API has no `ctx` and no connector to delegate to, and the
transport file exists separately so what it can and cannot guarantee is reviewable in one
place.
