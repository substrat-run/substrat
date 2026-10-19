---
status: built
layer: kernel
description: Turning an occasion a vertical names into email — preferences, templates, tracked deliveries.
---

# `engine-notifications` — an occasion, turned into email

Status: **built** — in the repo, composed by the Handlebar demo; not yet published to npm

> Placement and reasons: [K-47](../decisions/K-047-notifications-are-an-engine-composed-by-call-the-kernel-s-part.md).
> Implementation of [#118](https://github.com/substrat-run/substrat/issues/118). The package's
> own README (`engines/notifications/README.md`) is the composing guide.

The engine is composed **by call**. A vertical decides when a notification is due, usually
in its own consumer of a domain event, and calls `notify(ctx, { topic, description,
recipients, template, vars, dedupeKey, about, required? })` in its own transaction. For each recipient,
`notify`:

- applies the person's mutes, unless the topic is required;
- looks up their address;
- renders the template, escaping every variable;
- writes a send intent with the kernel's `requestEmail`;
- records a delivery, unique per (dedupe key, topic, principal, channel).

A topic is recorded on first use and follows its latest caller, which is coherent only under
**one topic, one declaration**: every call site for a topic passes the same `description` and
`required`.

The engine's only consumers are the three `email.*` outcome events. They settle the deliveries
when the platform's drain writes the outcome back.

**Digests.** A person can take a topic as a `daily-digest` instead of `immediate`, unless the
topic is required. `notify` then records the occasion `skipped` with reason `digest` and holds
the rendered message. The engine's manifest declares a daily schedule,
`notifications/send-digests`, run by the engine's system principal under
`notifications:send-digests`, a key reserved to system principals. It sends each person one mail
of what was held, through the same `requestEmail` and delivery row, under the reserved topic
`@digest`, and emits `notifications.digest-sent` naming the occasions carried. A mute still
wins: switching a topic off withdraws what is held for it. The digest adds no wording of its
own: one held message goes out as it is, and several go out under the first one's subject with
`(+N)`.

What it holds:

| Table | What | Erasure |
| --- | --- | --- |
| `notifications_topics` | each topic this scope has used: description, required | none: names nobody |
| `notifications_recipients` | one address per principal | deleted with the principal (K-46) |
| `notifications_mutes` | a topic a person switched off, per channel | none: no personal data beyond the principal id |
| `notifications_deliveries` | what became of each (dedupe key, topic, principal, channel); a digest is one more, under topic `@digest` | none: principal and request id only, never the address |
| `notifications_cadences` | a topic a person takes as a digest, per channel; no row is `immediate` | none: no personal data beyond the principal id |
| `notifications_digest_items` | each rendered message held for a person's next digest, deleted when it is sent | deleted with the principal (K-46) |

A vertical composing it needs the `emailSender` grant: without it the platform refuses
every send, and each delivery settles `refused` with reason `permission_denied`.

The send intent carries the recipient as its `subjectId`, so a subject erasure cancels a send
that is still held.

Not built, in the order a vertical is expected to ask for them:

- channels beyond email;
- tenant-edited and per-locale templates, a digest's own wording among them;
- quiet hours, and the time of day a digest goes out;
- digest cadences other than daily;
- a person's own delivery history.
