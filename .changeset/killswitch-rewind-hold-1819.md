---
'@substrat-run/adapter-cloudflare': minor
---

A module switched off with the schedule kill switch now stays off when its scope is rewound to a point-in-time bookmark from before the switch was pulled. Before, the rewind brought the module's schedules back, and the deployment ran them until the platform's next sweep switched the module off again, which could take about 15 minutes. Now the rewind holds the modules the scope had switched off, and their schedules stay off until the switch is back in the scope. That happens when the platform re-asserts it or reconciles the scope, or when an operator switches the module back on. A rewind of a scope with a module switched off takes about three seconds longer. A vertical gets this once it is redeployed on this release. Cloudflare only: the SQLite host has no point-in-time rewind.
