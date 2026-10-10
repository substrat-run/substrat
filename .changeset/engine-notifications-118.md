---
'@substrat-run/engine-notifications': minor
'@substrat-run/demo-handlebar': patch
'@substrat-run/docs': patch
---

New engine, `@substrat-run/engine-notifications` (#118): an occasion a vertical names becomes email to the people it concerns. It is composed by call. A vertical calls `notify(ctx, { topic, description, dedupeKey, recipients, vars, about, template, required? })` in its own transaction, usually from its own consumer of a domain event. For each recipient, the engine:

- applies their mutes, unless the topic is required;
- looks up their address;
- renders the template with every variable HTML-escaped;
- writes a send intent with the kernel's `requestEmail`;
- records one delivery per (dedupe key, topic, person, channel).

Pass the triggering event's id as `dedupeKey`, and a redelivered event mails nobody twice. A template variable the caller did not pass makes `notify` throw `validation_failed`, which rolls back the caller rather than sending a blank mail. The engine settles each delivery from the `email.sent`, `email.refused` or `email.dead-lettered` event the platform writes back. A delivery that was not sent says why: `muted` or `no_address`. A topic is recorded the first time it is used, and that is what a person's preferences list.

A person's notification address is held by the engine, never put on an event, and deleted by a subject erasure. The send intent names the person as its subject, so the same erasure cancels a send that is still held.

Operations:

- `notifications/my-preferences`, `notifications/set-my-address` and `notifications/set-my-preference` require `notifications:self` and act on the caller only.
- `notifications/list-deliveries` requires `notifications:read`.

The package is private until its first release is set up.

The Handlebar demo composes it: its own consumer of `workorder.assigned` mails the mechanic a repair was assigned to.
