---
'@substrat-run/dashboard': patch
---

Documentation only: two open questions in the plan for retiring the dashboard's own directory are now answered, and the constraint that shapes the whole job is written down.

The audit trail in that directory — teams created, roles defined, scopes activated, plus the record of staff reads — will not be carried across or archived. It is the dashboard's own housekeeping record, nothing a customer sees and nothing another system reads, and the cutover is simply where that history begins. The plan notes when it stops being recoverable, in case that answer needs revisiting before then.

The constraint: the rows in question sit in storage that exactly one worker can address. Not the operator console, not the platform's own API, not a script with staff credentials. So the steps that move data have to execute inside that worker — which is what makes this a code change rather than something an operator can run; the later steps are deployment changes and are shipped normally. It also means the entry point those steps use is temporary by design, and goes away with the rest of it, rather than becoming a permanent privileged door for a job that runs a handful of times. The plan now also says where "every team" comes from: the local directory is enumerated once, and each team's rows are written through a handle pinned to that team.
