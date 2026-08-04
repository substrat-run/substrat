---
'@substrat-run/control-plane': patch
---

The test control plane never drained platform-intents. Wrangler does not carry
the top-level `triggers` into a named environment, so `substrat-control-plane-test`
(deployed by CI on every green push to main) shipped with NO cron — its scheduled
pass, and with it the platform-intent drain, never ran. A `provision-tenant` intent
enqueued against a test-hosted scope sat `pending, attempts=0` forever (#444). Add the
same `*/15` `triggers` block to `env.test` that prod already carries. Separately, the
scheduled pass now logs `platformRequests` totals whenever there is drain activity
(drained/failed/still-pending), so a drain that silently never converges leaves a trace
in the tail instead of being invisible.
