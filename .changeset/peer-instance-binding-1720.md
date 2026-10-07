---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/control-plane-api': minor
---

Tenant admins can choose the target scope for a calling app's peer calls when their tenant runs multiple instances of one vertical. The directory keeps the choice per caller scope and target vertical; both synchronous and queued calls resolve through it at execution. A stale choice refuses calls until it is restored, changed or cleared, and a foreign scope cannot become a target. The dashboard offers the picker and the console shows existing choices.
