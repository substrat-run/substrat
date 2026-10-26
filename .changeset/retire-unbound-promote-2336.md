---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/control-plane-api': minor
---

Promoting a version whose permission or migration digest changed now requires the review binding alongside its acknowledgement. A client that sends a bare acknowledgement receives `precondition_failed` with an instruction to upgrade to CLI 0.45.0 or later and retry with the current review. The review gate is shared by both scope hosts; no CLI floor or version negotiation is added.
