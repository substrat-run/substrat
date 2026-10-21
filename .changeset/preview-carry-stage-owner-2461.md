---
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/control-plane-api': patch
---

Keep a destination's single staged copy owned by the first carry until it finishes or expires. A concurrent carry of the same preview version receives the running copy's progress, or a retryable refusal while that copy starts. Discard names only its own stage, and a stage left after the copy's deadline and leases can be reclaimed.
