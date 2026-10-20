---
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/control-plane-api': minor
---

Keep a preview deadline alive during a background copy only while every entry of the same move is pending, unclaimed, inside its lease, and the deadline still matches the poll's read. Overlapping polls now produce one expiry update and audit entry, and a delayed poll cannot renew a failed fork after its move is settled. Add the required HostAdmin method for hosts implementing this conditional update.
