---
'@substrat-run/kernel': minor
'@substrat-run/contracts': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
---

A subject erasure now reaches the spine's second copy of an event. `shredSubject`
redacted `_substrat_outbox` and nothing else, but a host with no control plane cannot
run a connector, so each connector delivery becomes a `connector:<provider>` platform
intent whose payload is the whole event — and nothing ever deletes those rows. A name
therefore survived the erasure in the live scope database, and in every export, backup
and PITR window taken from it afterwards. Both tables are redacted now, in one pass.

The intent's `payload` column is `NOT NULL`, so it is replaced by an obviously-redacted
tombstone rather than nulled; `last_error` goes with it, being free text a provider
wrote about this person; and a still-pending intent is settled `failed` in the same
statement, so nothing is ever handed a tombstone to drain. The row itself stays, so the
journal still shows that something was asked of the platform, by whom, and when. Which
intents are selected is the outbox's own predicate — the subject, and a `piiClass` other
than `none` — read off whatever event the payload embeds, so a copy is never judged more
harshly than the original. `SubjectShredReceipt` gains `intentsRedacted` beside
`eventsRedacted`, defaulted so an older receipt still parses.
