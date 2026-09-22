---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/vertical-host': minor
'@substrat-run/control-plane': patch
---

The schedule kill switch (#1666) gets a status read: "is this module switched off on
this scope?", without the scope's own SQL console.

`GET /tenants/:t/scopes/:s/system-grants` (staff/service only) answers, per module the
scope holds or has ever held system authority for, `on` / `off` / `ungranted` — the
kernel's `systemScheduleState`, the SAME predicate `runDueSchedules` gates on, so the
read and the runner cannot disagree — and, while `off`, who switched it off, when, and
why, from the admin log's `intent` row for the `revokeFromSystem` still in force.

`@substrat-run/kernel` adds `HostAdmin.systemGrantsStatus` (a required member — every
`HostAdmin` implementation, in or out of tree, needs one) and exports the enumerator it
is built from, `systemGrantsStatus`, plus its `SystemGrantsEntry` shape. `@substrat-run/contracts`
adds the two wire schemas: `systemScheduleEntry` (the bare position, no audit join — what a
vertical's own deployment can honestly answer for itself) and `systemGrantsStatusEntry`
(that plus `switchedOff`, the control plane's own answer).

For a hosted scope the read is delegated to the deployment serving it, exactly the way
`revokeFromSystem`/`restoreToSystem` delegate the write: `SystemSwitchDelegation` gains a
`status` method (`@substrat-run/adapter-cloudflare`), and `@substrat-run/vertical-host`'s
`mountPlatformSurface` adds `GET /internal/system-grants` against a new OPTIONAL
`VerticalScopeHost.systemGrantsStatusLocal` — a deployment built before this ships still
satisfies the interface, and the route answers 501, which `@substrat-run/control-plane-api`'s
new `VerticalClient.systemGrantsStatus` reports as "redeploy the vertical", the same
skew handling `systemSwitch` already gives the write (a 404, an SPA shell, or a 200 of
the wrong shape are all read as "this deployment predates the route", never a wrong `on`).

The admin-log join (who/when/why) happens only on the control plane — a vertical's own
deployment holds no admin log to join against, so `/internal/system-grants` and
`systemGrantsStatusLocal` answer the bare position (`systemScheduleEntry`) only.
