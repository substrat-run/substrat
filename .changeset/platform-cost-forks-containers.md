---
"@substrat-run/contracts": minor
"@substrat-run/kernel": minor
"@substrat-run/control-plane-api": minor
"@substrat-run/control-plane": patch
"@substrat-run/builder": patch
"@substrat-run/dashboard": patch
"@substrat-run/docs": patch
---

Platform usage counts what it was missing (#3316). The entry the platform uploads in front of every vertical now names a scope's Durable Object when the vertical cannot, so a preview fork's rows are charged to the team that asked for the preview rather than left unattributed. The daily cost rollup also reads Cloudflare Containers usage — CPU, memory, disk and egress — and the builder labels each sandbox with the team it runs for, so builder time appears on that team's Billing page.
