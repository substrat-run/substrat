---
'@substrat-run/contracts': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/cli': patch
---

A store's backup, restore, snapshot and pull hold one page at a time. A backup writes a store's pages as objects of their own with an index written last, and `POST …/backups/:capturedAt/restore` restores them, verifying each. What a request cannot finish runs as a job, answered 202. A full pull past 32 MB of store data refuses with 413, and no path exports such a store until links or a stream are decided. Older backups restore as before. `substrat scope restore` refuses a file of a paged backup, and prints what a failed restore left behind.
