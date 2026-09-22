---
'@substrat-run/kernel': minor
'@substrat-run/contracts': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
---

A subject erasure now reaches two more places a copy of the person could survive.

A redacted platform intent's `result` is redacted too. It is whatever the drain's handler
returned, and for a connector that is the provider's answer about delivering this person's
data, so it could quote them. A non-NULL `result` now becomes the same tombstone as the
payload, and a NULL one stays NULL. `last_failure` is nulled beside it: it attributes
`last_error`, and once `last_error` is the redaction note, a kept `origin: 'provider'` would
caption the platform's note as the provider's words.

The resumable run tables, `_substrat_job_runs` and `_substrat_job_steps`, are reached for
the first time. A run carries no subject column, so the erasure uses the link it already
uses for intents: a copy of an event classified as the subject's, at any depth, in the
run's payload, its cursor or a step's stored result. Each such column is replaced by the
tombstone and the row's `last_error` by a note. A run still in progress is settled
`failed`, so no pass is handed a tombstone as a step's answer. A pass that was mid-flight
when the erasure landed can no longer write its cursor, its status or a fresh step result
back over the redaction, because both writes are now a compare-and-set on the run still
being `running`. What this does not reach is external output that names the person with
no classified event around it. That is stated as a limit in the kernel design, and
declaring a subject on a run is the open design that would close it.

A failed delivery of one of the subject's redacted events has its error text replaced by a
note, because a consumer's or executor's throw can quote the payload it failed on. A
delivered row is left alone, since an error there would mark it dead-lettered.

`SubjectShredReceipt` gains `jobRunsRedacted`, counted once per run however many of its
columns and steps were rewritten, and defaulted so an older receipt still parses. On the
hosted adapter, an erasure against a scope whose host predates this change is refused
with a `503` before the subject key is touched, as it already was for a host that
predates the intent redaction, so it can be re-run after a redeploy.
