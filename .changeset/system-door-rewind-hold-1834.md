---
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/kernel': patch
'@substrat-run/contracts': patch
'@substrat-run/control-plane-api': patch
---

A point-in-time rewind to before a schedule kill switch was pulled now keeps the module off for its job runs too, not only its schedules.

The hosted adapter's system door (`getSystemScope`) is where a module's own authority enters a scope: a schedule's fire, a resumable job run's `pass.scope()`, and a module's attachment open all go through it. The door now does the check a schedule pass already did. It reads the module's state from the scope, and for a module that is on, it then reads the rewind hold. A module the hold keeps off is refused with `forbidden`.

A job pass can run for a long time after it opens the door, so each call through the door is pinned to the scope instance the door checked. A rewind always restarts the scope. A call that lands on a different instance is refused before anything opens, then checked again and retried. If the scope keeps restarting, the call fails closed with `unavailable` after a bounded number of checks. The scope also refuses any call that acts as a module without passing the door. Under a rolling deploy, that can briefly refuse a worker still running the previous version.

Each of these refusals means "not now": nothing ran. They carry the reason `system_door_wait` (the kernel's `SYSTEM_DOOR_WAIT`, which `unavailable` can now carry as well as `forbidden`). The job driver defers a pass refused this way: the run is left exactly as it was, with no attempt counted and no backoff. Waiting out a hold or a deploy therefore never spends a run's retry budget, and the run proceeds on the first drive after the wait ends. `JobDriveReport` gains a `deferred` count.
