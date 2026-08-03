---
'@substrat-run/adapter-cloudflare': minor
'create-substrat': minor
---

`defineScopeSweeperDO` — the timer a CP-less vertical owns (#461, closing the trigger
half). `runPlatformSweep`'s drain and schedule phases enumerate scopes via the
control-plane directory, which a CP-less dispatch vertical does not have — so its
declared schedules parsed, granted, and never ran. The new singleton DO keeps a roster
of the deployment's scopes (fed by the platform through `/internal/provision` and
`/internal/reconcile` via `noteScope`, pruned by `/internal/delete-scope` via
`forgetScope` — forks stay off by construction, since a snapshot target is never
provisioned) and alarm-drives each rostered scope's `drainDue` + `runDueSchedules`
through the deployment's own host, with the same non-overlap/never-dies loop as
`definePlatformSweeperDO`. The alarm lapses on an empty roster and re-arms on the
next `noteScope`, so an idle deployment costs nothing. The create-substrat template
wires it by default: a `SWEEPER` store in `substrat.runtimeNeeds`, the three route
calls, and the kernel-line pin moves to the release that ships the sweeper.
