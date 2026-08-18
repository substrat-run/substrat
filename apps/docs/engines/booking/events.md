---
description: "The twelve events the booking engine emits, from `booking.held` to `booking.no-show`, and the PII split that keeps participant identity out of every payload. Consumes nothing."
---

# Events

## Emitted

| Event | When |
|---|---|
| `booking.resource-created` | a bookable resource is added |
| `booking.held` | a tentative hold is placed |
| `booking.confirmed` | a hold becomes firm |
| `booking.expired` | a lapsed hold is surfaced |
| `booking.cancelled` | held or confirmed → cancelled |
| `booking.moved` | rescheduled — carries `from` and `to` |
| `booking.started` | service begins |
| `booking.completed` | the terminal success transition |
| `booking.no-show` | the party did not turn up |
| `booking.participant-joined` | someone joined |
| `booking.participant-left` | someone left |
| `booking.opened` | places were put on offer on an existing reservation, or withdrawn |

Consumes nothing.

## The PII split that shapes every payload

Three platform rules collide here, and the resolution is worth understanding before you
write a consumer.

Fat events are required. A match may have four participants. And the event envelope permits
**exactly one** `subjectId`, mandatory whenever `piiClass !== 'none'`, because crypto-shredding
must be able to key the erasure. A four-person roster cannot be keyed to one subject, and the
envelope has no plural.

So the roster does not ride the aggregate event:

| Event | `piiClass` | Carries |
|---|---|---|
| `participant-joined` / `-left` | `pseudonymous`, `subjectId` = that party | the one `partyRef` + share |
| every reservation lifecycle event | `none` | resource, interval, quantity, **`participantCount`** |

This is better privacy design than the alternative, not a workaround:

- **The club's business record survives an erasure.** "Court 1 was booked 17:00–18:30 and
  completed" names nobody, so it is retained as a legitimate business record while the
  personal link is shredded with the per-participant events.
- **Each pseudonymous fact is individually shreddable**, keyed to exactly the subject it
  concerns — which is what the envelope was asking for.
- **`partyRef` is a `DataSubjectId`**, not a free string. Participants are people; the type
  says so.

### Reconstructing a roster

Correlate `participant-joined` / `-left` with the lifecycle event on `reservationId`. That is
ordinary stream processing over one module's own events — **not** a cross-module read, so the
fat-event rule is intact.

### Split billing does not need this

A vertical composes invoicing's in-scope functions in the **same transaction**, where it
already holds the roster. It never needed the event.

## No `booking.match-played`

`booking.completed` is the same fact. One transition should not emit two events; a vertical
wanting match vocabulary emits its own.

## Evolution rules

- Payload fields are **frozen once shipped**. Rename, remove or retype means a
  `schemaVersion` bump and dual-emit through a deprecation window.
- New operation inputs are optional with behaviour-preserving defaults.
- Permission keys are never renamed.
- Consumers parse payloads with their own Zod schema, never the producer's types.
