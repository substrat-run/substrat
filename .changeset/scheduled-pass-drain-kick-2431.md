---
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/control-plane-api': patch
---

Kick the existing per-scope platform drain after a hosted scope sweeper pass enqueues platform requests. Coalesce schedules to one best-effort kick per scope per pass; the periodic sweep remains the backstop.
