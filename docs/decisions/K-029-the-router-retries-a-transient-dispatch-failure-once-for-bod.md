---
id: K-29
date: 2026-07-20
layer: kernel
title: "The router retries a transient dispatch failure once, for bodyless requests only; readiness…"
status: accepted
aliases: []
tracking: []
---
# K-29 — The router retries a transient dispatch failure once, for bodyless requests only; readiness…

**The router retries a transient dispatch failure once, for bodyless requests only; readiness is tolerated, not proven** (K-28's second finding). There is no propagation-complete signal to wait for — Cloudflare exposes no such API — so a fixed delay is a guess that verifies nothing, and a single health probe is worse than useless here: at the same instant on the same script one scope returned 200 while another returned `Worker not found.`, so one probe would have reported ready. What IS checkable is per-scope, since the failing unit is (script, colo) and the colo follows the DO — but that only covers scopes that already exist, because a scope created after promotion places its DO fresh. **So the mitigation is a bounded retry rather than a gate.** Cloudflare's documented advice for this error is to return 404, which is right for a script that is genuinely absent and wrong during the window — it converts a self-healing gap into a hard failure for whichever tenants land in a cold colo. **Bodyless requests only**: a retry is safe only when the first attempt provably had no effect, and if the failure came after the request reached the vertical, replaying a POST runs the mutation twice. A page load is what a person sees fail; a double-charged customer is worse than a 502. Bounded at one retry, so a deleted vertical or a stale channel pointer fails fast instead of hanging

## Why

Chosen partly because it survives being WRONG: the colo-propagation explanation is an inference from the symptom, not something Cloudflare documents, and a retry does not depend on that diagnosis holding, whereas a delay tuned to a guessed mechanism does. Note what this is NOT — it does not make promotion safe, it makes the window survivable. Probing each bound scope before moving a channel pointer is still worth doing once the orchestration layer exists, and a `deploymentStatus` on `verticalVersion` becomes a nice-to-have rather than the only thing standing between a promotion and a broken tenant. **Armed, not active**: the router dispatches through a static service binding today, and `Worker not found.` is a dispatch-namespace error, so this cannot fire until the Workers-for-Platforms swap lands. Written and tested now because the knowledge was expensive and perishable — it came from a live deployment rather than a document, and would otherwise be rediscovered from a customer
