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
earlier drain's timestamp forward and misreport when a lake row shipped.

No sink yet, and nothing is wired into a sweep: this is the half that needs no
infrastructure.
