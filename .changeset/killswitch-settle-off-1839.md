---
'@substrat-run/adapter-cloudflare': patch
---

A module switched off while its scope is being rewound to a point-in-time bookmark now stays off after the rewind lands. Before, the rewind held only the modules that were off when it started. A switch pulled during its three-second wait was written into storage the rewind then discarded, and the deployment ran that module's schedules until the platform's next sweep switched it off again. Now that switch joins the rewind's hold. The rewind then waits until the joined module has been held for a full three seconds before it rewinds, which can add up to about three seconds for each late switch, and at most about nine seconds in all. One narrow case remains: a switch pulled in the few milliseconds just before the rewind takes effect is held, but for less than that wait. A schedule pass that read the hold just before that moment can then run the module once.
