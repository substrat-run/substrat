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
in its own consumer of a domain event, and calls `notify(ctx, { topic, recipients, template,
vars, dedupeKey, about, required? })` in its own transaction. For each recipient,
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

What it holds:

| Table | What | Erasure |
| --- | --- | --- |
| `notifications_topics` | each topic this scope has used: description, required | none: names nobody |
| `notifications_recipients` | one address per principal | deleted with the principal (K-46) |
| `notifications_mutes` | a topic a person switched off, per channel | none: no personal data beyond the principal id |
| `notifications_deliveries` | what became of each (dedupe key, topic, principal, channel) | none: principal and request id only, never the address |

A vertical composing it needs the `emailSender` grant: without it the platform refuses
every send, and each delivery settles `refused` with reason `permission_denied`.

The send intent carries the recipient as its `subjectId`, so a subject erasure cancels a send
that is still held.

Not built, in the order a vertical is expected to ask for them:

- digests;
- channels beyond email;
- tenant-edited and per-locale templates;
- quiet hours;
- a person's own delivery history.
