---
'@substrat-run/kernel': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/vertical-host': minor
---

A CP-less deployment judges the role set a provision, a reconcile or a restore writes inside the transaction that writes it (#2531).

- **adapter-cloudflare, provision and repair.** `provisionScopeLocal` and `projectRolesLocal` judge their role set again inside the projection's own unit, against the roles, tombstones and seats the scope holds as it writes, so a seat made after the first check is seen. Refused: `forbidden`, nothing written (no role row, tombstone, owner seat, receipt or enforcement flip). On a provision the module migrations have already run by then, as before.
- **adapter-cloudflare, restore.** `restoreScopeLocal` and `restoreStagedScopeLocal` take an optional `roles` (with `tenantId`): the role repair is judged on the seats the dump has just brought and projected in the load's own transaction, answered `rolesProjected: true`. Refused: `conflict`, the scope keeps its rows and a staged load its stage.
- **The refusal** is one fixed sentence naming the role key only: `role '<key>' is refused by the reserved-key rule, judged against the roles and seats this scope holds as the write lands (K-55); nothing was written`.
- **Version skew.** The judged calls are new ScopeDO methods (`applyJudgedProjectionReply`, `importDumpJudged`, `commitStagedDumpJudged`): a host meeting an older ScopeDO is refused with nothing written. The old methods stay and behave as before. The directory fan-out is not judged (K-55).
- **vertical-host.** `/internal/restore` and `/internal/restore-staged` hand the vertical's roles to the load, and repair with `projectRolesLocal` only when the load does not answer `rolesProjected: true` (an older adapter, or a retry answered as already applied).
- **kernel.** `reservedRoleSetRefusedRole` (the set's walk, with the refused role's key) and `inUnitRoleRefusal` (the sentence).
