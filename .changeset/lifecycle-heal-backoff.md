---
'@substrat-run/adapter-cloudflare': patch
---

The lifecycle heal backs off from a scope whose delivery keeps failing, and files one ops-failure row per error instead of one every pass (#3119).
