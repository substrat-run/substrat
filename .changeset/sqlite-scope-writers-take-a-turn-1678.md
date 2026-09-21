---
'@substrat-run/adapter-sqlite': patch
---

On the SQLite host, a scope-level admin write no longer rolls back with an unrelated operation.

`invoke` keeps its transaction open on the scope's connection while the operation awaits. Before
this change, an admin write issued in that window ran inside that transaction. If the operation
then failed, the write was undone, even though the verb had already returned success and written
its audit row. The affected writes were:

- `grant`, `grantToConnection` and `grantToOrg` on a scope. For a connection, this could leave
  the directory record naming a grant that the scope no longer held.
- `assignRole`, and `unassignRole`. An undone unassign left the role in force.
- The schedule grants that `provisionScope` seats.
- `markEventsDrained`. An undone mark caused the lake to receive the same batch a second time.
- `redrainEvents`.
- The run record written by `runDueSchedules`. If it was undone, the schedule ran again on the
  next pass.
- The state row written by `checkFreshness`.
- `shredSubject`. An undone erasure brought the payloads back after the subject's key had been
  destroyed.
- `restoreScope` and `importScope`.

Each of these writes now waits for the operation on that scope to finish, and only then runs.
A write started from inside one of the scope's own operations still runs as part of that
operation, so it cannot deadlock. The Cloudflare host already queued these writes behind
`invoke`, and it has not changed.
