---
"create-substrat": patch
---

The scaffolded worker now flags a response whose operation enqueued a platform intent, so the router drains that scope within seconds instead of leaving it for the next sweep.
