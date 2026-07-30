---
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/adapter-sqlite': patch
---

Defer foreign keys across the restore's DROPs, not just its inserts (#348, follow-up to #339).

#339 wrapped the INSERT phase of a scope restore in `defer_foreign_keys`, so a dump whose
child table sorts before its parent replays cleanly. It left the opening DROP sweep outside
the deferral.

`DROP TABLE` performs an implicit `DELETE FROM`, so dropping a parent while a child table
still holds rows raises `FOREIGN KEY constraint failed` before any replacement row exists.
That bites only when the TARGET already holds data, which is why it hid behind the first
fix: an empty scope drops cleanly, and overwriting populated data is the whole point of
restore. In the field it made `substrat scope restore` fail against any scope already
holding FK-related rows, with the same bare constraint error #339 was believed to have
fixed.

The whole drop-then-replay now runs in one transaction with `defer_foreign_keys` set before
the first DROP, so every check lands at commit — by which point the old rows are gone and
the new ones are in. Both adapters; they are in the same fixed version group, so both move
together.

The regression test creates the PARENT first and restores twice, because `sqlite_master`
lists tables in creation order and a child-first dump drops child-first, never tripping the
hazard. It was verified to fail with the drop-deferral removed and the insert-deferral left
in place.
