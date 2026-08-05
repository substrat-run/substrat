---
'@substrat-run/console': patch
---

Console: give a stranded `provisioning` scope an escape hatch instead of a dead-end
(#500, proposal 5 — the last open item after #505/#507 covered proposals 1–4).

A scope stuck in `provisioning` (a failed migration or a dispatch gap can strand one
indefinitely) offered *no* lifecycle action in the scope detail view, even though the
server permits `provisioning → archived` (`host.ts` `archiveScope`) and bulk Prune
already relies on that edge. The client was stricter than the server, so a single
stranded scope could not be retired from the console.

- `availableActions('provisioning')` now returns `['archive']` — archive abandons it,
  and once archived it can be reaped. `archiving` (genuinely mid-flight) and
  `suspended-via-tenant` (the lever is the tenant, not the scope) stay action-less by
  design, each with an explanatory note.
- The provisioning note in the scope detail view now explains the stall and that
  Archive abandons it, rather than the old "actions available when it settles" line.
- New `fleet.test.ts` pins the console's transition graph as a **subset** of the
  server's legal transitions (so a rendered button can never 409) and locks in the
  provisioning escape hatch.
