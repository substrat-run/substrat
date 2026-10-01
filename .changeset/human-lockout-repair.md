---
"@substrat-run/kernel": patch
"@substrat-run/adapter-cloudflare": patch
---

Allow CP-less hosts to declare their service principal IDs for reconciliation, so service roles cannot prevent the owner-of-record from being restored when every human holder is locked out. Ticket0 supplies its durable service-account record; service authority and deliberate human handovers are preserved.
