---
'@substrat-run/kernel': patch
'@substrat-run/adapter-sqlite': patch
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/contract-tests': patch
'@substrat-run/control-plane-api': patch
---

Keep a preview deadline alive during a background copy only while the same move is pending and the deadline still matches the poll's read. Overlapping polls now produce one expiry update and audit entry, and a delayed poll cannot renew a failed fork after its move is settled.
