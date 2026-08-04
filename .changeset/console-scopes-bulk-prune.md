---
'@substrat-run/console': minor
---

Scopes view: a bulk **Prune** action for retiring dead scopes in one pass. The
existing bulk levers only fan out lifecycle transitions, which leaves two kinds of
scope stuck: a **snapshot fork** (has no reap transition — it is deleted, not
reaped) and a **provisioning** scope (`availableActions` offers it nothing at all).
Prune spans both: for every selected scope with no active app — a fork, or an
archived/provisioning row — it releases the hostnames first (satisfying the reap
guard), then deletes a fork outright and archives-if-needed → reaps the rest. Live
`active` and `suspended` scopes are never included. It arms behind the same
type-the-count gate as bulk reap (it, too, wipes storage with no restore) and lists
every affected scope, tagged fork/status, before it fires. Each step stays its own
audited control-plane call — no new bulk API surface.
