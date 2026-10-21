# Events

## Emitted events

All ten events have `schemaVersion: 1`. Import `NotificationsEvents` from
`@substrat-run/engine-notifications` for a vertical's consumers.

| Event | What it reports |
|---|---|
| `notifications.delivery-recorded` | Delivery id, topic, principal, channel, initial status/reason, send request, dedupe key and `about` reference |
| `notifications.delivery-settled` | Delivery id, topic, principal, channel, final status, platform outcome code and send request |
| `notifications.preference-set` | Principal, topic, channel and enabled flag; optional cadence and withdrawn delivery ids |
| `notifications.recipient-updated` | Principal and `hasAddress`, never the address |
| `notifications.topic-recorded` | Topic, description and required flag |
| `notifications.digest-sent` | Principal, channel, cadence, digest delivery and request, status/reason and carried occasions |
| `notifications.digest-failed` | Principal, channel, cadence, held item count, error code and retry time |
| `notifications.digest-quarantined` | Principal, channel, identifiable occasion delivery ids and count of unidentified rows |
| `notifications.digest-released` | Principal, channel and occasion delivery ids held again |
| `notifications.digest-withdrawn` | Principal, channel and occasion delivery ids withdrawn unsent |

A carried occasion names its delivery id, topic, dedupe key, `about` reference and
queue time. `digest-sent` means a digest was composed and recorded, not that a provider
accepted it: its delivery can be `requested` or `skipped` for lack of an address.
The platform outcome settles a requested digest later.

No event carries an address or rendered message. Events naming a principal are
pseudonymous and use that principal as `subjectId`; `topic-recorded` names nobody.

## Consumed outcomes

| Event | Settles delivery as |
|---|---|
| `email.sent` | `sent` |
| `email.refused` | `refused` |
| `email.dead-lettered` | `dead_lettered` |

The engine correlates outcomes with the platform send request. Your vertical consumes
its own domain events and calls `notify`; the notifications engine itself consumes
only these three email outcomes.
