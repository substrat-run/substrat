---
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/kernel': patch
'@substrat-run/control-plane-api': patch
---

A point-in-time rewind to before a schedule kill switch was pulled now keeps the module off for its job runs too, not only its schedules.

The hosted adapter's system door (`getSystemScope`) is where a module's own authority enters a scope: a schedule's fire, a resumable job run's `pass.scope()`, and a module's attachment open all go through it. The door now does the check a schedule pass already did. It reads the module's state from the scope, and for a module that is on, it then reads the rewind hold. A module the hold keeps off is refused with `forbidden`. A job run records that refusal as its last error and retries it, the same way it treats an OFF denial, and it completes once the switch is applied again.

A job pass can run for a long time after it opens the door, so each call through the door is pinned to the scope instance the door checked. A rewind always restarts the scope. A call that lands on a different instance is refused before anything opens, then checked again and retried. If the scope keeps restarting, the call fails closed with `unavailable` after a bounded number of checks. The scope also refuses any call that acts as a module without passing the door.
