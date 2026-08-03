---
'@substrat-run/adapter-cloudflare': minor
---

Registering a login as an employee grants it self-service (an employee can report their own time).

Logging time goes through `time:report` **narrowed to the caller's own employee record** — a
permission that lives in no role (an hr-admin holds `time:read`, never `time:report`). That grant
was only ever issued by the demo seed, so on a real install `hr/create-employee` stored your
`principalRef` but never granted anything: you'd land on "My work" yet every `hr/log-time` was
denied. The tab was on, the grant was not.

- **`adapter-cloudflare`** gains `CloudflareScopeHost.grantEntityLocal(scope, principal, permission,
  entity)` — the CP-less, entity-narrowed sibling of `assignScopeRole`. Where a role reaches every
  entity in the scope, this reaches exactly one, writing the same
  `(principal:<id>, granted:<perm>, <type>:<id>)` tuple the local checker's entity walk reads, so a
  grant issued here resolves identically to one the control plane fanned out.
- **Meridian** (`demos/meridian`, private): when `hr/create-employee` runs with a `principalRef`, the
  worker (and the SQLite dev server, via `host.admin.grant`) issues that principal the
  `EMPLOYEE_SELF` grants on the new record — only ever reached by a caller who already passed the
  operation's own `employee:manage` check, so no fresh authority is minted. The People screen adds a
  "This is me — link my login" affordance so an admin can register themselves as an employee and
  report their own time, leave and expenses.
