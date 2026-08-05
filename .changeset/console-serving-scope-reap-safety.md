---
'@substrat-run/console': minor
---

Scopes view + detail: make a **serving** scope's danger visible before an operator can
reap or archive the wrong one (#500). The mechanical guard already refuses reaping a
bound scope (#501); this is the UX half that keeps the operator from reaching that
refusal on a live install in the first place.

- **A "Serving · N" badge** on every scope that resolves ≥1 hostname — in the list's
  status cell and the detail's identity grid — so a live production install no longer
  reads like the archived test cruft beside it. The detail also names the canonical
  hostname.
- **Reap on a still-bound scope becomes an explicit "Unbind N & reap"** rather than a
  bare slug confirm that 409s: the dialog names the hostnames it will release, warns the
  app goes offline for good, and (once armed) unbinds them before wiping — the same
  order the bulk Prune lever uses.
- **Archive now confirms through a dialog** that names the hostnames going dark, since
  archiving a serving scope is an outage (reversible, but still). A scope with no
  bindings says so and archives without friction.
- **Bulk reap flags still-bound targets** ("serving N, will be refused") and steers to
  Prune, instead of letting the operator watch them fail one by one.

Hostname joins reuse the fleet bindings App already loads; no new fetch. `availableActions`
is unchanged — `provisioning` scopes have the Prune path (#505) and a cascade-suspended
scope is explained in the detail, so neither is the silent dead-end it was.
