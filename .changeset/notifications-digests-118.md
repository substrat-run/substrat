---
'@substrat-run/engine-notifications': minor
'@substrat-run/demo-handlebar': minor
'@substrat-run/docs': patch
---

Daily digests in `@substrat-run/engine-notifications` (#118). A person can now take any topic that is not required as a daily digest instead of one mail per occasion: `notifications/set-my-preference` accepts an optional `cadence` (`'immediate'` or `'daily-digest'`; leaving it out keeps the current choice), and each topic in `notifications/my-preferences` shows its `cadence`. Everyone starts on `immediate`, so nothing changes for anyone until they choose a digest.

- `notify` holds an occasion for a person who takes its topic as a digest. The occasion's delivery is recorded `skipped` with reason `digest`, and `notify` returns that outcome.
- The engine declares a schedule, `notifications/send-digests`, every 15 minutes, run by its system principal under a new key, `notifications:send-digests`. No person may hold this key: `lint:permissions` refuses a role that grants it.
- A person is due once their oldest held message is a day old. So nothing waits much longer than that, and a person with no more than 50 held gets one digest a day.
- Each due person gets one mail of up to 50 held messages, oldest first, through the same send intent and delivery row as any notification. That mail is a delivery under the reserved topic `@digest` (`DIGEST_TOPIC`) and settles like any other. The occasions it carried are settled into it.
- A pass never sends more than the scope's backlog of pending sends has room for (32, less 8 kept for mail that must not wait). Everyone else goes out on later passes, oldest first.
- One digest carries at most 50 occasions (`DIGEST_MAX_ITEMS`), oldest first. The rest stay held and are due once the oldest of them is a day old, on the next pass if it already is.
- Each person's digest is its own sub-transaction. One that cannot be written stays held, is reported by the new `notifications.digest-failed` event and an error line, and is retried a day later. It never stops anyone else's.
- A held message that no longer reads is set aside rather than blocking the rest. It is marked and not sent, its delivery settles `skipped`/`quarantined`, and the new `notifications.digest-quarantined` event names it. It is read again once a day. When it reads again, for instance after a rolled-back version is rolled forward, it is released: held as before, its delivery back to `digest`, and named by the new `notifications.digest-released` event.
- `sendDigests(ctx)` is exported. Call it after your own permission check to run one pass yourself; like the schedule, it sends only the people who are due.
- A new event, `notifications.digest-sent`, lists the occasions each digest carried. `notifications.preference-set` gains two optional fields, `cadence` and `withdrawn`. No existing event changes its `schemaVersion`.
- A mute still wins: switching a topic off withdraws what is held for it, and those occasions' deliveries then read `skipped`/`muted`. A required topic refuses a digest and always goes out at once.
- The digest adds no wording of its own. A digest of one message is that message. A digest of several uses the first message's subject with `(+N)` and puts each message under its own subject, as one document. A whole-document html template gives way to its text part there.
- A held message is rendered mail addressed to the person, so a subject erasure deletes it along with their address.
- Something must run the schedule, and something must drain the sends. On the hosted platform the scope sweeper runs the schedule once the scope's provision has granted the new key. An install provisioned earlier gets the key from the reconcile after a promote. The control plane's 15-minute sweep drains the sends. A self-hosted server needs `startPlatformSweeper` or `runDueSchedules`, and must drain its platform intents. Until both happen, messages are held and nothing fails; a hold that finds a person's oldest message two days old logs a warning.

New migration `0002-digests`. It adds two tables, `notifications_cadences` and `notifications_digest_items`, and changes no existing row. The engine's manifest shape moves to `0.0.2`.

The Handlebar demo lists the new key, holds it in no role, and binds no URL to the schedule's operation. Its dev server now starts a schedule sweeper, so the digest schedule runs there. It drains no platform intents, so a digest is written as a pending send, as every notification there is. Once 24 sends are pending, every pass defers everyone and says so.
