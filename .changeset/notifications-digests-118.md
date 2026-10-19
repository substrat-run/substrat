---
'@substrat-run/engine-notifications': minor
'@substrat-run/demo-handlebar': minor
'@substrat-run/docs': patch
---

Daily digests in `@substrat-run/engine-notifications` (#118). A person can now take any topic that is not required as a daily digest instead of one mail per occasion: `notifications/set-my-preference` accepts an optional `cadence` (`'immediate'` or `'daily-digest'`; leaving it out keeps the current choice), and each topic in `notifications/my-preferences` shows its `cadence`. Everyone starts on `immediate`, so nothing changes for anyone until they choose a digest.

- `notify` holds an occasion for a person who takes its topic as a digest. The occasion's delivery is recorded `skipped` with reason `digest`, and `notify` returns that outcome.
- The engine declares a daily schedule, `notifications/send-digests`, run by its system principal under a new key, `notifications:send-digests`. No person may hold this key: `lint:permissions` refuses a role that grants it. Each run sends every person one mail of everything held for them, through the same send intent and delivery row as any notification. That mail is a delivery under the reserved topic `@digest` (`DIGEST_TOPIC`) and settles like any other. You can also call the new `sendDigests(ctx)` yourself, after your own permission check.
- A new event, `notifications.digest-sent`, lists the occasions each digest carried. `notifications.preference-set` gains an optional `cadence`. No existing event changes its `schemaVersion`.
- A mute still wins: switching a topic off withdraws what is held for it. A required topic refuses a digest and always goes out at once.
- The digest adds no wording of its own. A digest of one message is that message. A digest of several uses the first message's subject with `(+N)` and puts each message under its own subject.
- A held message is rendered mail addressed to the person, so a subject erasure deletes it along with their address.

New migration `0002-digests`. It adds two tables, `notifications_cadences` and `notifications_digest_items`, and changes no existing row. The engine's manifest shape moves to `0.0.2`.

The Handlebar demo lists the new key, holds it in no role, and binds no URL to the schedule's operation.
