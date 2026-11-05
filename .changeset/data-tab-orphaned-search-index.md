---
'@substrat-run/kernel': patch
'@substrat-run/adapter-sqlite': patch
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/contract-tests': patch
---

The Data tab loads for a scope whose search index outlived the table it was built over, instead of failing with `no such table`.
