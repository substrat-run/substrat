---
"@substrat-run/kernel": patch
"@substrat-run/adapter-sqlite": patch
"@substrat-run/adapter-cloudflare": patch
"@substrat-run/contract-tests": patch
---

Allow resumable job runs to declare a data subject so erasure also redacts external results and error text without a classified event envelope. Refuse coalescing runs with different subjects; preserve legacy runs with an unknown subject through an additive schema upgrade.
