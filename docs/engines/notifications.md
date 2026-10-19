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
the rendered message.

The engine's manifest declares a schedule, `notifications/send-digests`, every 15 minutes. It
runs as the engine's system principal under `notifications:send-digests`, a key the manifest
declares `holder: 'system'`, which reserves it to system principals. A person is due once their oldest held message is a day old. Nothing waits
much longer than that, and a person with no more than 50 held gets one digest a day.

Each due person gets one mail through the same `requestEmail` and delivery row, under the
reserved topic `@digest`, and `notifications.digest-sent` names the occasions it carried. A
digest carries at most 50, oldest first. The rest stay held and are due once the oldest of them
is a day old, on the next pass if it already is. A pass sends to at
most the room left in the scope's backlog of 32 pending sends, less 8 kept for immediate mail,
and defers everyone else to the next pass.

Each person is their own sub-transaction. One whose digest cannot be written stays held, is
reported by `notifications.digest-failed`, and waits a day before the next try. A held row that
no longer reads is set aside (`quarantined_at`): it is not sent, its delivery settles
`skipped`/`quarantined`, and `notifications.digest-quarantined` names it. It counts toward
nothing: not who is due, not a withdrawal, not the stale-hold warning. The rest of that person's
messages go out. A set-aside row is read again once a day. One that reads again is released
(`notifications.digest-released`) and held as before, so a transient cause, such as a rolled-back
version, does not lose it.

A mute still wins: switching a topic off withdraws what is held for it and settles those
occasions `skipped`/`muted`. The digest adds no wording of its own: one held message goes out as
it is, and several go out under the first one's subject with `(+N)`, as one document.

Held messages wait, and nothing fails, wherever the schedule cannot run or the sends do not
drain. That covers:

- an install provisioned before the schedule existed, until its provision runs again;
- a self-hosted server that runs no sweeper;
- a server whose platform intents nobody drains, as in Handlebar's dev server, where every pass
  then finds no room.

On the hosted platform a scheduled pass gets no immediate drain kick, unlike an operation a
request ran, so its sends wait for the control plane's 15-minute sweep. A hold whose person's
oldest message is two days old logs a warning.

What it holds:

| Table | What | Erasure |
| --- | --- | --- |
| `notifications_topics` | each topic this scope has used: description, required | none: names nobody |
| `notifications_recipients` | one address per principal | deleted with the principal (K-46) |
| `notifications_mutes` | a topic a person switched off, per channel | none: no personal data beyond the principal id |
| `notifications_deliveries` | what became of each (dedupe key, topic, principal, channel); a digest is one more, under topic `@digest` | none: principal and request id only, never the address |
| `notifications_cadences` | a topic a person takes as a digest, per channel; no row is `immediate` | none: no personal data beyond the principal id |
| `notifications_digest_items` | each rendered message held for a person's next digest, deleted when it is sent or withdrawn; `failed_at` marks a person whose digest failed; `quarantined_at` a row set aside as unreadable, which stays until it reads again or an erasure deletes it | deleted with the principal (K-46); their occasions' deliveries keep `digest`, as a cancelled send's keeps `requested` |

A vertical composing it needs the `emailSender` grant: without it the platform refuses
every send, and each delivery settles `refused` with reason `permission_denied`.

The send intent carries the recipient as its `subjectId`, so a subject erasure cancels a send
that is still held.

Not built, in the order a vertical is expected to ask for them:

- channels beyond email;
- tenant-edited and per-locale templates, a digest's own wording among them;
- quiet hours, and a digest at a chosen time of day;
- digest cadences other than daily;
- a person's own delivery history.
