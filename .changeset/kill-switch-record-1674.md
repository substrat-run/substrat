---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/control-plane': patch
---

The schedule kill switch (#1666) is now recorded in the directory as well as in the scope,
so a switch survives a wiped or restored scope, and the fleet can be asked what is off.

The directory keeps one row per (tenant, scope, module) in a new `_substrat_system_switches`
table: the position the switch was last moved to, who moved it, why, and when. `revokeFromSystem`
writes it after the scope's switch held; `restoreToSystem` writes it before the scope moves,
and puts it back if the move fails. Both adapters build the table from one kernel fragment,
`SYSTEM_SWITCHES_DDL`, and backfill it once from the admin log, from the latest applied
`revokeFromSystem` / `restoreToSystem` per module, on the run that creates it.

`GET /system-switches` (staff and the service token only) is the fleet read: every scope with a
module switched off, paged by `operationId`, filterable by tenant, scope, module and vertical,
with `position=on` or `position=all` for the rest. `HostAdmin.listSystemSwitches` is the read
underneath it.

When the scope and the record disagree, OFF wins from either side, and the record never turns
anything on. `HostAdmin.reassertSystemSwitches` switches every module the record holds `off` back
off on one scope, after provisioning's seat, so the grants a wiped scope just had seated are the
ones it tombstones and a later `restoreToSystem` gives them back. It runs after a CP-full
`provisionScope`, after every hosted reconcile (the sweep, the repair route and the
set-entitlements drain), and after a staff restore. For a hosted scope it reaches the deployment
over the existing `/internal/system-switch` route, so no vertical needs redeploying. It is audited
as a new `reassertSystemSwitch` admin action, only when something moved.

The per-scope status read (`GET /tenants/:t/scopes/:s/system-grants`) gains `recorded` on each
entry, the directory's position beside the scope's own, and now also lists a module the record
holds that a wiped scope no longer reports, as `ungranted`.

`HostAdmin.listSystemSwitches` and `HostAdmin.reassertSystemSwitches` are required members: any
`HostAdmin` implementation outside this repository needs both.
