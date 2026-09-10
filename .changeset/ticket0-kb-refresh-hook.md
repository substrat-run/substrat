---
---

ticket0's documentation sources can now carry a **refresh hook** — a token a docs pipeline presents to `POST /api/kb/sources/:id/refresh` so a publish re-reads the desk's copy, instead of waiting for somebody to press "Re-read". Minted and revoked in Settings → Knowledge base, shown once, stored as a hash, throttled to one read a minute, and running as a new `ingest` service principal that holds `kb:refresh` alone. Demo-only (`demos/ticket0`), so nothing published changes.
