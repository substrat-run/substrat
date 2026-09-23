---
"@substrat-run/adapter-cloudflare": patch
"@substrat-run/adapter-sqlite": patch
"@substrat-run/kernel": patch
"@substrat-run/contract-tests": patch
---

Require an active hostname, correctly paired active scope and active owning tenant for hostname resolution. Non-active lifecycle now returns no route (the router's existing neutral 404), preserving bindings for restoration. Active previews and embedded routes remain supported. This gates new directory lookups only; CP-less background/internal calls and existing connections remain outside this change.
