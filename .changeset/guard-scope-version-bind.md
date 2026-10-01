---
"@substrat-run/kernel": patch
"@substrat-run/adapter-sqlite": patch
"@substrat-run/adapter-cloudflare": patch
"@substrat-run/contract-tests": patch
---

Add an optional expectedVersionId to scope version binding. Both adapters atomically refuse stale binding updates, including an expected unbound scope, so concurrent data moves can guard their final pointer change.
