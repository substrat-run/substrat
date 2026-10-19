---
'@substrat-run/engine-notifications': minor
'@substrat-run/demo-handlebar': minor
'@substrat-run/docs': patch
---

Daily digests in `@substrat-run/engine-notifications` (#118). A person can now take any topic that is not required as a daily digest instead of one mail per occasion: `notifications/set-my-preference` accepts an optional `cadence` (`'immediate'` or `'daily-digest'`; leaving it out keeps the current choice), and each topic in `notifications/my-preferences` shows its `cadence`. Everyone starts on `immediate`, so nothing changes for anyone until they choose a digest.

- `notify` holds an occasion for a person who takes its topic as a digest. The occasion's delivery is recorded `skipped` with reason `digest`, and `notify` returns that outcome.
- The engine declares a schedule, `notifications/send-digests`, every 15 minutes, run by its system principal under a new key, `notifications:send-digests`. No person may hold this key: `lint:permissions` refuses a role that grants it.
- A person is due once their oldest held message is a day old. So nobody gets more than one digest a day, and nothing waits much longer than that.
- Each due person gets one mail of everything held for them, through the same send intent and delivery row as any notification. That mail is a delivery under the reserved topic `@digest` (`DIGEST_TOPIC`) and settles like any other. The occasions it carried are settled into it.
- A pass never sends more than the scope's backlog of pending sends has room for (32, less 8 kept for mail that must not wait). Everyone else goes out on later passes, oldest first.
- Each person's digest is its own sub-transaction. One that cannot be composed stays held, is reported by the new `notifications.digest-failed` event and an error line, and is retried a day later. It never stops anyone else's.
- You can also call the new `sendDigests(ctx)` yourself, after your own permission check.
- A new event, `notifications.digest-sent`, lists the occasions each digest carried. `notifications.preference-set` gains an optional `cadence`, and `withdrawn`. No existing event changes its `schemaVersion`.
- A mute still wins: switching a topic off withdraws what is held for it, and those occasions' deliveries then read `skipped`/`muted`. A required topic refuses a digest and always goes out at once.
- The digest adds no wording of its own. A digest of one message is that message. A digest of several uses the first message's subject with `(+N)` and puts each message under its own subject, as one document. A whole-document html template gives way to its text part there.
- A held message is rendered mail addressed to the person, so a subject erasure deletes it along with their address.
- Something must run the schedule. On the hosted platform the scope sweeper does once the scope's provision has granted the new key, and an install provisioned earlier gets it from the reconcile after a promote. A self-hosted server needs `startPlatformSweeper` or `runDueSchedules`. Until then messages are held and nothing fails; a hold that finds a person's oldest message two days old logs a warning.

New migration `0002-digests`. It adds two tables, `notifications_cadences` and `notifications_digest_items`, and changes no existing row. The engine's manifest shape moves to `0.0.2`.

The Handlebar demo lists the new key, holds it in no role, and binds no URL to the schedule's operation. Its dev server now starts a schedule sweeper, so a mechanic's digest is actually sent there.
