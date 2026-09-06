---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
---

An operation's emitted events now name it (#1231). The outbox envelope gains an
optional `operation` — the exact `invoke()` string (`ticket0/answer`,
`attachments.upload`; a scheduled emit carries the schedule's own operation) —
stamped kernel-side on the K-34/K-42 pattern, so module code can neither forge
nor suppress it. Both adapters store it in a new nullable `_substrat_outbox`
column, ALTERed into existing scopes; a legacy row reads as unrecorded.

A CONSUMER-emitted event deliberately stays unstamped: a consumer runs on behalf
of no operation, and NULL says so — no synthesized pseudo-name pollutes the
dimension. `readHistory` surfaces the field on `historyEntry` (`operation:
string | null`, whose null honestly carries both "consumer emit" and "predates
the column"); the thin `timelineEntry` deliberately does not.
