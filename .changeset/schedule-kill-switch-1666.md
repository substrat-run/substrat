---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/contract-tests': minor
'@substrat-run/vertical-host': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/control-plane': patch
---

A scope's schedules now have an off switch that holds. `HostAdmin.revokeFromSystem` turns
one module's scheduled work off on one scope, and `restoreToSystem` turns it back on. Both
take a required `reason`, and both write an admin-log row. Staff reach them over HTTP as
`DELETE` and `POST` on `/tenants/:tenantId/scopes/:scopeId/system-grants`, with the body
`{ moduleId, reason }`.

- **Module-wide, on one scope.** Schedules share permissions, so switching off one schedule
  or one permission would either switch off its siblings too or make it fail on every pass.
- **Nothing fires while it is off.** `runDueSchedules` reports each schedule as `skipped`,
  with `switchedOff: true` on the report. It is never `failed`, and the cadence clock is left
  alone, so a due schedule fires on the first pass after the restore.
- **It is a kill switch, not a pause.** The module's `system:` grants on the scope are
  revoked too, so a job run acting with that authority is denied by its own check.
- **Restore is the lever; a grant is not.** The off position is its own marker tuple. A
  reconcile, including one that grants a permission a newer version declares, leaves it off.
  So does a `grantToSystem`, which still re-grants its one tuple, as before.
- **Hosted scopes.** The switch is moved in the vertical's own deployment, over the new
  platform-secret `/internal/system-switch` route. A deployment built before that route
  answers with a 501 that says to redeploy, and nothing is switched.
