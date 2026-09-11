---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
---

The outbox can be drained (#1334, the scope-side half of Tier 2). Two new
`HostAdmin` verbs on both adapters: `readUndrainedEvents` reads the events a
scope has not shipped yet — `drained_at IS NULL`, the column the spine has
carried since the outbox shipped and nothing has ever written — and
`markEventsDrained` stamps them once a sink has accepted them.

They are separate verbs deliberately. Marking before shipping loses events when
the sink fails; shipping before marking can repeat them, and a repeat is
harmless — the lake is keyed by event id and every consumer here is already
required-idempotent. At-least-once is the only one of the two that cannot
silently lose exact history, which is the whole point of the tier.

A drained event carries the full envelope plus the two dimensions that live only
on the column: the emitting `operation` and the `version` the code ran as, which
#1250 keeps off the envelope on purpose. It also carries `subjectId`, the
pseudonymous erasure key — shipping payloads out of the scope without the key
that can find them again would put personal data somewhere an erasure cannot
follow.

Marking only ever stamps an UNDRAINED row, so a replayed batch cannot move an
earlier drain's timestamp forward and misreport when a lake row shipped. It
returns how many rows it actually stamped, which is what makes that idempotence
observable — and what the receipt below is written from.

Declaring a batch shipped is now audited. Domain payloads leaving the platform
are an egress, and a larger one than the access log's metadata, so the admin log
gains a `drainEvents` action recording who declared it, for which scope, and how
many rows it covered — the same evidence `drainAccessLog` already carries one
tier up. A retried pass that re-marks a batch it already shipped changes nothing
and records nothing, so the log never grows a row claiming an egress that never
happened.

The spine gains an index on `(drained_at, id)`. The drain reads
`WHERE drained_at IS NULL ORDER BY id`, and no existing index started with that
column, so SQLite walked the primary key from the oldest event forward. A drain
retains what it marks, so that prefix only grows: finding the next batch would
have cost more as a scope aged, regardless of how far behind the drain was.

No sink yet, and nothing is wired into a sweep: this is the half that needs no
infrastructure.
