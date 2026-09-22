---
'@substrat-run/adapter-sqlite': patch
---

On the SQLite host, an admin read no longer sees an operation that has not committed yet.

`invoke` keeps its transaction open on the scope's connection while the operation awaits. Before
this change, every admin read of a scope ran on that same connection, so a read in that window saw
the operation's uncommitted rows. If the operation then failed, the read had reported rows that
never existed. For `readUndrainedEvents` the result was permanent: the lake drain shipped an event
that later rolled back, and the lake keeps everything it is sent.

The reads now use a separate read-only connection to the scope's file, which sees only committed
data. That covers `readUndrainedEvents`, `exportScope` (and so `snapshotScope`), `facetEvents`,
`entityHistory`, `eventCause`, `eventEffects`, `invocationEvents`, `deadLetters`,
`listScopeTables`, `readScopeTable`, `queryScope`, `listDenials`, `summarizeDenials`,
`scopeAppliedMigrations`, `scopeDatabaseSize` and the count-only `redrainEvents`. It also covers
the host's `listPlatformRequests`, `listPlatformRequestHistory`, `executorDeadLetters` and
`connectionGrantsInScope`. The checks `runDueSchedules` makes before firing a schedule (whether it
is switched on, and when it last ran) now wait for the operation on that scope to finish, the way
its writes already did.

A read made from inside one of the scope's own operations, or from an executor, still sees that
operation's own uncommitted writes, as before. The host keeps at most 32 read connections open at
once and closes the least recently used one when it needs another.
