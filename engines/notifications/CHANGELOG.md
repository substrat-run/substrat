# @substrat-run/engine-notifications

## 0.3.15

### Patch Changes

- Updated dependencies [f0e000d]
- Updated dependencies [0bc0f4a]
  - @substrat-run/contracts@0.170.0
  - @substrat-run/kernel@0.170.0

## 0.3.14

### Patch Changes

- Updated dependencies [9e6412c]
- Updated dependencies [77d504f]
- Updated dependencies [fb2de85]
  - @substrat-run/contracts@0.169.0
  - @substrat-run/kernel@0.169.0

## 0.3.13

### Patch Changes

- Updated dependencies [e34da92]
  - @substrat-run/contracts@0.168.0
  - @substrat-run/kernel@0.168.0

## 0.3.12

### Patch Changes

- Updated dependencies [280f175]
  - @substrat-run/contracts@0.167.0
  - @substrat-run/kernel@0.167.0

## 0.3.11

### Patch Changes

- Updated dependencies [9499b29]
  - @substrat-run/contracts@0.166.0
  - @substrat-run/kernel@0.166.0

## 0.3.10

### Patch Changes

- Updated dependencies [7df34ee]
  - @substrat-run/contracts@0.165.0
  - @substrat-run/kernel@0.165.0

## 0.3.9

### Patch Changes

- Updated dependencies [170078f]
- Updated dependencies [3225234]
- Updated dependencies [0e2bc1c]
- Updated dependencies [0b19237]
- Updated dependencies [2ade7ea]
- Updated dependencies [af79679]
- Updated dependencies [1e5a5af]
  - @substrat-run/contracts@0.164.0
  - @substrat-run/kernel@0.164.0

## 0.3.8

### Patch Changes

- Updated dependencies [ad35e20]
- Updated dependencies [60eb041]
- Updated dependencies [2eedfee]
  - @substrat-run/kernel@0.163.0
  - @substrat-run/contracts@0.163.0

## 0.3.7

### Patch Changes

- Updated dependencies [3310b4d]
- Updated dependencies [7d71f13]
  - @substrat-run/kernel@0.162.0
  - @substrat-run/contracts@0.162.0

## 0.3.6

### Patch Changes

- Updated dependencies [d52ad61]
- Updated dependencies [7d34c2c]
- Updated dependencies [1e7e16e]
- Updated dependencies [8bb7be5]
- Updated dependencies [2dfc19b]
- Updated dependencies [5279112]
- Updated dependencies [91a5ea1]
- Updated dependencies [81a07aa]
- Updated dependencies [14ce171]
  - @substrat-run/kernel@0.161.0
  - @substrat-run/contracts@0.161.0

## 0.3.5

### Patch Changes

- Updated dependencies [8e8af88]
- Updated dependencies [f0b5904]
- Updated dependencies [763957c]
- Updated dependencies [361136b]
- Updated dependencies [581a697]
- Updated dependencies [dc3b911]
- Updated dependencies [a283098]
- Updated dependencies [95bdb79]
- Updated dependencies [26db572]
- Updated dependencies [5554dad]
- Updated dependencies [279f8e8]
- Updated dependencies [c304fbd]
- Updated dependencies [69868f3]
- Updated dependencies [5147141]
- Updated dependencies [a06e284]
- Updated dependencies [ee05879]
- Updated dependencies [9112dd6]
- Updated dependencies [78a0c96]
- Updated dependencies [09c081a]
- Updated dependencies [ecbed6e]
- Updated dependencies [d5f2f9a]
- Updated dependencies [bc36021]
- Updated dependencies [286f3b4]
- Updated dependencies [5f75359]
- Updated dependencies [bc629db]
  - @substrat-run/contracts@0.160.0
  - @substrat-run/kernel@0.160.0

## 0.3.4

### Patch Changes

- Updated dependencies [6aad0fb]
  - @substrat-run/contracts@0.159.0
  - @substrat-run/kernel@0.159.0

## 0.3.3

### Patch Changes

- @substrat-run/contracts@0.158.0
- @substrat-run/kernel@0.158.0

## 0.3.2

### Patch Changes

- Updated dependencies [d0af665]
- Updated dependencies [156febd]
  - @substrat-run/contracts@0.157.0
  - @substrat-run/kernel@0.157.0

## 0.3.1

### Patch Changes

- 0676bc7: Enable public npm publication of the notifications engine so projects outside the Substrat workspace can install it. Add the standard pnpm publish guard so the published package carries registry-compatible dependency ranges.
- Updated dependencies [8bbf7e9]
- Updated dependencies [c5052f9]
- Updated dependencies [55a4dae]
- Updated dependencies [1344288]
  - @substrat-run/kernel@0.156.0
  - @substrat-run/contracts@0.156.0

## 0.3.0

### Minor Changes

