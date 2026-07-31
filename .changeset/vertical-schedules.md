---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
---

A vertical can schedule its own recurring work (#383)

A vertical can now declare `schedules` in its module manifest — operations the platform
invokes on every live scope of it, on a cadence, driven by the existing platform sweep. It
is the seam a domain rule triggered by the passage of time (a contract that activates on its
start date, a leave that can no longer be approved once it has already begun) had no way to
reach: the operation was written, idempotent, and paged, but nothing woke it up on a date.

The work is attributed honestly. Rather than the out-of-band workaround of signing in as a
human and running under their permission — the attribution laundering #97 refused — a
schedule runs under a **system principal**, the third caller #97 named, built the same way it
built the connector seam:

- a new `{ kind: 'system', id: ModuleId }` check-subject, mirror of the connection subject;
- `ScopeHost.getSystemScope(moduleId, tenantId, scopeId)` — a door whose stub stamps
  `{ system: moduleId }` on events and resolves `system:<moduleId>` grants;
- `HostAdmin.grantToSystem(...)` — the scheduler analogue of `grantToConnection`, projected
  from a schedule's declared `permissions` at provisioning, so `ctx.check` stays the single
  gate and the grant appears in the reviewed permission diff. Revoking it disables the
  schedule for one tenant, no special flag.

`runPlatformSweep` gains a schedules phase (`registeredSchedules` / `runDueSchedules`) that
enumerates each vertical's live scopes and fires due operations under bounded concurrency,
skipping forks and any scope that does not hold the grant, recording per-scope outcomes in
`PlatformSweepReport.schedules`. All additive: a manifest that declares no schedules, and a
host predating the seam, behave exactly as before.
