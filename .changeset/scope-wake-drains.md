---
"@substrat-run/kernel": minor
"@substrat-run/adapter-cloudflare": minor
"@substrat-run/control-plane-api": minor
"@substrat-run/control-plane": patch
---

A hosted scope with work for the platform now wakes itself (K-69, step 4 of the tenant-scale RFC). After a commit that enqueues a platform intent or leaves an event unshipped, the scope arms its alarm and asks the control plane for its own drain, within seconds for an intent and within five minutes for the lake. While the work stays, it looks again on a back-off capped at 15 minutes. A scope with nothing pending arms nothing, so an idle scope costs no request. The control plane's `SCOPE_WAKE_PHASES` (`platform-requests`, `events`, unset by default) hands each phase to the scopes: the per-scope drain object then ships the scope's events to the lake too, and the scheduled pass only checks, leaving work younger than an hour to its scope and draining older work as before. Each check is logged as `scope-wake-check`. The kernel exports `drainScopeEvents`, the pass's event drain takes `eventDrainCheck`, and the intent drain takes `holdFrom` and reports `leftToScope`.