- fe53f1e: A person can read their own notification history (part of #118). `@substrat-run/engine-notifications` adds `notifications/my-deliveries`, under the existing `notifications:self` key (no new permission key), and the in-scope `listMyDeliveries`.

  - It pages the caller's deliveries, newest first, and narrows by `status` and `topic`. It is `notifications/list-deliveries` with the caller's principal pinned in and no `principal` input, so holding the key never reaches anyone else's rows. An input that names one is dropped.
  - The row is narrower than the administrator's (`myDeliveryRow`): no `principal`, no `dedupe_key` and no `request_id`. Its `reason` is kept on a `skipped` row, where it is the engine's own word (`muted`, `no_address`, `digest`, `quarantined`), and is `null` on a `refused` or `dead_lettered` one, whose reason is the platform's outcome code.
  - Digest rows are listed as they are: an occasion held for the digest reads `skipped`/`digest` and is settled once its digest is written, the digest is a row of its own under `@digest`, and a withdrawn occasion reads `skipped`/`muted`.
  - The description of `notifications:self` now says it covers reading what became of your notifications. The key's holders (in Handlebar, `mechanic` and `workshop-admin`) gain this one read of their own rows.

  Handlebar serves it at `GET /me/notifications/deliveries` and its generated client gains `notificationsMyDeliveries`.

### Patch Changes

- Updated dependencies [6933146]
- Updated dependencies [35bdba2]
- Updated dependencies [10b7e03]
  - @substrat-run/contracts@0.155.0
  - @substrat-run/kernel@0.155.0

## 0.2.2

### Patch Changes

- Updated dependencies [bf18880]
- Updated dependencies [34c4455]
- Updated dependencies [34c4455]
- Updated dependencies [1872bb7]
  - @substrat-run/contracts@0.154.0
  - @substrat-run/kernel@0.154.0

## 0.2.1

### Patch Changes

- Updated dependencies [1a064a0]
  - @substrat-run/kernel@0.153.0
  - @substrat-run/contracts@0.153.0

## 0.2.0

### Minor Changes

- 640106a: Daily digests in `@substrat-run/engine-notifications` (#118). A person can now take any topic that is not required as a daily digest instead of one mail per occasion: `notifications/set-my-preference` accepts an optional `cadence` (`'immediate'` or `'daily-digest'`; leaving it out keeps the current choice), and each topic in `notifications/my-preferences` shows its `cadence`. Everyone starts on `immediate`, so nothing changes for anyone until they choose a digest.

  - `notify` holds an occasion for a person who takes its topic as a digest. The occasion's delivery is recorded `skipped` with reason `digest`, and `notify` returns that outcome.
  - The engine declares a schedule, `notifications/send-digests`, every 15 minutes, run by its system principal under a new key, `notifications:send-digests`. The manifest declares that key `holder: 'system'`, so no person may hold it: `lint:permissions` refuses a role or entity grant shape that grants it, and a vertical's `PERMISSIONS.md` marks it reserved.
  - A person is due once their oldest held message is a day old. So nothing waits much longer than that, and a person with no more than 50 held gets one digest a day.
  - Each due person gets one mail of up to 50 held messages, oldest first, through the same send intent and delivery row as any notification. That mail is a delivery under the reserved topic `@digest` (`DIGEST_TOPIC`) and settles like any other. The occasions it carried are settled into it.
  - A pass never sends more than the scope's backlog of pending sends has room for (32, less 8 kept for mail that must not wait). Everyone else goes out on later passes, oldest first.
  - One digest carries at most 50 occasions (`DIGEST_MAX_ITEMS`), oldest first. The rest stay held and are due once the oldest of them is a day old, on the next pass if it already is.
  - Each person's digest is its own sub-transaction. One that cannot be written stays held, is reported by the new `notifications.digest-failed` event and an error line, and is retried a day later. It never stops anyone else's.
  - A held message that no longer reads is set aside rather than blocking the rest. It is marked and not sent, its delivery settles `skipped`/`quarantined`, and the new `notifications.digest-quarantined` event names it. It is read again once a day. When it reads again, for instance after a rolled-back version is rolled forward, it is released: held as before, its delivery back to `digest`, and named by the new `notifications.digest-released` event. If its person switched the topic off in the meantime, it is withdrawn instead: deleted unsent, its delivery `skipped`/`muted`, and named by the new `notifications.digest-withdrawn` event.
  - `sendDigests(ctx)` is exported. Call it after your own permission check to run one pass yourself; like the schedule, it sends only the people who are due.
  - A new event, `notifications.digest-sent`, lists the occasions each digest carried. `notifications.preference-set` gains two optional fields, `cadence` and `withdrawn`. No existing event changes its `schemaVersion`.
  - A mute still wins: switching a topic off withdraws what is held for it, and those occasions' deliveries then read `skipped`/`muted`. Composing a digest checks the mute again, so a held message whose topic is switched off is withdrawn, never mailed. A required topic refuses a digest and always goes out at once.
  - The digest adds no wording of its own. A digest of one message is that message. A digest of several uses the first message's subject with `(+N)` and puts each message under its own subject, as one document. A whole-document html template gives way to its text part there.
  - A held message is rendered mail addressed to the person, so a subject erasure deletes it along with their address.
  - Something must run the schedule, and something must drain the sends. On the hosted platform the scope sweeper runs the schedule once the scope's provision has granted the new key. An install provisioned earlier gets the key from the reconcile after a promote. The control plane's 15-minute sweep drains the sends. A self-hosted server needs `startPlatformSweeper` or `runDueSchedules`, and must drain its platform intents. Until both happen, messages are held and nothing fails; a hold that finds a person's oldest message two days old logs a warning.

  New migration `0002-digests`. It adds two tables, `notifications_cadences` and `notifications_digest_items`, and changes no existing row. The engine's manifest shape moves to `0.0.2`.

  The Handlebar demo lists the new key, holds it in no role, and binds no URL to the schedule's operation. Its dev server now starts a schedule sweeper, so the digest schedule runs there. It drains no platform intents, so a digest is written as a pending send, as every notification there is. Once 24 sends are pending, every pass defers everyone and says so.

### Patch Changes

- Updated dependencies [482e9b7]
  - @substrat-run/contracts@0.152.0
  - @substrat-run/kernel@0.152.0

## 0.1.7

### Patch Changes

- Updated dependencies [8273013]
- Updated dependencies [4efc88d]
- Updated dependencies [a667881]
- Updated dependencies [f614b00]
- Updated dependencies [a00c87a]
  - @substrat-run/contracts@0.151.0
  - @substrat-run/kernel@0.151.0

## 0.1.6

### Patch Changes

- Updated dependencies [57700ea]
- Updated dependencies [52cc41f]
- Updated dependencies [9024575]
- Updated dependencies [5f77e74]
  - @substrat-run/kernel@0.150.0
  - @substrat-run/contracts@0.150.0

## 0.1.5

### Patch Changes

- Updated dependencies [98f09fe]
- Updated dependencies [0292dc0]
- Updated dependencies [b190e40]
- Updated dependencies [eda31d1]
- Updated dependencies [af096c6]
- Updated dependencies [39ccfea]
- Updated dependencies [6f5f12b]
- Updated dependencies [754fc62]
- Updated dependencies [c7eb5fa]
- Updated dependencies [1df1b93]
- Updated dependencies [6c1e359]
- Updated dependencies [439efc1]
- Updated dependencies [e550dec]
- Updated dependencies [4574ab8]
- Updated dependencies [3025154]
- Updated dependencies [9ae6644]
- Updated dependencies [d6ba289]
- Updated dependencies [2e503da]
- Updated dependencies [3608db6]
- Updated dependencies [9ceb545]
  - @substrat-run/kernel@0.149.0
  - @substrat-run/contracts@0.149.0

## 0.1.4

### Patch Changes

- Updated dependencies [ad3ca19]
- Updated dependencies [c4a0352]
- Updated dependencies [f855218]
- Updated dependencies [a8b0842]
- Updated dependencies [00253e0]
- Updated dependencies [a9cbb6d]
- Updated dependencies [7f8c6bf]
- Updated dependencies [d175d87]
- Updated dependencies [1bf5425]
  - @substrat-run/contracts@0.148.0
  - @substrat-run/kernel@0.148.0

## 0.1.3

### Patch Changes

- Updated dependencies [9926c53]
- Updated dependencies [8ff761c]
- Updated dependencies [cb957bc]
- Updated dependencies [cb957bc]
- Updated dependencies [4d14a81]
- Updated dependencies [5b1c20f]
- Updated dependencies [1ce756e]
- Updated dependencies [b854efd]
- Updated dependencies [23840a7]
- Updated dependencies [1ad1426]
- Updated dependencies [b4bb938]
- Updated dependencies [cb957bc]
  - @substrat-run/contracts@0.147.0
  - @substrat-run/kernel@0.147.0

## 0.1.2

### Patch Changes

- Updated dependencies [381f120]
- Updated dependencies [a55d75e]
- Updated dependencies [56b0af0]
  - @substrat-run/contracts@0.146.0
  - @substrat-run/kernel@0.146.0

## 0.1.1

### Patch Changes

- Updated dependencies [e786ff0]
- Updated dependencies [f49cc49]
- Updated dependencies [6aaf822]
- Updated dependencies [bb4f18d]
- Updated dependencies [2c75a0d]
- Updated dependencies [48e9503]
- Updated dependencies [5554b23]
- Updated dependencies [3782c4c]
- Updated dependencies [fac4f0a]
  - @substrat-run/contracts@0.145.0
  - @substrat-run/kernel@0.145.0

## 0.1.0

### Minor Changes

- b508cdc: New engine, `@substrat-run/engine-notifications` (#118): an occasion a vertical names becomes email to the people it concerns. It is composed by call. A vertical calls `notify(ctx, { topic, description, dedupeKey, recipients, vars, about, template, required? })` in its own transaction, usually from its own consumer of a domain event. For each recipient, the engine:

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

### Patch Changes

- Updated dependencies [835409e]
- Updated dependencies [f84eb3a]
- Updated dependencies [e286f87]
- Updated dependencies [f6d671b]
- Updated dependencies [134e6c2]
- Updated dependencies [6dc8097]
  - @substrat-run/contracts@0.144.0
  - @substrat-run/kernel@0.144.0
