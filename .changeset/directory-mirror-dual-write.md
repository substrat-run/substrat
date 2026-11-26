---
"@substrat-run/adapter-cloudflare": minor
"@substrat-run/control-plane": patch
---

K-68 (directory split), step 3b: the directory can dual-write every row to the object it is placed in after the split — its tenant's directory object or the registry — from an outbox the directory's own triggers fill, applied once per key and never backwards. Off unless `DIRECTORY_MIRROR` is set; nothing reads the objects yet.
