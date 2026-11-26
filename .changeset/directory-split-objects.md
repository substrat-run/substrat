---
"@substrat-run/kernel": minor
"@substrat-run/adapter-cloudflare": minor
"@substrat-run/adapter-sqlite": minor
"@substrat-run/contract-tests": minor
"@substrat-run/control-plane": patch
---

K-68 (directory split), step 3a: the directory registry and per-tenant directory object classes, created empty beside the existing directory, with the intent-first crossing helper (`runCrossing`), its one-database seam (`SqliteScopeHost.directoryObjects()`) and the crossing contract suite. Nothing routes traffic to them yet.
