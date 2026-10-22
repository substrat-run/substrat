---
"@substrat-run/contracts": minor
"@substrat-run/kernel": patch
"@substrat-run/vertical-auth": patch
"@substrat-run/vertical-host": patch
"@substrat-run/control-plane-api": patch
---

Record bounded, credential-free authentication checks on request invocation logs. Bearer verification distinguishes invalid issuer/audience, expiry, signature, discovery/key failures and app/delegation policy refusals; MCP records caller-resolution outcomes and early refusal problem codes. Request details show these checks, including a verified token followed by a caller refusal. Authentication responses and admission policy are unchanged.

Upgrade and re-push a vertical with the updated auth and host packages to produce the diagnostics. Older lines remain readable and do not imply authentication succeeded.
