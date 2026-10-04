---
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/kernel': patch
'@substrat-run/contracts': patch
'@substrat-run/control-plane-api': patch
---

A point-in-time rewind to before a schedule kill switch was pulled now keeps the module off for its job runs too, not only its schedules.

The hosted adapter's system door (`getSystemScope`) is where a module's own authority enters a scope: a schedule's fire, a resumable job run's `pass.scope()`, and a module's attachment open all go through it. The door now does the check a schedule pass already did. It reads the module's state from the scope, and for a module that is on, it then reads the rewind hold. A module the hold keeps off is refused with `forbidden`.

A job pass can run for a long time after it opens the door, so each call through the door is pinned to the scope instance the door checked. A rewind always restarts the scope. A call that lands on a different instance is refused before anything opens, then checked again and retried. If the scope keeps restarting, the call fails closed with `unavailable` after a bounded number of checks. The scope also refuses any call that acts as a module without passing the door. Under a rolling deploy, that can briefly refuse a worker still running the previous version.

A held module and a scope that keeps restarting both mean "not now": nothing ran. The host's door marks each of these refusals with the job pass whose call produced it, and the job driver defers a pass only on a refusal marked for that same pass. The mark is consumed as it is taken. The driver never defers on an error's shape, since any step or operation can throw the same public reason (`system_door_wait`, the kernel's `SYSTEM_DOOR_WAIT`, which `unavailable` can now carry as well as `forbidden`). A refusal kept by a handler and thrown again on a later pass counts as an ordinary failure. A deferred run keeps its attempts and its last error, and is due again after `JOB_DEFER_MS` (one minute). That wait is not an attempt and has no backoff. `JobDriveReport` gains a `deferred` count.

The job driver now takes due runs in the order they became due (`JOB_RUN_DUE_AT`, which is `next_attempt_at`, or the start time when there is none, then id), on both adapters, backed by a new `_substrat_job_runs_due_at` index. Before, it took them by age, so an older run that kept waiting (a deferral or a retry backoff) headed every drive and could take the turn of a run that had been due longer. Each drive now picks its runs from one snapshot: the keys of the due runs, read in a single query (the store port's `due` becomes `dueKeys`). It then reads each run again as it claims it, and skips one that is no longer running or no longer due. Within one drive a run is never taken twice and never skipped by paging. A run that moves, or becomes due, after the snapshot is left for the next drive.

The scope answers a call pinned to the wrong instance with a dedicated `systemDoorMoved` field, never with an error, so an operation's own error is never mistaken for one, whatever its text.
