---
'@substrat-run/boundary-lint': patch
---

`provider-discovery.ts` joins the auth adapter's declared network boundaries in `DEFAULT_HARNESS` — the save-time OIDC discovery fetch behind custom sign-in providers, in exactly `cimd-fetch.ts`'s class: the issuer is itself the relying party, with no `ctx` and no connector to delegate to.
