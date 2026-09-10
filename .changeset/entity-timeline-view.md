---
'@substrat-run/dashboard': minor
---

One record's story is on screen (#1235, completing it). Clicking a row's `id`
in an app's Data tab opens its history: every event, with the payload, who
acted, the permission that authorized it, the staff member behind an
impersonation, the PII class, the operation it was emitted from and the version
that code was deployed as.

`readHistory` has carried all of this since #800 and no screen rendered it. The
renderer keeps its three nullables apart, because each is a fact rather than a
gap: a null payload reads "payload erased" (a shred keeps the row and drops the
content), a null authorization reads "authorization unrecorded" — distinct from
an empty list, which reads "no permission checked" — and a null impersonation
simply shows nothing, because nobody impersonating is the ordinary case.

The entity type is derived from the emitted model's table mapping, so the id
column only becomes clickable for a table the model names. An empty history
states the type and id it looked under, so a vertical whose events name a
different entity type than its model reads as "no events recorded for X" rather
than the confident and wrong "nothing ever happened to this record".
