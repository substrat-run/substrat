---
'@substrat-run/adapter-cloudflare': patch
---

A CP-less host reads its connection grants without asking for a control plane it does not have, so a declared landing on a hosted vertical is granted instead of failing every pass (#2892).
