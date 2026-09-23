---
"@substrat-run/control-plane-api": patch
"@substrat-run/adapter-cloudflare": patch
"@substrat-run/adapter-sqlite": patch
"@substrat-run/contract-tests": patch
---

Exclude every preview-kind scope from production adoption and promotion rebinding, and return 409 for explicit preview adopt-serving requests, including already-pinned previews. Clean-room test environments now require explicit preview push or scope bind to advance instead of automatically following production. Existing production serving pins and their data are not repaired by this change.
