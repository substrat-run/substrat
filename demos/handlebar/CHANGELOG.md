# @substrat-run/demo-bike-shop

## 0.3.5

### Patch Changes

- Updated dependencies [ab4cc69]
- Updated dependencies [8e8af88]
- Updated dependencies [f0b5904]
- Updated dependencies [763957c]
- Updated dependencies [bc51fe0]
- Updated dependencies [361136b]
- Updated dependencies [581a697]
- Updated dependencies [2519c08]
- Updated dependencies [dc3b911]
- Updated dependencies [649cbda]
- Updated dependencies [a283098]
- Updated dependencies [95bdb79]
- Updated dependencies [26db572]
- Updated dependencies [5554dad]
- Updated dependencies [279f8e8]
- Updated dependencies [c304fbd]
- Updated dependencies [69868f3]
- Updated dependencies [6b49305]
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
  - @substrat-run/adapter-sqlite@0.160.0
  - @substrat-run/contracts@0.160.0
  - @substrat-run/kernel@0.160.0
  - @substrat-run/vertical-host@0.160.0
  - @substrat-run/engine-notifications@0.3.5
  - @substrat-run/engine-protocol@0.13.45
  - @substrat-run/engine-invoicing@0.11.44
  - @substrat-run/engine-workorder@0.12.44
  - @substrat-run/dev-issuer@0.2.42
  - @substrat-run/attachment-extractors@0.2.21

## 0.3.4

### Patch Changes

- Updated dependencies [6aad0fb]
  - @substrat-run/contracts@0.159.0
  - @substrat-run/kernel@0.159.0
  - @substrat-run/vertical-host@0.159.0
  - @substrat-run/engine-invoicing@0.11.43
  - @substrat-run/engine-notifications@0.3.4
  - @substrat-run/engine-protocol@0.13.44
  - @substrat-run/engine-workorder@0.12.43
  - @substrat-run/adapter-sqlite@0.159.0
  - @substrat-run/dev-issuer@0.2.41
  - @substrat-run/attachment-extractors@0.2.20

## 0.3.3

### Patch Changes

- Updated dependencies [3ca238f]
  - @substrat-run/vertical-host@0.158.0
  - @substrat-run/contracts@0.158.0
  - @substrat-run/kernel@0.158.0
  - @substrat-run/adapter-sqlite@0.158.0
  - @substrat-run/engine-notifications@0.3.3
  - @substrat-run/engine-invoicing@0.11.42
  - @substrat-run/engine-protocol@0.13.43
  - @substrat-run/engine-workorder@0.12.42
  - @substrat-run/dev-issuer@0.2.40
  - @substrat-run/attachment-extractors@0.2.19

## 0.3.2

### Patch Changes

- Updated dependencies [d0af665]
- Updated dependencies [156febd]
  - @substrat-run/contracts@0.157.0
  - @substrat-run/vertical-host@0.157.0
  - @substrat-run/engine-invoicing@0.11.41
  - @substrat-run/engine-notifications@0.3.2
  - @substrat-run/engine-protocol@0.13.42
  - @substrat-run/engine-workorder@0.12.41
  - @substrat-run/adapter-sqlite@0.157.0
  - @substrat-run/dev-issuer@0.2.39
  - @substrat-run/kernel@0.157.0
  - @substrat-run/attachment-extractors@0.2.18

## 0.3.1

### Patch Changes

- Updated dependencies [8bbf7e9]
- Updated dependencies [c368f6e]
- Updated dependencies [c5052f9]
- Updated dependencies [55a4dae]
- Updated dependencies [0676bc7]
- Updated dependencies [1344288]
  - @substrat-run/kernel@0.156.0
  - @substrat-run/adapter-sqlite@0.156.0
  - @substrat-run/contracts@0.156.0
  - @substrat-run/engine-notifications@0.3.1
  - @substrat-run/engine-invoicing@0.11.40
  - @substrat-run/engine-protocol@0.13.41
  - @substrat-run/engine-workorder@0.12.40
  - @substrat-run/attachment-extractors@0.2.17
  - @substrat-run/vertical-host@0.156.0
  - @substrat-run/dev-issuer@0.2.38

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
- Updated dependencies [fe53f1e]
- Updated dependencies [35bdba2]
- Updated dependencies [10b7e03]
  - @substrat-run/contracts@0.155.0
  - @substrat-run/kernel@0.155.0
  - @substrat-run/adapter-sqlite@0.155.0
  - @substrat-run/engine-notifications@0.3.0
  - @substrat-run/engine-invoicing@0.11.39
  - @substrat-run/engine-protocol@0.13.40
  - @substrat-run/engine-workorder@0.12.39
  - @substrat-run/dev-issuer@0.2.37
  - @substrat-run/vertical-host@0.155.0
  - @substrat-run/attachment-extractors@0.2.16

## 0.2.2

### Patch Changes

- 34c4455: The scaffold template, the demo verticals and the dashboard hand their scope hosts the permission surface `substrat push` reads (`permissions`), so a module registered beside that surface is refused at registration rather than judged by neither lint nor push (#2430). The todo demo's `MODULES` and `ROLES` move into `src/provision.ts` beside it; `src/seed.ts` still exports both.
- Updated dependencies [bf18880]
- Updated dependencies [34c4455]
- Updated dependencies [34c4455]
- Updated dependencies [1872bb7]
  - @substrat-run/contracts@0.154.0
  - @substrat-run/kernel@0.154.0
  - @substrat-run/vertical-host@0.154.0
  - @substrat-run/adapter-sqlite@0.154.0
  - @substrat-run/engine-invoicing@0.11.38
  - @substrat-run/engine-notifications@0.2.2
  - @substrat-run/engine-protocol@0.13.39
  - @substrat-run/engine-workorder@0.12.38
  - @substrat-run/dev-issuer@0.2.36
  - @substrat-run/attachment-extractors@0.2.15

## 0.2.1

### Patch Changes

- Updated dependencies [1a064a0]
  - @substrat-run/kernel@0.153.0
  - @substrat-run/adapter-sqlite@0.153.0
  - @substrat-run/engine-invoicing@0.11.37
  - @substrat-run/engine-notifications@0.2.1
  - @substrat-run/engine-protocol@0.13.38
  - @substrat-run/engine-workorder@0.12.37
  - @substrat-run/attachment-extractors@0.2.14
  - @substrat-run/vertical-host@0.153.0
  - @substrat-run/contracts@0.153.0
  - @substrat-run/dev-issuer@0.2.35

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

- Updated dependencies [640106a]
- Updated dependencies [482e9b7]
- Updated dependencies [8c04244]
  - @substrat-run/engine-notifications@0.2.0
  - @substrat-run/contracts@0.152.0
  - @substrat-run/vertical-host@0.152.0
  - @substrat-run/engine-invoicing@0.11.36
  - @substrat-run/engine-protocol@0.13.37
  - @substrat-run/engine-workorder@0.12.36
  - @substrat-run/adapter-sqlite@0.152.0
  - @substrat-run/dev-issuer@0.2.34
  - @substrat-run/kernel@0.152.0
  - @substrat-run/attachment-extractors@0.2.13

## 0.1.69

### Patch Changes

- Updated dependencies [8273013]
- Updated dependencies [e829918]
- Updated dependencies [5436493]
- Updated dependencies [4efc88d]
- Updated dependencies [a667881]
- Updated dependencies [f614b00]
- Updated dependencies [a00c87a]
- Updated dependencies [8273013]
  - @substrat-run/contracts@0.151.0
  - @substrat-run/vertical-host@0.151.0
  - @substrat-run/kernel@0.151.0
  - @substrat-run/adapter-sqlite@0.151.0
  - @substrat-run/engine-invoicing@0.11.35
  - @substrat-run/engine-notifications@0.1.7
  - @substrat-run/engine-protocol@0.13.36
  - @substrat-run/engine-workorder@0.12.35
  - @substrat-run/dev-issuer@0.2.33
  - @substrat-run/attachment-extractors@0.2.12

## 0.1.68

### Patch Changes

- Updated dependencies [57700ea]
- Updated dependencies [52cc41f]
- Updated dependencies [52cc41f]
- Updated dependencies [9024575]
- Updated dependencies [5f77e74]
  - @substrat-run/kernel@0.150.0
  - @substrat-run/adapter-sqlite@0.150.0
  - @substrat-run/vertical-host@0.150.0
  - @substrat-run/contracts@0.150.0
  - @substrat-run/dev-issuer@0.2.32
  - @substrat-run/engine-protocol@0.13.35
  - @substrat-run/engine-invoicing@0.11.34
  - @substrat-run/engine-notifications@0.1.6
  - @substrat-run/engine-workorder@0.12.34
  - @substrat-run/attachment-extractors@0.2.11

## 0.1.67

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
  - @substrat-run/adapter-sqlite@0.149.0
  - @substrat-run/contracts@0.149.0
  - @substrat-run/engine-invoicing@0.11.33
  - @substrat-run/vertical-host@0.149.0
  - @substrat-run/engine-notifications@0.1.5
  - @substrat-run/engine-protocol@0.13.34
  - @substrat-run/engine-workorder@0.12.33
  - @substrat-run/attachment-extractors@0.2.10
  - @substrat-run/dev-issuer@0.2.31

## 0.1.66

### Patch Changes

- Updated dependencies [ad3ca19]
- Updated dependencies [c4a0352]
- Updated dependencies [c4a0352]
- Updated dependencies [f855218]
- Updated dependencies [a8b0842]
- Updated dependencies [0a52f8c]
- Updated dependencies [00253e0]
- Updated dependencies [a9cbb6d]
- Updated dependencies [7f8c6bf]
- Updated dependencies [d175d87]
- Updated dependencies [1bf5425]
  - @substrat-run/contracts@0.148.0
  - @substrat-run/adapter-sqlite@0.148.0
  - @substrat-run/kernel@0.148.0
  - @substrat-run/vertical-host@0.148.0
  - @substrat-run/engine-invoicing@0.11.32
  - @substrat-run/engine-notifications@0.1.4
  - @substrat-run/engine-protocol@0.13.33
  - @substrat-run/engine-workorder@0.12.32
  - @substrat-run/dev-issuer@0.2.30
  - @substrat-run/attachment-extractors@0.2.9

## 0.1.65

### Patch Changes

- Updated dependencies [9926c53]
- Updated dependencies [d5a7045]
- Updated dependencies [7a1ab65]
- Updated dependencies [8ff761c]
- Updated dependencies [873d117]
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
  - @substrat-run/vertical-host@0.147.0
  - @substrat-run/adapter-sqlite@0.147.0
  - @substrat-run/engine-invoicing@0.11.31
  - @substrat-run/engine-notifications@0.1.3
  - @substrat-run/engine-protocol@0.13.32
  - @substrat-run/engine-workorder@0.12.31
  - @substrat-run/dev-issuer@0.2.29
  - @substrat-run/attachment-extractors@0.2.8

## 0.1.64

### Patch Changes

- Updated dependencies [381f120]
- Updated dependencies [a55d75e]
- Updated dependencies [56b0af0]
  - @substrat-run/contracts@0.146.0
  - @substrat-run/kernel@0.146.0
  - @substrat-run/adapter-sqlite@0.146.0
  - @substrat-run/vertical-host@0.146.0
  - @substrat-run/engine-invoicing@0.11.30
  - @substrat-run/engine-notifications@0.1.2
  - @substrat-run/engine-protocol@0.13.31
  - @substrat-run/engine-workorder@0.12.30
  - @substrat-run/dev-issuer@0.2.28
  - @substrat-run/attachment-extractors@0.2.7

## 0.1.63

### Patch Changes

- Updated dependencies [e786ff0]
- Updated dependencies [f49cc49]
- Updated dependencies [6aaf822]
- Updated dependencies [bb4f18d]
- Updated dependencies [2c75a0d]
- Updated dependencies [55d60cf]
- Updated dependencies [48e9503]
- Updated dependencies [5554b23]
- Updated dependencies [3782c4c]
- Updated dependencies [fac4f0a]
  - @substrat-run/contracts@0.145.0
  - @substrat-run/kernel@0.145.0
  - @substrat-run/adapter-sqlite@0.145.0
  - @substrat-run/vertical-host@0.145.0
  - @substrat-run/engine-invoicing@0.11.29
  - @substrat-run/engine-notifications@0.1.1
  - @substrat-run/engine-protocol@0.13.30
  - @substrat-run/engine-workorder@0.12.29
  - @substrat-run/dev-issuer@0.2.27
  - @substrat-run/attachment-extractors@0.2.6

## 0.1.62

### Patch Changes

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

- Updated dependencies [835409e]
- Updated dependencies [f84eb3a]
- Updated dependencies [e286f87]
- Updated dependencies [f6d671b]
- Updated dependencies [b508cdc]
- Updated dependencies [134e6c2]
- Updated dependencies [6dc8097]
  - @substrat-run/contracts@0.144.0
  - @substrat-run/kernel@0.144.0
  - @substrat-run/adapter-sqlite@0.144.0
  - @substrat-run/vertical-host@0.144.0
  - @substrat-run/engine-notifications@0.1.0
  - @substrat-run/engine-invoicing@0.11.28
  - @substrat-run/engine-protocol@0.13.29
  - @substrat-run/engine-workorder@0.12.28
  - @substrat-run/dev-issuer@0.2.26
  - @substrat-run/attachment-extractors@0.2.5

## 0.1.61

### Patch Changes

- Updated dependencies [e55e06c]
- Updated dependencies [7eb1b3c]
- Updated dependencies [7eb1b3c]
- Updated dependencies [e55e06c]
- Updated dependencies [dfb653b]
- Updated dependencies [88a4380]
- Updated dependencies [f1c6c9a]
- Updated dependencies [6c44d57]
- Updated dependencies [9454e61]
  - @substrat-run/contracts@0.143.0
  - @substrat-run/kernel@0.143.0
  - @substrat-run/engine-invoicing@0.11.27
  - @substrat-run/engine-protocol@0.13.28
  - @substrat-run/engine-workorder@0.12.27
  - @substrat-run/adapter-sqlite@0.143.0
  - @substrat-run/vertical-host@0.143.0
  - @substrat-run/dev-issuer@0.2.25
  - @substrat-run/attachment-extractors@0.2.4

## 0.1.60

### Patch Changes

- Updated dependencies [6a81de3]
- Updated dependencies [6a00cfc]
- Updated dependencies [c78098a]
- Updated dependencies [65305a1]
- Updated dependencies [c56bb34]
  - @substrat-run/contracts@0.142.0
  - @substrat-run/kernel@0.142.0
  - @substrat-run/adapter-sqlite@0.142.0
  - @substrat-run/vertical-host@0.142.0
  - @substrat-run/engine-invoicing@0.11.26
  - @substrat-run/engine-protocol@0.13.27
  - @substrat-run/engine-workorder@0.12.26
  - @substrat-run/dev-issuer@0.2.24
  - @substrat-run/attachment-extractors@0.2.3

## 0.1.59

### Patch Changes

- Updated dependencies [48be1e6]
- Updated dependencies [51bb25b]
- Updated dependencies [6a05977]
- Updated dependencies [a7c6652]
  - @substrat-run/contracts@0.141.0
  - @substrat-run/kernel@0.141.0
  - @substrat-run/adapter-sqlite@0.141.0
  - @substrat-run/vertical-host@0.141.0
  - @substrat-run/engine-invoicing@0.11.25
  - @substrat-run/engine-protocol@0.13.26
  - @substrat-run/engine-workorder@0.12.25
  - @substrat-run/dev-issuer@0.2.23
  - @substrat-run/attachment-extractors@0.2.2

## 0.1.58

### Patch Changes

- Updated dependencies [35dc72e]
- Updated dependencies [32df62b]
- Updated dependencies [6154fd9]
- Updated dependencies [6d49012]
- Updated dependencies [55e6241]
- Updated dependencies [13a2067]
- Updated dependencies [7b15101]
- Updated dependencies [72f8e92]
- Updated dependencies [100b47c]
- Updated dependencies [d42bb2b]
- Updated dependencies [e5bd928]
- Updated dependencies [b180d3e]
- Updated dependencies [07388df]
- Updated dependencies [ae80b0d]
- Updated dependencies [a1f40e5]
- Updated dependencies [0e3d406]
- Updated dependencies [fed1f3c]
- Updated dependencies [5405401]
- Updated dependencies [655141a]
- Updated dependencies [f1290ea]
- Updated dependencies [ced5130]
  - @substrat-run/kernel@0.140.0
  - @substrat-run/adapter-sqlite@0.140.0
  - @substrat-run/contracts@0.140.0
  - @substrat-run/vertical-host@0.140.0
  - @substrat-run/engine-invoicing@0.11.24
  - @substrat-run/engine-protocol@0.13.25
  - @substrat-run/engine-workorder@0.12.24
  - @substrat-run/attachment-extractors@0.2.1
  - @substrat-run/dev-issuer@0.2.22

## 0.1.57

### Patch Changes

- Updated dependencies [d62f6fb]
- Updated dependencies [98492af]
- Updated dependencies [2a505df]
- Updated dependencies [ec25a00]
- Updated dependencies [4a14c92]
- Updated dependencies [aa159b9]
- Updated dependencies [d55b4cd]
- Updated dependencies [48bf765]
  - @substrat-run/attachment-extractors@0.2.0
  - @substrat-run/kernel@0.139.0
  - @substrat-run/adapter-sqlite@0.139.0
  - @substrat-run/contracts@0.139.0
  - @substrat-run/vertical-host@0.139.0
  - @substrat-run/engine-invoicing@0.11.23
  - @substrat-run/engine-protocol@0.13.24
  - @substrat-run/engine-workorder@0.12.23
  - @substrat-run/dev-issuer@0.2.21

## 0.1.56

### Patch Changes

- Updated dependencies [d5739ca]
- Updated dependencies [50ce5e0]
- Updated dependencies [59972cb]
- Updated dependencies [6476e71]
- Updated dependencies [d08b9b1]
- Updated dependencies [f33b1c3]
- Updated dependencies [bc6cc57]
- Updated dependencies [921dfa3]
  - @substrat-run/adapter-sqlite@0.138.0
  - @substrat-run/kernel@0.138.0
  - @substrat-run/vertical-host@0.138.0
  - @substrat-run/contracts@0.138.0
  - @substrat-run/engine-protocol@0.13.23
  - @substrat-run/engine-invoicing@0.11.22
  - @substrat-run/engine-workorder@0.12.22
  - @substrat-run/attachment-extractors@0.1.4
  - @substrat-run/dev-issuer@0.2.20

## 0.1.55

### Patch Changes

- Updated dependencies [7559e1a]
- Updated dependencies [21055d5]
- Updated dependencies [b641075]
- Updated dependencies [7adf5c7]
- Updated dependencies [1c411fc]
- Updated dependencies [fcb587d]
  - @substrat-run/contracts@0.137.0
  - @substrat-run/kernel@0.137.0
  - @substrat-run/vertical-host@0.137.0
  - @substrat-run/adapter-sqlite@0.137.0
  - @substrat-run/engine-protocol@0.13.22
  - @substrat-run/dev-issuer@0.2.19
  - @substrat-run/engine-invoicing@0.11.21
  - @substrat-run/engine-workorder@0.12.21
  - @substrat-run/attachment-extractors@0.1.3

## 0.1.54

### Patch Changes

- Updated dependencies [1af2d47]
- Updated dependencies [fb1f624]
- Updated dependencies [4fdad69]
- Updated dependencies [4964eb8]
- Updated dependencies [30c2cda]
- Updated dependencies [b9b3b82]
- Updated dependencies [3ed9e9d]
- Updated dependencies [cdf32ab]
- Updated dependencies [7a28aea]
- Updated dependencies [7418e7e]
- Updated dependencies [18069f9]
  - @substrat-run/kernel@0.136.0
  - @substrat-run/adapter-sqlite@0.136.0
  - @substrat-run/contracts@0.136.0
  - @substrat-run/vertical-host@0.136.0
  - @substrat-run/engine-invoicing@0.11.20
  - @substrat-run/engine-protocol@0.13.21
  - @substrat-run/engine-workorder@0.12.20
  - @substrat-run/attachment-extractors@0.1.2
  - @substrat-run/dev-issuer@0.2.18

## 0.1.53

### Patch Changes

- Updated dependencies [8267b83]
- Updated dependencies [1dca2da]
- Updated dependencies [3328549]
- Updated dependencies [8c64633]
- Updated dependencies [5d41454]
  - @substrat-run/kernel@0.135.0
  - @substrat-run/contracts@0.135.0
  - @substrat-run/adapter-sqlite@0.135.0
  - @substrat-run/vertical-host@0.135.0
  - @substrat-run/engine-invoicing@0.11.19
  - @substrat-run/engine-protocol@0.13.20
  - @substrat-run/engine-workorder@0.12.19
  - @substrat-run/dev-issuer@0.2.17

## 0.1.52

### Patch Changes

- Updated dependencies [176fe60]
- Updated dependencies [4347933]
- Updated dependencies [4347933]
- Updated dependencies [1addd27]
- Updated dependencies [560eec4]
- Updated dependencies [6f7c650]
  - @substrat-run/kernel@0.134.0
  - @substrat-run/adapter-sqlite@0.134.0
  - @substrat-run/contracts@0.134.0
  - @substrat-run/engine-invoicing@0.11.18
  - @substrat-run/engine-protocol@0.13.19
  - @substrat-run/engine-workorder@0.12.18
  - @substrat-run/vertical-host@0.134.0
  - @substrat-run/dev-issuer@0.2.16

## 0.1.51

### Patch Changes

- Updated dependencies [8a32578]
- Updated dependencies [c74c091]
- Updated dependencies [a08c42e]
- Updated dependencies [a128e65]
  - @substrat-run/kernel@0.133.0
  - @substrat-run/adapter-sqlite@0.133.0
  - @substrat-run/contracts@0.133.0
  - @substrat-run/engine-invoicing@0.11.17
  - @substrat-run/engine-protocol@0.13.18
  - @substrat-run/engine-workorder@0.12.17
  - @substrat-run/dev-issuer@0.2.15
  - @substrat-run/vertical-host@0.133.0

## 0.1.50

### Patch Changes

- Updated dependencies [56952c5]
  - @substrat-run/vertical-host@0.132.0
  - @substrat-run/adapter-sqlite@0.132.0
  - @substrat-run/dev-issuer@0.2.14
  - @substrat-run/contracts@0.132.0
  - @substrat-run/kernel@0.132.0
  - @substrat-run/engine-protocol@0.13.17
  - @substrat-run/engine-invoicing@0.11.16
  - @substrat-run/engine-workorder@0.12.16

## 0.1.49

### Patch Changes

- Updated dependencies [012b2c8]
- Updated dependencies [56091f8]
- Updated dependencies [e5c21fc]
  - @substrat-run/contracts@0.131.0
  - @substrat-run/kernel@0.131.0
  - @substrat-run/adapter-sqlite@0.131.0
  - @substrat-run/engine-invoicing@0.11.15
  - @substrat-run/engine-protocol@0.13.16
  - @substrat-run/engine-workorder@0.12.15
  - @substrat-run/dev-issuer@0.2.13
  - @substrat-run/vertical-host@0.131.0

## 0.1.48

### Patch Changes

- Updated dependencies [65a0690]
- Updated dependencies [b53ecff]
- Updated dependencies [8236531]
  - @substrat-run/kernel@0.130.0
  - @substrat-run/adapter-sqlite@0.130.0
  - @substrat-run/contracts@0.130.0
  - @substrat-run/vertical-host@0.130.0
  - @substrat-run/engine-workorder@0.12.14
  - @substrat-run/engine-invoicing@0.11.14
  - @substrat-run/engine-protocol@0.13.14
  - @substrat-run/dev-issuer@0.2.12

## 0.1.47

### Patch Changes

- Updated dependencies [b213bfc]
- Updated dependencies [6f532ef]
  - @substrat-run/contracts@0.129.0
  - @substrat-run/kernel@0.129.0
  - @substrat-run/adapter-sqlite@0.129.0
  - @substrat-run/engine-invoicing@0.11.13
  - @substrat-run/engine-protocol@0.13.13
  - @substrat-run/engine-workorder@0.12.13
  - @substrat-run/dev-issuer@0.2.11
  - @substrat-run/vertical-host@0.129.0

## 0.1.46

### Patch Changes

- Updated dependencies [260fb5a]
- Updated dependencies [4a53af7]
- Updated dependencies [4ba2a52]
- Updated dependencies [f79e8ba]
- Updated dependencies [ba75c81]
  - @substrat-run/contracts@0.128.0
  - @substrat-run/kernel@0.128.0
  - @substrat-run/adapter-sqlite@0.128.0
  - @substrat-run/vertical-host@0.128.0
  - @substrat-run/engine-invoicing@0.11.12
  - @substrat-run/engine-protocol@0.13.12
  - @substrat-run/engine-workorder@0.12.12
  - @substrat-run/dev-issuer@0.2.10

## 0.1.45

### Patch Changes

- Updated dependencies [2f1e5f5]
- Updated dependencies [b6248b0]
  - @substrat-run/kernel@0.127.0
  - @substrat-run/vertical-host@0.127.0
  - @substrat-run/engine-invoicing@0.11.11
  - @substrat-run/engine-protocol@0.13.11
  - @substrat-run/engine-workorder@0.12.11
  - @substrat-run/adapter-sqlite@0.127.0
  - @substrat-run/contracts@0.127.0
  - @substrat-run/dev-issuer@0.2.9

## 0.1.44

### Patch Changes

- Updated dependencies [6d57761]
- Updated dependencies [c78e713]
- Updated dependencies [e1526a0]
  - @substrat-run/contracts@0.126.0
  - @substrat-run/kernel@0.126.0
  - @substrat-run/adapter-sqlite@0.126.0
  - @substrat-run/vertical-host@0.126.0
  - @substrat-run/engine-invoicing@0.11.10
  - @substrat-run/engine-protocol@0.13.10
  - @substrat-run/engine-workorder@0.12.10
  - @substrat-run/dev-issuer@0.2.8

## 0.1.43

### Patch Changes

- Updated dependencies [e8d4860]
- Updated dependencies [9ebacee]
  - @substrat-run/contracts@0.125.0
  - @substrat-run/kernel@0.125.0
  - @substrat-run/adapter-sqlite@0.125.0
  - @substrat-run/vertical-host@0.125.0
  - @substrat-run/engine-invoicing@0.11.9
  - @substrat-run/engine-protocol@0.13.9
  - @substrat-run/engine-workorder@0.12.9
  - @substrat-run/dev-issuer@0.2.7

## 0.1.42

### Patch Changes

- Updated dependencies [90d0f02]
- Updated dependencies [02942e0]
- Updated dependencies [6fd31c2]
- Updated dependencies [931b8d6]
- Updated dependencies [558f103]
- Updated dependencies [45421e8]
  - @substrat-run/kernel@0.124.0
  - @substrat-run/adapter-sqlite@0.124.0
  - @substrat-run/contracts@0.124.0
  - @substrat-run/vertical-host@0.124.0
  - @substrat-run/engine-invoicing@0.11.8
  - @substrat-run/engine-protocol@0.13.8
  - @substrat-run/engine-workorder@0.12.8
  - @substrat-run/dev-issuer@0.2.6

## 0.1.41

### Patch Changes

- Updated dependencies [f56e9eb]
- Updated dependencies [6b3cb45]
- Updated dependencies [e46057e]
- Updated dependencies [ae19d01]
- Updated dependencies [5dd5b3a]
- Updated dependencies [30b09c6]
- Updated dependencies [d423d10]
- Updated dependencies [0f96a8e]
- Updated dependencies [bd8f408]
- Updated dependencies [3b28c46]
  - @substrat-run/contracts@0.123.0
  - @substrat-run/kernel@0.123.0
  - @substrat-run/adapter-sqlite@0.123.0
  - @substrat-run/engine-invoicing@0.11.7
  - @substrat-run/engine-protocol@0.13.7
  - @substrat-run/engine-workorder@0.12.7
  - @substrat-run/vertical-host@0.123.0
  - @substrat-run/dev-issuer@0.2.5

## 0.1.40

### Patch Changes

- Updated dependencies [0803833]
- Updated dependencies [1e326dd]
- Updated dependencies [3a3338d]
  - @substrat-run/contracts@0.122.0
  - @substrat-run/kernel@0.122.0
  - @substrat-run/adapter-sqlite@0.122.0
  - @substrat-run/engine-invoicing@0.11.6
  - @substrat-run/engine-protocol@0.13.6
  - @substrat-run/engine-workorder@0.12.6
  - @substrat-run/dev-issuer@0.2.4
  - @substrat-run/vertical-host@0.122.0

## 0.1.39

### Patch Changes

- Updated dependencies [a235648]
- Updated dependencies [6fc9950]
- Updated dependencies [48fea30]
- Updated dependencies [a6f4db1]
- Updated dependencies [45b927e]
  - @substrat-run/contracts@0.121.0
  - @substrat-run/kernel@0.121.0
  - @substrat-run/adapter-sqlite@0.121.0
  - @substrat-run/vertical-host@0.121.0
  - @substrat-run/engine-invoicing@0.11.5
  - @substrat-run/engine-protocol@0.13.5
  - @substrat-run/engine-workorder@0.12.5
  - @substrat-run/dev-issuer@0.2.3

## 0.1.38

### Patch Changes

- Updated dependencies [96e0ad5]
- Updated dependencies [1de077d]
- Updated dependencies [09acfdd]
  - @substrat-run/adapter-sqlite@0.120.0
  - @substrat-run/kernel@0.120.0
  - @substrat-run/contracts@0.120.0
  - @substrat-run/vertical-host@0.120.0
  - @substrat-run/engine-protocol@0.13.4
  - @substrat-run/engine-invoicing@0.11.4
  - @substrat-run/engine-workorder@0.12.4
  - @substrat-run/dev-issuer@0.2.2

## 0.1.37

### Patch Changes

- Updated dependencies [bc6a6bb]
- Updated dependencies [bb10d6d]
- Updated dependencies [84b5fe2]
- Updated dependencies [929ec09]
- Updated dependencies [a9cfc4a]
- Updated dependencies [b2cbdf8]
- Updated dependencies [bd5c543]
- Updated dependencies [2c65b67]
- Updated dependencies [8009cd1]
- Updated dependencies [b080e0f]
- Updated dependencies [e7113ea]
  - @substrat-run/kernel@0.119.0
  - @substrat-run/adapter-sqlite@0.119.0
  - @substrat-run/vertical-host@0.119.0
  - @substrat-run/contracts@0.119.0
  - @substrat-run/engine-invoicing@0.11.3
  - @substrat-run/engine-protocol@0.13.3
  - @substrat-run/engine-workorder@0.12.3
  - @substrat-run/dev-issuer@0.2.1

## 0.1.36

### Patch Changes

- Updated dependencies [030fafd]
- Updated dependencies [56a931b]
- Updated dependencies [429cc84]
  - @substrat-run/contracts@0.118.0
  - @substrat-run/dev-issuer@0.2.0
  - @substrat-run/kernel@0.118.0
  - @substrat-run/adapter-sqlite@0.118.0
  - @substrat-run/engine-invoicing@0.11.2
  - @substrat-run/engine-protocol@0.13.2
  - @substrat-run/engine-workorder@0.12.2
  - @substrat-run/vertical-host@0.118.0

## 0.1.35

### Patch Changes

- Updated dependencies [6504a99]
- Updated dependencies [aabc227]
- Updated dependencies [fb37a3e]
- Updated dependencies [df5bf46]
- Updated dependencies [44299a1]
- Updated dependencies [4ef164c]
- Updated dependencies [d7eb089]
- Updated dependencies [269fa7a]
- Updated dependencies [105a4c3]
- Updated dependencies [091e7d3]
- Updated dependencies [82a123f]
- Updated dependencies [a8c2c64]
- Updated dependencies [02c181a]
- Updated dependencies [2fa5147]
- Updated dependencies [1f223f5]
  - @substrat-run/contracts@0.117.0
  - @substrat-run/kernel@0.117.0
  - @substrat-run/adapter-sqlite@0.117.0
  - @substrat-run/vertical-host@0.117.0
  - @substrat-run/engine-invoicing@0.11.1
  - @substrat-run/engine-protocol@0.13.1
  - @substrat-run/engine-workorder@0.12.1
  - @substrat-run/dev-issuer@0.1.32

## 0.1.34

### Patch Changes

- Updated dependencies [e22db55]
- Updated dependencies [a67c59b]
- Updated dependencies [2b5d215]
- Updated dependencies [45d2f15]
- Updated dependencies [e99332e]
- Updated dependencies [1c55458]
- Updated dependencies [0b993ff]
- Updated dependencies [70c1dc7]
- Updated dependencies [93710da]
- Updated dependencies [b9d6a7b]
- Updated dependencies [ebe283f]
  - @substrat-run/contracts@0.116.0
  - @substrat-run/kernel@0.116.0
  - @substrat-run/adapter-sqlite@0.116.0
  - @substrat-run/engine-invoicing@0.11.0
  - @substrat-run/engine-protocol@0.13.0
  - @substrat-run/engine-workorder@0.12.0
  - @substrat-run/vertical-host@0.116.0
  - @substrat-run/dev-issuer@0.1.31

## 0.1.33

### Patch Changes

- Updated dependencies [1a6fe4d]
  - @substrat-run/contracts@0.115.0
  - @substrat-run/kernel@0.115.0
  - @substrat-run/adapter-sqlite@0.115.0
  - @substrat-run/engine-invoicing@0.10.5
  - @substrat-run/engine-protocol@0.12.20
  - @substrat-run/engine-workorder@0.11.14
  - @substrat-run/dev-issuer@0.1.30
  - @substrat-run/vertical-host@0.115.0

## 0.1.32

### Patch Changes

- Updated dependencies [f58aa74]
  - @substrat-run/contracts@0.114.0
  - @substrat-run/kernel@0.114.0
  - @substrat-run/adapter-sqlite@0.114.0
  - @substrat-run/vertical-host@0.114.0
  - @substrat-run/engine-invoicing@0.10.4
  - @substrat-run/engine-protocol@0.12.19
  - @substrat-run/engine-workorder@0.11.13
  - @substrat-run/dev-issuer@0.1.29

## 0.1.31

### Patch Changes

- Updated dependencies [c146761]
- Updated dependencies [c3c92e9]
- Updated dependencies [2fc7187]
- Updated dependencies [7e6f925]
  - @substrat-run/contracts@0.113.0
  - @substrat-run/kernel@0.113.0
  - @substrat-run/adapter-sqlite@0.113.0
  - @substrat-run/vertical-host@0.113.0
  - @substrat-run/engine-invoicing@0.10.3
  - @substrat-run/engine-protocol@0.12.18
  - @substrat-run/engine-workorder@0.11.12
  - @substrat-run/dev-issuer@0.1.28

## 0.1.30

### Patch Changes

- Updated dependencies [c697b15]
- Updated dependencies [db6a96f]
- Updated dependencies [221f94a]
- Updated dependencies [a5d24f7]
- Updated dependencies [f4d12b7]
  - @substrat-run/contracts@0.112.0
  - @substrat-run/kernel@0.112.0
  - @substrat-run/adapter-sqlite@0.112.0
  - @substrat-run/vertical-host@0.112.0
  - @substrat-run/engine-invoicing@0.10.2
  - @substrat-run/engine-protocol@0.12.17
  - @substrat-run/engine-workorder@0.11.11
  - @substrat-run/dev-issuer@0.1.27

## 0.1.29

### Patch Changes

- Updated dependencies [f08bfc4]
- Updated dependencies [aaafae3]
- Updated dependencies [1b2506c]
  - @substrat-run/contracts@0.111.0
  - @substrat-run/kernel@0.111.0
  - @substrat-run/adapter-sqlite@0.111.0
  - @substrat-run/vertical-host@0.111.0
  - @substrat-run/engine-invoicing@0.10.1
  - @substrat-run/engine-protocol@0.12.16
  - @substrat-run/engine-workorder@0.11.10
  - @substrat-run/dev-issuer@0.1.26

## 0.1.28

### Patch Changes

- Updated dependencies [a195037]
- Updated dependencies [8758949]
- Updated dependencies [d05689d]
- Updated dependencies [0257dbd]
- Updated dependencies [5b299fe]
- Updated dependencies [cb88aa1]
  - @substrat-run/contracts@0.110.0
  - @substrat-run/kernel@0.110.0
  - @substrat-run/adapter-sqlite@0.110.0
  - @substrat-run/engine-invoicing@0.10.0
  - @substrat-run/engine-protocol@0.12.15
  - @substrat-run/engine-workorder@0.11.9
  - @substrat-run/dev-issuer@0.1.25
  - @substrat-run/vertical-host@0.110.0

## 0.1.27

### Patch Changes

- Updated dependencies [7aa3ea5]
- Updated dependencies [6999cad]
- Updated dependencies [1e175ce]
- Updated dependencies [4fc7db2]
- Updated dependencies [5200b90]
- Updated dependencies [62f4e87]
  - @substrat-run/contracts@0.109.0
  - @substrat-run/kernel@0.109.0
  - @substrat-run/adapter-sqlite@0.109.0
  - @substrat-run/vertical-host@0.109.0
  - @substrat-run/engine-invoicing@0.9.25
  - @substrat-run/engine-protocol@0.12.14
  - @substrat-run/engine-workorder@0.11.8
  - @substrat-run/dev-issuer@0.1.24

## 0.1.26

### Patch Changes

- Updated dependencies [5e80e5f]
- Updated dependencies [5cf7ae4]
- Updated dependencies [44b53e4]
  - @substrat-run/kernel@0.108.0
  - @substrat-run/contracts@0.108.0
  - @substrat-run/adapter-sqlite@0.108.0
  - @substrat-run/vertical-host@0.108.0
  - @substrat-run/engine-invoicing@0.9.24
  - @substrat-run/engine-protocol@0.12.13
  - @substrat-run/engine-workorder@0.11.7
  - @substrat-run/dev-issuer@0.1.23

## 0.1.25

### Patch Changes

- Updated dependencies [bf9490a]
- Updated dependencies [4a6c4c3]
  - @substrat-run/kernel@0.107.0
  - @substrat-run/adapter-sqlite@0.107.0
  - @substrat-run/contracts@0.107.0
  - @substrat-run/engine-invoicing@0.9.23
  - @substrat-run/engine-protocol@0.12.12
  - @substrat-run/engine-workorder@0.11.6
  - @substrat-run/vertical-host@0.107.0
  - @substrat-run/dev-issuer@0.1.22

## 0.1.24

### Patch Changes

- Updated dependencies [2956182]
  - @substrat-run/kernel@0.106.0
  - @substrat-run/adapter-sqlite@0.106.0
  - @substrat-run/engine-invoicing@0.9.22
  - @substrat-run/engine-protocol@0.12.11
  - @substrat-run/engine-workorder@0.11.5
  - @substrat-run/vertical-host@0.106.0
  - @substrat-run/contracts@0.106.0
  - @substrat-run/dev-issuer@0.1.21

## 0.1.23

### Patch Changes

- Updated dependencies [2338a8b]
- Updated dependencies [5201683]
  - @substrat-run/adapter-sqlite@0.105.0
  - @substrat-run/kernel@0.105.0
  - @substrat-run/vertical-host@0.105.0
  - @substrat-run/engine-protocol@0.12.10
  - @substrat-run/engine-invoicing@0.9.21
  - @substrat-run/engine-workorder@0.11.4
  - @substrat-run/contracts@0.105.0
  - @substrat-run/dev-issuer@0.1.20

## 0.1.22

### Patch Changes

- Updated dependencies [dd999a9]
  - @substrat-run/contracts@0.104.0
  - @substrat-run/adapter-sqlite@0.104.0
  - @substrat-run/engine-invoicing@0.9.20
  - @substrat-run/engine-protocol@0.12.9
  - @substrat-run/engine-workorder@0.11.3
  - @substrat-run/dev-issuer@0.1.19
  - @substrat-run/kernel@0.104.0
  - @substrat-run/vertical-host@0.104.0

## 0.1.21

### Patch Changes

- Updated dependencies [dc9995c]
- Updated dependencies [dcde11e]
- Updated dependencies [adf6bfb]
  - @substrat-run/contracts@0.103.0
  - @substrat-run/engine-workorder@0.11.2
  - @substrat-run/engine-protocol@0.12.8
  - @substrat-run/engine-invoicing@0.9.19
  - @substrat-run/kernel@0.103.0
  - @substrat-run/vertical-host@0.103.0
  - @substrat-run/adapter-sqlite@0.103.0
  - @substrat-run/dev-issuer@0.1.18

## 0.1.20

### Patch Changes

- Updated dependencies [46051ee]
- Updated dependencies [e7115b2]
- Updated dependencies [3e67ebe]
- Updated dependencies [ea6b99f]
  - @substrat-run/kernel@0.102.0
  - @substrat-run/adapter-sqlite@0.102.0
  - @substrat-run/contracts@0.102.0
  - @substrat-run/engine-workorder@0.11.1
  - @substrat-run/engine-invoicing@0.9.18
  - @substrat-run/engine-protocol@0.12.7
  - @substrat-run/vertical-host@0.102.0
  - @substrat-run/dev-issuer@0.1.17

## 0.1.19

### Patch Changes

- Updated dependencies [b61c4d5]
- Updated dependencies [306b893]
- Updated dependencies [8406843]
  - @substrat-run/contracts@0.101.0
  - @substrat-run/kernel@0.101.0
  - @substrat-run/adapter-sqlite@0.101.0
  - @substrat-run/engine-workorder@0.11.0
  - @substrat-run/engine-invoicing@0.9.17
  - @substrat-run/engine-protocol@0.12.6
  - @substrat-run/dev-issuer@0.1.16
  - @substrat-run/vertical-host@0.101.0

## 0.1.18

### Patch Changes

- Updated dependencies [fcd2047]
- Updated dependencies [0cd3055]
- Updated dependencies [4b159da]
- Updated dependencies [d1a5a58]
- Updated dependencies [8912fb8]
- Updated dependencies [6b3e466]
  - @substrat-run/adapter-sqlite@0.100.0
  - @substrat-run/contracts@0.100.0
  - @substrat-run/kernel@0.100.0
  - @substrat-run/engine-protocol@0.12.5
  - @substrat-run/engine-invoicing@0.9.16
  - @substrat-run/engine-workorder@0.10.8
  - @substrat-run/dev-issuer@0.1.15
  - @substrat-run/vertical-host@0.100.0

## 0.1.17

### Patch Changes

- Updated dependencies [e398034]
- Updated dependencies [28a82c0]
- Updated dependencies [d124e9a]
- Updated dependencies [8e29866]
- Updated dependencies [02793d9]
  - @substrat-run/contracts@0.99.0
  - @substrat-run/kernel@0.99.0
  - @substrat-run/adapter-sqlite@0.99.0
  - @substrat-run/engine-invoicing@0.9.15
  - @substrat-run/engine-protocol@0.12.4
  - @substrat-run/engine-workorder@0.10.7
  - @substrat-run/dev-issuer@0.1.14
  - @substrat-run/vertical-host@0.99.0

## 0.1.16

### Patch Changes

- Updated dependencies [05de166]
- Updated dependencies [07203fb]
- Updated dependencies [ee70af5]
  - @substrat-run/adapter-sqlite@0.98.0
  - @substrat-run/contracts@0.98.0
  - @substrat-run/kernel@0.98.0
  - @substrat-run/vertical-host@0.98.0
  - @substrat-run/engine-protocol@0.12.3
  - @substrat-run/engine-invoicing@0.9.14
  - @substrat-run/engine-workorder@0.10.6
  - @substrat-run/dev-issuer@0.1.13

## 0.1.15

### Patch Changes

- Updated dependencies [9fcfebc]
- Updated dependencies [59121f6]
  - @substrat-run/vertical-host@0.97.0
  - @substrat-run/contracts@0.97.0
  - @substrat-run/kernel@0.97.0
  - @substrat-run/engine-invoicing@0.9.13
  - @substrat-run/engine-protocol@0.12.2
  - @substrat-run/engine-workorder@0.10.5
  - @substrat-run/adapter-sqlite@0.97.0

## 0.1.14

### Patch Changes

- Updated dependencies [218d39a]
- Updated dependencies [db5a3da]
- Updated dependencies [d0cde56]
  - @substrat-run/vertical-host@0.96.0
  - @substrat-run/contracts@0.96.0
  - @substrat-run/kernel@0.96.0
  - @substrat-run/adapter-sqlite@0.96.0
  - @substrat-run/engine-invoicing@0.9.12
  - @substrat-run/engine-protocol@0.12.1
  - @substrat-run/engine-workorder@0.10.4

## 0.1.13

### Patch Changes

- Updated dependencies [b81f21b]
  - @substrat-run/engine-protocol@0.12.0

## 0.1.12

### Patch Changes

- Updated dependencies [f065a84]
- Updated dependencies [301ac66]
- Updated dependencies [7bf77df]
- Updated dependencies [4f641a7]
  - @substrat-run/contracts@0.95.0
  - @substrat-run/engine-protocol@0.11.12
  - @substrat-run/engine-invoicing@0.9.11
  - @substrat-run/engine-workorder@0.10.3
  - @substrat-run/adapter-sqlite@0.95.0
  - @substrat-run/kernel@0.95.0
  - @substrat-run/vertical-host@0.95.0

## 0.1.11

### Patch Changes

- Updated dependencies [b91753e]
- Updated dependencies [3e7445e]
- Updated dependencies [692cb92]
- Updated dependencies [c9f3bac]
- Updated dependencies [e6dbb7b]
- Updated dependencies [568ba88]
- Updated dependencies [1fc01d3]
- Updated dependencies [733469b]
- Updated dependencies [35147a9]
- Updated dependencies [35147a9]
  - @substrat-run/engine-workorder@0.10.2
  - @substrat-run/engine-protocol@0.11.11
  - @substrat-run/engine-invoicing@0.9.10
  - @substrat-run/contracts@0.94.0
  - @substrat-run/adapter-sqlite@0.94.0
  - @substrat-run/kernel@0.94.0
  - @substrat-run/vertical-host@0.94.0

## 0.1.10

### Patch Changes

- Updated dependencies [4bbcf6b]
- Updated dependencies [722c2cc]
- Updated dependencies [df4ffd1]
- Updated dependencies [0a536b7]
- Updated dependencies [9606869]
  - @substrat-run/vertical-host@0.93.0
  - @substrat-run/contracts@0.93.0
  - @substrat-run/kernel@0.93.0
  - @substrat-run/adapter-sqlite@0.93.0
  - @substrat-run/engine-invoicing@0.9.9
  - @substrat-run/engine-protocol@0.11.10
  - @substrat-run/engine-workorder@0.10.1

## 0.1.9

### Patch Changes

- Updated dependencies [7843c4f]
- Updated dependencies [d9793bc]
- Updated dependencies [7ad9ec8]
  - @substrat-run/contracts@0.92.0
  - @substrat-run/engine-workorder@0.10.0
  - @substrat-run/engine-invoicing@0.9.8
  - @substrat-run/engine-protocol@0.11.9
  - @substrat-run/adapter-sqlite@0.92.0
  - @substrat-run/kernel@0.92.0
  - @substrat-run/vertical-host@0.92.0

## 0.1.8

### Patch Changes

- Updated dependencies [75bd27c]
  - @substrat-run/vertical-host@0.91.0
  - @substrat-run/contracts@0.91.0
  - @substrat-run/engine-invoicing@0.9.7
  - @substrat-run/engine-protocol@0.11.7
  - @substrat-run/engine-workorder@0.9.2
  - @substrat-run/adapter-sqlite@0.91.0
  - @substrat-run/kernel@0.91.0

## 0.1.7

### Patch Changes

- Updated dependencies [ec1f8e8]
- Updated dependencies [3561f7f]
  - @substrat-run/contracts@0.90.0
  - @substrat-run/kernel@0.90.0
  - @substrat-run/adapter-sqlite@0.90.0
  - @substrat-run/engine-invoicing@0.9.6
  - @substrat-run/engine-protocol@0.11.6
  - @substrat-run/engine-workorder@0.9.1
  - @substrat-run/vertical-host@0.90.0

## 0.1.6

### Patch Changes

- c601b68: An entity's history is a read the kernel owns

  Reading `_substrat_outbox` for one entity is a sanctioned projection — rule 3 bans writes
  to the spine, not reads, because "show me the history of this thing" has no other source.
  What was missing was a supported SHAPE, and five demos wrote the query by hand in its
  absence. They did not agree, and the disagreements were not cosmetic.

  | Demo               | Order                | Cursor        |
  | ------------------ | -------------------- | ------------- |
  | callout, handlebar | `rowid`              | `rowid`       |
  | meridian, rally    | `occurred_at, rowid` | `occurred_at` |
  | manyfold           | `rowid`              | _(unpaged)_   |

  **Meridian's and rally's paging dropped events.** The step was `occurred_at > ?`, so every
  row sharing the last one's timestamp was skipped — and sharing it is the norm, not a rare
  tie: `ctx.now()` is stable for a whole invocation (#812), so every event one operation
  emits carries the identical instant. A page boundary inside them lost the rest, and no
  test would have caught it.

  ```ts
  import { readTimeline } from "@substrat-run/kernel";

  assertAllowed(await ctx.check(WO.read, entity)); // the caller checks. always
  return readTimeline(ctx, entity, input); // { entries, nextCursor }
  ```

  Each entry is `{ id, type, occurredAt, actor }`, and two of those four are not what the
  hand-written `SELECT` was getting:

  - **`actor` is the union, decoded.** The column stores `JSON.stringify(actor)` over
    `PrincipalId | { system } | { connection }`, so a principal is stored _with its quotes_.
    `SELECT actor` returns a string that looks usable and is not; the obvious repair — trim
    the quotes — then breaks on a system actor. An agent building a timeline hit this as a
    real bug and had to read the adapter source to find it.
  - **`id` is the entity's version at that point** (#901) — the token `ctx.versionOf`
    returns and `If-Match` compares (#129), so listing the history, naming a version and
    refusing a stale write stop being three vocabularies. It is therefore the cursor:
    `ORDER BY id` is creation order because `ulid()` is monotonic, and `OUTBOX_ENTITY_INDEX`
    makes the walk a seek with no new DDL. A `rowid` cursor could use neither, and does not
    survive a restore.

  `readHistory` is the same walk with what a history VIEW needs — `payload`, `authorization`
  (which permission, and which grant), `piiClass`/`subjectId`. Two nullables there are facts
  rather than gaps: **`payload` is null after an erasure**, because a shred keeps the
  envelope and destroys what was said, so a history correctly degrades to "someone changed
  this, then"; and `authorization` is null when the row predates it being recorded, which is
  not the same as having checked nothing.

  Neither read checks a permission, deliberately. A helper that gated itself would be a
  second, invisible policy surface; one that gated itself on nothing would be an unchecked
  path into every event in the scope. Both are worse than the one line at the call site.

  Also fixed on the way: Callout's and Handlebar's hand-mounted timeline routes never applied
  the page projection `mountOperations` does for declared routes, so since these operations
  became paged (#811) they answered `{ entries, nextCursor }` to an app that typed the body
  as an array and called `.map` on it. The scenarios invoke the operation and never the
  route, so nothing saw it. Both now emit the `Link` continuation and both apps WALK it —
  reading only the body is how a history strip silently stops at twenty events, which an
  order reaches in a working week — and a route-level test drives more events than one page
  fits over real HTTP, since that is the only layer where the truncation exists.

  Both adapters are held to all of it by a new contract suite.

- 2352a3b: Every surface answers problem+json — and the message-matching goes with it

  `/openapi.json` has said `application/problem+json` on every error response since the error
  model's first phase. Nothing served one. Seven verticals, the scaffold template and the
  control plane each hand-rolled a handler that read a status out of an error's **prose** —
  `/not found/` → 404, `/out of stock/` → 409, `/cannot edit|frozen|already/` → 409 — and
  answered `{ error: "<message>" }`. This is phase 4 of #113: the transports read the code.

  ```http
  409 Conflict
  content-type: application/problem+json
  ```

  ```json
  {
    "type": "https://substrat.net/errors/conflict",
    "title": "Conflict",
    "status": 409,
    "detail": "out of stock: SKU-14 — 2 available, 5 requested",
    "code": "conflict",
    "reason": "out_of_stock",
    "instance": "/api/op/shop/add-to-cart",
    "error": "out of stock: SKU-14 — 2 available, 5 requested"
  }
  ```

  **The patterns were not kept as a fallback; the throw sites were typed instead.** A regex
  table living beside typed throws is a table nobody maintains. So 73 raw `new Error(...)`
  across the six verticals became `substratError('conflict', …, { reason })` — the platform
  owns the code, the vertical owns the reason — and the two platform refusals every vertical
  had independently hand-matched (`unknown operation`, `operation not entitled`) are typed in
  the adapters and the kernel where they are raised. Seven `onError` handlers are one line
  each now. `problemResponse(c, err)` is exported from `@substrat-run/vertical-host` and is
  what the scaffold template ships with.

  **A body with no `code` is information.** Two failures reach a transport that the closed
  taxonomy cannot name: a throw nobody typed (answered with the caller's 400, deliberately —
  an unrecognised throw must not claim to be the platform's fault) and a status raised
  somewhere else (a downstream vertical's refusal, a Durable Object fault's 502). Those get
  RFC 9457's `about:blank` form — status, message, no code — because inventing one would put
  our vocabulary on a failure we cannot describe, and a client switching on `code` would
  match it. `problem.code` is optional in the schema for exactly that reason, and the absence
  doubles as a visible to-do list: every one marks a throw site still untyped.

  **Nothing breaks.** `error` still duplicates `detail` on every body, which is why roughly
  thirty contract-suite assertions on message text, and every SPA in the repo, went green
  untouched. It goes in phase 5, along with the last patterns; `detail` is what to read.

  Three deliberate exclusions, stated rather than hidden:

  - **`engine-booking`'s `SlotUnavailable`** publishes its own `code = 'SLOT_UNAVAILABLE'`,
    which both RallyPoint clients switch on. An engine surface evolves additively only, so
    retyping it is a dual-emit through a deprecation window — `demos/rally` answers it by
    hand and says so.
  - **`demos/auth-server`** is an OIDC issuer whose OAuth endpoints owe RFC 6749 error
    bodies, where `error` is an OAuth code rather than a message. Merging the two
    vocabularies on one surface is the OAuth work's call, not a transport sweep's.
  - **The control plane's 23 remaining patterns** cover untyped `HostAdmin` throws. The table
    names a **code** per row now instead of a status, so an entry says what the failure IS and
    the status follows from the catalog — the two can no longer disagree.

  **Statuses moved, and that is the point.** A vertical's default for anything its pattern
  list did not recognise was the caller's 400, so every domain refusal that did not happen to
  say "not found" arrived as one: `cart is empty`, `discount code expired`, `the club is
closed on 2026-08-25`, `no employment terms set`, `only a submitted expense can be decided`.
  Those are 409 now — the request was well-formed and the state refused it — and `no such
plan` / `no such credit pack` are 404, which their wording had hidden from the pattern that
  would have caught them. No client in the repo branches on those statuses (the demo SPAs
  read `{ error }`, and only Todo's reads a status at all, for 403), so this lands as a
  correction rather than a break.

  One outright fix falls out: Manyfold's public delivery read of an unpublished slug answered
  409, because `not published` sat in an app-level pattern list that meant "conflict". It is a
  404 — the entry does not exist yet.

- Updated dependencies [73710de]
- Updated dependencies [c601b68]
- Updated dependencies [2352a3b]
- Updated dependencies [4f612fc]
  - @substrat-run/engine-workorder@0.9.0
  - @substrat-run/contracts@0.89.0
  - @substrat-run/kernel@0.89.0
  - @substrat-run/adapter-sqlite@0.89.0
  - @substrat-run/vertical-host@0.89.0
  - @substrat-run/engine-invoicing@0.9.5
  - @substrat-run/engine-protocol@0.11.5

## 0.1.5

### Patch Changes

- e401927: A narrowed check may name several entity types, and the schema says which

  Three timeline operations took `entityType: z.string()` and narrowed to whatever the caller
  named, while `{ key, entity, idFrom }` holds one fixed type. #889 declared `entity: 'workorder'`
  on two of them — accurate to the app, narrower than the operation — and filed #890 asking whether
  the answer was a new `entityFrom` field or simply a bounded input.

  **It is both, and the reason is a caller the issue did not know about.** Every call site in the
  app, the routes and the portal beats passes one constant, so the cheap answer looked complete:
  pin `z.literal('workorder')` and the declaration becomes exact. It isn't complete — Callout's
  §12 and Handlebar's counter-signature beat read a **protocol's** spine rows through the same
  operation. Two admissible types, then, not one, and the literal turned both scenarios red on
  first run, which is how the second type was found at all.

  - `entityFrom: 'entityType'` names the input field carrying the type, beside `idFrom` naming the
    one carrying the id. It is an alternative to `entity`, not an addition — one type or a field
    that names several.
  - **The admissible types are not listed in the declaration.** They are read off that field's own
    schema (`z.enum(['workorder', 'protocol'])`), so the set exists once. #890's own worry about
    `entityFrom` was that the kit would need a caller-written list, and a list a caller writes goes
    stale; reading the schema is what avoids it.
  - An open `z.string()` behind `entityFrom` is reported **uncovered with a reason**, never guessed
    at. `protocol/list-for-entity` is that shape and stays as it is — an engine cannot know its
    callers' nouns, which is the separate half of #890 (see the follow-up issue).

  **What the kit does with it.** An `entityFrom` operation is driven **once per admissible type**,
  so Callout's timeline now runs its pair over a work order _and_ over a protocol — 2 new generated
  tests per vertical, all passing, so the handlers were honouring both all along. The kit also reads
  a single-valued literal off the schema rather than being handed it: the three fixtures each
  restated their constant in `inputs`, a second copy that could disagree with the declaration, and
  Handlebar's was quietly deciding that only repairs got tested.

  Meridian's `hr/timeline` is the one-type case and keeps `entity: 'employee'`, with
  `z.literal('employee')` where the open string was.

  **Surface note, stated because it is a narrowing:** the three timelines now refuse an entity type
  they used to accept and answer with a validation error rather than a permission denial. No caller
  in the repo passes anything else, and the portal is unaffected — a portal customer reads her
  order's timeline as `entityType: 'workorder'` and her grant on the CUSTOMER reaches it through the
  parent walk (`workorder → facility → customer`), which is what makes the portal work. Meridian's
  `openapi.json` records the narrowing as `"const": "employee"`.

- 7cce6cd: auth-server: migrate to `@better-auth/oauth-provider`, and bump the fleet to Better Auth 1.7

  Better Auth 1.7 **removes** the in-core `oidcProvider` plugin (deprecated since 1.6). Our range
  was already `^1.6.23`, which permits 1.7 — so this was not a migration we could schedule, only
  one we could be surprised by: any dependency refresh would have taken the plugin away and left
  `demos/auth-server` unable to compile.

  The fleet bump is free. Only `admin`, `jwt` and `oidcProvider` are used anywhere in the
  workspace, and only auth-server uses the last two; vertical-auth, control-plane-api, rally,
  handlebar and shop are on email/password + `admin`, and pass unchanged on 1.7.1 (147 tests).

  **The schema is now generated, because hand-keeping it stopped being plausible.** Three tables
  became seven, with forty-odd columns. `db/ddl.generated.ts` and `src/auth-schema.generated.ts`
  are emitted by `scripts/gen-schema.mts` from `getAuthTables(auth.options)` — read off the real
  `buildAuth` config, not a parallel one — and `test/schema-generated.test.ts` re-emits, compares,
  and then **executes the DDL against a real database** and drives the adapter through it. That
  last part is not ceremony: 1.7 adds a required `issuer` column to `account`, a table that
  already existed, and a diff of hand-written DDL would not have flagged it while every password
  sign-in on an upgraded install would have failed.

  **Upgrading an existing store is not `IF NOT EXISTS`.** `db/upgrade.ts` runs before the DDL on
  every boot and handles the two places that construct is silently wrong: `account.issuer` is
  added and backfilled with `local:<provider_id>` (user credentials — carried, never dropped),
  and `oauth_access_token` / `oauth_consent`, whose NAMES 1.7 reuses with different columns, are
  renamed to `legacy_*` so the new DDL creates the new shape instead of leaving the old one in
  place for the plugin to query columns off. Renamed rather than dropped: a clean break is about
  not carrying the old registry forward, not about an unattended `DROP` on a live issuer. Per the
  decision on this change, **relying parties must be re-registered** after an upgrade; what was
  there stays readable under `legacy_oauth_application`.

  **What changed on the wire** — each of these would strand a relying party silently, so each is
  pinned in `test/oidc-flow.test.ts`:

  - **PKCE is mandatory**, confidential clients included. No `code_challenge` ⇒ `invalid_request`
    at the callback. Every RP pointed at this issuer needs it.
  - **The pending authorize request is no longer server-side state.** It travels as the entire
    signed query on the redirect to `/login` / `/signup` / `/consent`, and the page hands it back
    as `oauth_query`. A sign-in that omits it succeeds and resumes _nothing_ — #898's symptom
    through a new mechanism, so the suite asserts the omission fails as well as the inclusion
    working.
  - **Consent** takes `{ accept, oauth_query }` and answers Better Auth's redirect envelope
    (`{ redirect, url }`), not `consent_code` / `redirectURI`. The signed query is also what
    makes tampering detectable, since the request now travels through the browser.
  - **`client_secret_basic` is the default** auth method; the plugin refuses a body-posted secret
    from such a client. Carried-over integrations must register
    `token_endpoint_auth_method: 'client_secret_post'` or move the secret to the header.
  - **Discovery moved to the root** — the plugin serves `/.well-known/openid-configuration`
    itself, so `routes.ts`'s alias onto `/api/auth/…` is deleted rather than kept.
  - **The issuer identity is pinned to the clean origin** via `jwt({ jwt: { issuer } })`. Left
    alone, `oauthProvider` derives it from `baseURL`, which includes `/api/auth`, while every RP
    is configured with `OIDC_ISSUER = {origin}` and fetches discovery from the root. OIDC requires
    those to match; strict clients reject the id_token otherwise. Callbacks now also carry `iss`
    (RFC 9207).

  **The client registry yesterday's work hand-wrote is deleted, and what replaced it is split.**
  `src/clients.ts` (id minting, secret rotation, comma-joined redirect URIs) is gone: the plugin
  ships create/rotate, and `clientPrivileges` in `src/auth.ts` admits only the `admin` role —
  while leaving unauthenticated RFC 7591 registration open, because it consults the hook only
  when a session is present. What stayed ours is what the plugin models differently: it treats a
  client as something a USER owns (`client.userId === session.user.id` on every mutating
  endpoint, and no `disabled` field at all), so listing, editing, disabling and removing are
  ours, or an operator could never withdraw an application someone else registered. Registering
  proxies the plugin's `SERVER_ONLY` admin endpoint — that variant can set `skip_consent`, which
  is a column now instead of a `trustedClients` entry in source, which is why the dashboard can
  offer it.

  **The demo relying party no longer ships a password.** `trustedClients` is gone as an option,
  and secrets are hashed at rest, so `substrat-demo-rp` / `demo-rp-secret-not-for-production` —
  resolved by every deployment, production included — is replaced by a per-boot registration
  whose minted credentials the dev server prints.

  Driven in a browser end to end, not only in vitest: registering a client through the dashboard,
  its secret shown once, then an authorize request landing a signed-out visitor on `/login`,
  signing in there, resuming to `/consent`, approving, and arriving at the relying party's
  callback with `code`, `state` and `iss`.

- Updated dependencies [e401927]
- Updated dependencies [04c61c1]
- Updated dependencies [d4c66ac]
- Updated dependencies [cabd449]
- Updated dependencies [6d71731]
- Updated dependencies [1c1f23c]
- Updated dependencies [b3c362d]
  - @substrat-run/contracts@0.88.0
  - @substrat-run/kernel@0.88.0
  - @substrat-run/adapter-sqlite@0.88.0
  - @substrat-run/vertical-host@0.88.0
  - @substrat-run/engine-protocol@0.11.4
  - @substrat-run/engine-invoicing@0.9.4
  - @substrat-run/engine-workorder@0.8.4

## 0.1.4

### Patch Changes

- Updated dependencies [b2dac1e]
  - @substrat-run/contracts@0.87.0
  - @substrat-run/engine-invoicing@0.9.3
  - @substrat-run/engine-protocol@0.11.3
  - @substrat-run/engine-workorder@0.8.3
  - @substrat-run/adapter-sqlite@0.87.0
  - @substrat-run/kernel@0.87.0
  - @substrat-run/vertical-host@0.87.0

## 0.1.3

### Patch Changes

- @substrat-run/contracts@0.86.0
- @substrat-run/kernel@0.86.0
- @substrat-run/adapter-sqlite@0.86.0
- @substrat-run/vertical-host@0.86.0
- @substrat-run/engine-invoicing@0.9.2
- @substrat-run/engine-protocol@0.11.2
- @substrat-run/engine-workorder@0.8.2

## 0.1.2

### Patch Changes

- @substrat-run/contracts@0.85.0
- @substrat-run/kernel@0.85.0
- @substrat-run/adapter-sqlite@0.85.0
- @substrat-run/vertical-host@0.85.0
- @substrat-run/engine-invoicing@0.9.1
- @substrat-run/engine-protocol@0.11.1
- @substrat-run/engine-workorder@0.8.1

## 0.1.1

### Patch Changes

- Updated dependencies [716a9df]
- Updated dependencies [5b7fbc0]
- Updated dependencies [892d611]
- Updated dependencies [946dd47]
- Updated dependencies [7548dde]
  - @substrat-run/contracts@0.84.0
  - @substrat-run/engine-workorder@0.8.0
  - @substrat-run/kernel@0.84.0
  - @substrat-run/adapter-sqlite@0.84.0
  - @substrat-run/vertical-host@0.84.0
  - @substrat-run/engine-invoicing@0.9.0
  - @substrat-run/engine-protocol@0.11.0

## 0.1.0

### Minor Changes

- 4f65106: A vertical's browser client is emitted from its model, and a generated file carries a gate.

  `demos/todo/app/src/api.ts` was 91 hand-written lines, and every fact in it already
  existed in `spec/model.ts`: the `List`/`Item`/`Share` interfaces are the entities'
  `fields`, the paths and methods are the `http` blocks, the request bodies are the `input`
  schemas. It was a second description of a declared thing — the defect this repo already
  refuses for the route table (`mountOperations`), the OpenAPI document (`lint:api`), the
  permission surface (`lint:permissions`) and the migrations.

  It drifted the way a second description does. #811 declared `todo/list-items` paged and
  #827 added two search reads; the client learned about neither, so the app rendered the
  first twenty items of a list as though that were the list, and shipped no search at all.
  Nothing was red, and nothing could be — there was no gate over a file a person maintained
  by remembering to.

  ## `renderClient` in `@substrat-run/model-emit`, `tools/client-emit.mts` around it

  The printer lives in the package because that is already the package's job — build-time
  tooling over a Substrat model, where `emitTables` turns entities into DDL. The tool keeps
  the sweep and the IO.

  The split is what makes it testable, and it needed to be. `--check` re-emits and compares,
  so it catches a client that fell BEHIND its model; it cannot catch a printer that has been
  confidently mis-spelling `z.array(z.union([...]))` since the day it was written — the
  emitted file and the re-emitted file agree perfectly, and both are wrong. 118 tests now
  assert exact strings for optionality (`a?: T`, never `a?: T | undefined`), parenthesised
  unions inside arrays, brands, pipes, discriminated unions, identity naming, every refusal,
  and a rendered client end to end.

  ## Opting in (`pnpm lint:client`)

  A vertical opts in from its `package.json`, naming its model and where the client lands.
  The output is **standalone TypeScript with no imports at all**. That is not tidiness: the
  app is a separate Vite package that depends on neither `@substrat-run/contracts` nor zod
  and must keep depending on neither, and a checked-in artifact that re-exports its meaning
  from another package is not reviewable in a diff.

  Types are matched **by identity** — `output: todoEntities.item.fields` is the same object,
  so it prints as `Item`, while an inline shape that happens to match an entity stays inline.
  A schema the printer cannot spell is exit 2 naming the operation and the field, never a
  silent `unknown`: a generated client that degrades to `any` is worse than the hand-written
  one it replaced, because the green light is now mechanical.

  It owns the paged wire shape once, so no SPA re-derives it — a `Page` reassembled from the
  entries body plus `Link` / `X-Total-Count` (#829), and `follow(next)` which re-bases the
  link's path onto whatever the client was configured to talk to.

  **The source may be a `defineOperations` bag or an `ApiCatalog`.** They carry the same five
  fields the emitter reads (`summary`, `input`, `output`, `http`, `paged`), so a vertical that
  documents its API already has most of what this needs; what it lacks is `output` and `http`
  per operation, not a migration.

  ## Three verticals

  |           | hand-maintained | now | removed |
  | --------- | --------------- | --- | ------- |
  | todo      | 91              | 33  | −58     |
  | callout   | 305             | 203 | −102    |
  | handlebar | 234             | 131 | −103    |

  What survives is only what no model declares: which principal a request carries, the error
  envelope each vertical picked in its own `app.onError`, the dev harness's `/cast`, and the
  handful of operations left deliberately unbound because they take an entity-agnostic
  `entityType` — binding `callout/timeline` or `protocol/list-for-entity` to a URL would let
  a caller name any entity at all.

  Callout and Handlebar compose three engines each, which the emitter reads as further
  operation bags (`defineEngineRoutes` returns the same objects with `http` attached). A
  composed engine keeps its prefix — `workorderGet` / `protocolGet` / `invoicingGet`, because
  three engines each declare `get` and renaming an engine's operation to suit a vertical's
  client is not a thing a vertical may do.

  ## What generating them found

  - **A live drift.** `bike-shop/price-list` declared `GET /price-list`; the server has always
    served `/prices`. Handlebar mounts by hand, so nothing checked, and the declaration was
    decorative. A client generated from it would have 404'd on its first request.
  - **Two latent runtime bugs**, both caught by the compiler because the generated type is the
    engine's real one. `ProtocolDetail.content` is a union — checklist **or** document — and
    both apps' hand-written interfaces declared only the checklist arm, so a document protocol
    would have thrown on `.sections` of undefined. `underlagLine.source_id` is nullable, and
    Handlebar's invoicing view linked through it unconditionally.
  - **Ten operations declared without an `http` block** (four in Callout, six in Handlebar),
    so each SPA hand-wrote calls to routes the vertical already served. Binding them is also
    what let both route tables become derived below; each new path was verified against the
    one the hand-written table served before it was replaced.
  - **A name shadow.** Callout and `engine-protocol` both export `instantiateProtocolInput`
    with different shapes. Harmless, but it is why the emitter resolves each configured export
    individually and refuses only a name it was actually asked for.

  ## Generated files carry three marks, or they are not generated

  CLAUDE.md now states it: the `.generated.ts` suffix, a header naming the producer and the
  source, and a `--check` re-emit in CI. Only the third enforces anything — "do not edit" is a
  request.

  `demos/todo/src/migrations.ts` becomes `src/migrations.generated.ts`, and the rename was the
  smaller half. `emit:migrations --check` only ever asked whether the JOURNAL was behind the
  model; it never asked whether the module still matched the journal, and it re-rendered the
  module only on the run that appended an entry. A hand-edit to shipped SQL therefore passed
  every check in the repo. It now re-renders every run and diffs.

  New CI steps: `pnpm lint:client --check` and `pnpm lint:migrations --check`.

  One exception is stated rather than hidden: a file generated from a REMOTE source cannot be
  re-emitted hermetically, so `rate-card.generated.ts` (models.dev) and `packages/psl/src/data.ts`
  (the public suffix list) carry the suffix and header plus a `GENERATED_AT` stamp instead of a
  gate. An in-repo source with no gate is a defect, not a style.

  ## Both hand-written route tables go too

  Callout's `src/routes.ts` (180 → 102) and Handlebar's route block in `src/server.ts`
  (129 lines → a `mountOperations` call) were the other half of the same duplication: every
  line restated a method and a path the operations already declare. The comments they had
  accumulated are the argument against them — one explaining that `/customers/search` must be
  registered before any `/customers/:id` route or Hono answers it with `id: 'search'`, another
  explaining that `limit` arrives as a string and must be coerced because the operation
  declares a number. Both are real, and `mountOperations` derives both from the same
  declarations (#785). A hand-written table has to remember.

  What stays hand-written in each is the two routes that supply a CONSTANT — `timeline` and
  `protocol/list-for-entity` both take an entity-agnostic `entityType`, and binding either
  would let a caller read the timeline, or the protocols, of anything in the scope.

  Callout's route-parity test is rewritten rather than kept. It existed to prove the
  derivation matched the hand-written table so the table could be replaced; now that
  `routes.ts` IS the derivation, that assertion is one thing equalling itself, and a test that
  cannot fail is worse than no test because it still reads like coverage. What replaces it is
  the part that was never tautological: the declared surface pinned as an exact list, the two
  exceptions still being served, and the static-before-parameter ordering.

  **One deliberate behaviour change.** Handlebar's pickup refusal now answers **409**, not 400. The engine declares that error's taxonomy code (#113) and `mountOperations` honours it;
  Handlebar's hand-written `onError` could not see the code and flattened everything
  unrecognised to 400. Both apps' `onError` now converts the mount's `HTTPException` back into
  their own `{ error }` body — Callout's previously returned `err.getResponse()`, whose body is
  Hono's, not `{ error }`, which the SPA reads off every failure.

  ## Verified

  Each client was driven against its own running server, not just typechecked: todo walks a
  45-item list across three pages with a correct total; Callout runs an order from creation
  through protocol sign to invoicing and refuses a portal user's write with a typed 403;
  Handlebar's pickup rule holds — `closeRepair` is refused until the customer counter-signs the
  tillståndsrapport, and succeeds after. Both were driven again after their route tables became
  derived: same lifecycle, same 403/404/400 envelopes, the `z.literal('workorder')` pin still
  holding against a caller who sends `entityType: 'customer'`, and `/customers/search` still
  reached rather than swallowed by its parameter sibling.

### Patch Changes

- Updated dependencies [ca3377d]
  - @substrat-run/contracts@0.83.0
  - @substrat-run/kernel@0.83.0
  - @substrat-run/adapter-sqlite@0.83.0
  - @substrat-run/vertical-host@0.83.0
  - @substrat-run/engine-invoicing@0.8.3
  - @substrat-run/engine-protocol@0.10.3
  - @substrat-run/engine-workorder@0.7.3

## 0.0.82

### Patch Changes

- Updated dependencies [885ccf8]
- Updated dependencies [31ab573]
  - @substrat-run/contracts@0.82.0
  - @substrat-run/engine-invoicing@0.8.2
  - @substrat-run/engine-protocol@0.10.2
  - @substrat-run/engine-workorder@0.7.2
  - @substrat-run/adapter-sqlite@0.82.0
  - @substrat-run/kernel@0.82.0

## 0.0.81

### Patch Changes

- Updated dependencies [9cfb99d]
  - @substrat-run/contracts@0.81.0
  - @substrat-run/kernel@0.81.0
  - @substrat-run/adapter-sqlite@0.81.0
  - @substrat-run/engine-invoicing@0.8.1
  - @substrat-run/engine-protocol@0.10.1
  - @substrat-run/engine-workorder@0.7.1

## 0.0.80

### Patch Changes

- Updated dependencies [f6174fb]
- Updated dependencies [83b0ca3]
  - @substrat-run/engine-invoicing@0.8.0
  - @substrat-run/engine-protocol@0.10.0
  - @substrat-run/engine-workorder@0.7.0
  - @substrat-run/contracts@0.80.0
  - @substrat-run/adapter-sqlite@0.80.0
  - @substrat-run/kernel@0.80.0

## 0.0.79

### Patch Changes

- Updated dependencies [48ddee6]
- Updated dependencies [43d67cb]
- Updated dependencies [bb32545]
  - @substrat-run/contracts@0.79.0
  - @substrat-run/kernel@0.79.0
  - @substrat-run/engine-invoicing@0.7.6
  - @substrat-run/engine-protocol@0.9.6
  - @substrat-run/engine-workorder@0.6.6
  - @substrat-run/adapter-sqlite@0.79.0

## 0.0.78

### Patch Changes

- Updated dependencies [d3c6d31]
  - @substrat-run/contracts@0.78.0
  - @substrat-run/engine-invoicing@0.7.5
  - @substrat-run/engine-protocol@0.9.5
  - @substrat-run/engine-workorder@0.6.5
  - @substrat-run/adapter-sqlite@0.78.0
  - @substrat-run/kernel@0.78.0

## 0.0.77

### Patch Changes

- Updated dependencies [cbc4538]
  - @substrat-run/contracts@0.77.0
  - @substrat-run/engine-invoicing@0.7.4
  - @substrat-run/engine-protocol@0.9.4
  - @substrat-run/engine-workorder@0.6.4
  - @substrat-run/adapter-sqlite@0.77.0
  - @substrat-run/kernel@0.77.0

## 0.0.76

### Patch Changes

- @substrat-run/contracts@0.76.0
- @substrat-run/kernel@0.76.0
- @substrat-run/adapter-sqlite@0.76.0
- @substrat-run/engine-invoicing@0.7.3
- @substrat-run/engine-protocol@0.9.3
- @substrat-run/engine-workorder@0.6.3

## 0.0.75

### Patch Changes

- Updated dependencies [89c2113]
  - @substrat-run/kernel@0.75.0
  - @substrat-run/adapter-sqlite@0.75.0
  - @substrat-run/engine-invoicing@0.7.2
  - @substrat-run/engine-protocol@0.9.2
  - @substrat-run/engine-workorder@0.6.2
  - @substrat-run/contracts@0.75.0

## 0.0.74

### Patch Changes

- Updated dependencies [f8bf35e]
  - @substrat-run/contracts@0.74.0
  - @substrat-run/engine-invoicing@0.7.1
  - @substrat-run/engine-protocol@0.9.1
  - @substrat-run/engine-workorder@0.6.1
  - @substrat-run/adapter-sqlite@0.74.0
  - @substrat-run/kernel@0.74.0

## 0.0.73

### Patch Changes

- Updated dependencies [da69ef5]
- Updated dependencies [3b8533d]
  - @substrat-run/engine-protocol@0.9.0
  - @substrat-run/engine-invoicing@0.7.0
  - @substrat-run/contracts@0.73.0
  - @substrat-run/engine-workorder@0.6.0
  - @substrat-run/adapter-sqlite@0.73.0
  - @substrat-run/kernel@0.73.0

## 0.0.72

### Patch Changes

- Updated dependencies [f869541]
- Updated dependencies [f869541]
- Updated dependencies [19fb697]
- Updated dependencies [f869541]
- Updated dependencies [717600e]
- Updated dependencies [46b1cac]
- Updated dependencies [9208b4e]
  - @substrat-run/kernel@0.72.0
  - @substrat-run/adapter-sqlite@0.72.0
  - @substrat-run/contracts@0.72.0
  - @substrat-run/engine-workorder@0.5.0
  - @substrat-run/engine-protocol@0.8.0
  - @substrat-run/engine-invoicing@0.6.3

## 0.0.71

### Patch Changes

- Updated dependencies [ce44df8]
- Updated dependencies [ce44df8]
  - @substrat-run/contracts@0.71.0
  - @substrat-run/engine-invoicing@0.6.2
  - @substrat-run/engine-protocol@0.7.3
  - @substrat-run/engine-workorder@0.4.3
  - @substrat-run/adapter-sqlite@0.71.0
  - @substrat-run/kernel@0.71.0

## 0.0.70

### Patch Changes

- Updated dependencies [9bb7975]
  - @substrat-run/contracts@0.70.0
  - @substrat-run/engine-invoicing@0.6.1
  - @substrat-run/engine-protocol@0.7.2
  - @substrat-run/engine-workorder@0.4.2
  - @substrat-run/adapter-sqlite@0.70.0
  - @substrat-run/kernel@0.70.0

## 0.0.69

### Patch Changes

- Updated dependencies [17a82ec]
  - @substrat-run/contracts@0.69.0
  - @substrat-run/engine-invoicing@0.6.0
  - @substrat-run/engine-protocol@0.7.1
  - @substrat-run/engine-workorder@0.4.1
  - @substrat-run/adapter-sqlite@0.69.0
  - @substrat-run/kernel@0.69.0

## 0.0.68

### Patch Changes

- 2421781: Handlebar declares all eleven operations and binds every handler.

  The second adopter of `defineOperations`, and the first that could declare its
  whole surface on the first pass: every engine type it returns — `workOrder`,
  `billableLine`, `protocolInstanceRow`, `money` — already has an exported schema,
  so nothing here transcribes an engine's shape.

  `CustomerRow` and `BikeRow` are now derived from the entity registry rather than
  hand-written beside it, and `startConditionReportInput` moved next to the
  declaration so the model and the handler share one object.

- Updated dependencies [60789c8]
- Updated dependencies [aaf41b8]
- Updated dependencies [701de69]
- Updated dependencies [a05cd4d]
- Updated dependencies [b9dbda9]
- Updated dependencies [4eb532b]
- Updated dependencies [09852a9]
  - @substrat-run/contracts@0.68.0
  - @substrat-run/engine-protocol@0.7.0
  - @substrat-run/engine-workorder@0.4.0
  - @substrat-run/kernel@0.68.0
  - @substrat-run/adapter-sqlite@0.68.0
  - @substrat-run/engine-invoicing@0.5.24

## 0.0.67

### Patch Changes

- Updated dependencies [5601fa9]
- Updated dependencies [81a8c62]
- Updated dependencies [746a885]
- Updated dependencies [ee95fd6]
  - @substrat-run/contracts@0.67.0
  - @substrat-run/kernel@0.67.0
  - @substrat-run/engine-invoicing@0.5.23
  - @substrat-run/engine-protocol@0.6.3
  - @substrat-run/engine-workorder@0.3.65
  - @substrat-run/adapter-sqlite@0.67.0

## 0.0.66

### Patch Changes

- Updated dependencies [954668b]
  - @substrat-run/kernel@0.66.0
  - @substrat-run/adapter-sqlite@0.66.0
  - @substrat-run/engine-invoicing@0.5.22
  - @substrat-run/engine-protocol@0.6.2
  - @substrat-run/engine-workorder@0.3.64
  - @substrat-run/contracts@0.66.0

## 0.0.65

### Patch Changes

- Updated dependencies [daae585]
  - @substrat-run/contracts@0.65.0
  - @substrat-run/engine-invoicing@0.5.21
  - @substrat-run/engine-protocol@0.6.1
  - @substrat-run/engine-workorder@0.3.63
  - @substrat-run/adapter-sqlite@0.65.0
  - @substrat-run/kernel@0.65.0

## 0.0.64

### Patch Changes

- Updated dependencies [c19e371]
- Updated dependencies [181e69b]
  - @substrat-run/contracts@0.64.0
  - @substrat-run/kernel@0.64.0
  - @substrat-run/adapter-sqlite@0.64.0
  - @substrat-run/engine-protocol@0.6.0
  - @substrat-run/engine-invoicing@0.5.20
  - @substrat-run/engine-workorder@0.3.62

## 0.0.63

### Patch Changes

- Updated dependencies [5e71e1c]
  - @substrat-run/kernel@0.63.0
  - @substrat-run/adapter-sqlite@0.63.0
  - @substrat-run/engine-invoicing@0.5.19
  - @substrat-run/engine-protocol@0.5.21
  - @substrat-run/engine-workorder@0.3.61
  - @substrat-run/contracts@0.63.0

## 0.0.62

### Patch Changes

- Updated dependencies [39807d7]
  - @substrat-run/contracts@0.62.0
  - @substrat-run/engine-invoicing@0.5.18
  - @substrat-run/engine-protocol@0.5.20
  - @substrat-run/engine-workorder@0.3.60
  - @substrat-run/adapter-sqlite@0.62.0
  - @substrat-run/kernel@0.62.0

## 0.0.61

### Patch Changes

- Updated dependencies [ee491fc]
  - @substrat-run/contracts@0.61.0
  - @substrat-run/engine-invoicing@0.5.17
  - @substrat-run/engine-protocol@0.5.19
  - @substrat-run/engine-workorder@0.3.59
  - @substrat-run/adapter-sqlite@0.61.0
  - @substrat-run/kernel@0.61.0

## 0.0.60

### Patch Changes

- Updated dependencies [92e9e03]
- Updated dependencies [3ee5903]
  - @substrat-run/contracts@0.60.0
  - @substrat-run/adapter-sqlite@0.60.0
  - @substrat-run/engine-invoicing@0.5.16
  - @substrat-run/engine-protocol@0.5.18
  - @substrat-run/engine-workorder@0.3.58
  - @substrat-run/kernel@0.60.0

## 0.0.59

### Patch Changes

- @substrat-run/contracts@0.59.0
- @substrat-run/kernel@0.59.0
- @substrat-run/adapter-sqlite@0.59.0
- @substrat-run/engine-invoicing@0.5.15
- @substrat-run/engine-protocol@0.5.17
- @substrat-run/engine-workorder@0.3.57

## 0.0.58

### Patch Changes

- Updated dependencies [daab0d5]
- Updated dependencies [778f48a]
  - @substrat-run/contracts@0.58.0
  - @substrat-run/kernel@0.58.0
  - @substrat-run/adapter-sqlite@0.58.0
  - @substrat-run/engine-invoicing@0.5.14
  - @substrat-run/engine-protocol@0.5.16
  - @substrat-run/engine-workorder@0.3.56

## 0.0.57

### Patch Changes

- Updated dependencies [c9911ea]
  - @substrat-run/contracts@0.57.0
  - @substrat-run/engine-invoicing@0.5.13
  - @substrat-run/engine-protocol@0.5.15
  - @substrat-run/engine-workorder@0.3.55
  - @substrat-run/adapter-sqlite@0.57.0
  - @substrat-run/kernel@0.57.0

## 0.0.56

### Patch Changes

- Updated dependencies [4eb90ca]
- Updated dependencies [c1faa15]
  - @substrat-run/contracts@0.56.0
  - @substrat-run/kernel@0.56.0
  - @substrat-run/adapter-sqlite@0.56.0
  - @substrat-run/engine-invoicing@0.5.12
  - @substrat-run/engine-protocol@0.5.14
  - @substrat-run/engine-workorder@0.3.54

## 0.0.55

### Patch Changes

- @substrat-run/contracts@0.55.0
- @substrat-run/kernel@0.55.0
- @substrat-run/adapter-sqlite@0.55.0
- @substrat-run/engine-invoicing@0.5.11
- @substrat-run/engine-protocol@0.5.13
- @substrat-run/engine-workorder@0.3.53

## 0.0.54

### Patch Changes

- Updated dependencies [b387919]
- Updated dependencies [6ecb3c9]
- Updated dependencies [fa81319]
  - @substrat-run/contracts@0.54.0
  - @substrat-run/kernel@0.54.0
  - @substrat-run/adapter-sqlite@0.54.0
  - @substrat-run/engine-invoicing@0.5.10
  - @substrat-run/engine-protocol@0.5.12
  - @substrat-run/engine-workorder@0.3.52

## 0.0.53

### Patch Changes

- Updated dependencies [0148b77]
- Updated dependencies [88e2efa]
  - @substrat-run/adapter-sqlite@0.53.0
  - @substrat-run/contracts@0.53.0
  - @substrat-run/kernel@0.53.0
  - @substrat-run/engine-protocol@0.5.11
  - @substrat-run/engine-invoicing@0.5.9
  - @substrat-run/engine-workorder@0.3.51

## 0.0.52

### Patch Changes

- Updated dependencies [0e45268]
  - @substrat-run/contracts@0.52.0
  - @substrat-run/engine-invoicing@0.5.8
  - @substrat-run/engine-protocol@0.5.10
  - @substrat-run/engine-workorder@0.3.50
  - @substrat-run/adapter-sqlite@0.52.0
  - @substrat-run/kernel@0.52.0

## 0.0.51

### Patch Changes

- @substrat-run/contracts@0.51.0
- @substrat-run/kernel@0.51.0
- @substrat-run/adapter-sqlite@0.51.0
- @substrat-run/engine-invoicing@0.5.7
- @substrat-run/engine-protocol@0.5.9
- @substrat-run/engine-workorder@0.3.49

## 0.0.50

### Patch Changes

- Updated dependencies [fa85dd8]
- Updated dependencies [0061325]
- Updated dependencies [5063d1c]
- Updated dependencies [d7d8fa9]
  - @substrat-run/adapter-sqlite@0.50.0
  - @substrat-run/contracts@0.50.0
  - @substrat-run/kernel@0.50.0
  - @substrat-run/engine-protocol@0.5.8
  - @substrat-run/engine-invoicing@0.5.6
  - @substrat-run/engine-workorder@0.3.48

## 0.0.49

### Patch Changes

- Updated dependencies [a13c8fb]
- Updated dependencies [f11a961]
  - @substrat-run/contracts@0.49.0
  - @substrat-run/engine-invoicing@0.5.5
  - @substrat-run/engine-protocol@0.5.7
  - @substrat-run/engine-workorder@0.3.47
  - @substrat-run/adapter-sqlite@0.49.0
  - @substrat-run/kernel@0.49.0

## 0.0.48

### Patch Changes

- Updated dependencies [791e4fd]
  - @substrat-run/contracts@0.48.0
  - @substrat-run/kernel@0.48.0
  - @substrat-run/adapter-sqlite@0.48.0
  - @substrat-run/engine-invoicing@0.5.4
  - @substrat-run/engine-protocol@0.5.6
  - @substrat-run/engine-workorder@0.3.46

## 0.0.47

### Patch Changes

- Updated dependencies [6a7b4a8]
- Updated dependencies [a90dec0]
- Updated dependencies [0e48b8f]
- Updated dependencies [3fcf34b]
  - @substrat-run/kernel@0.47.0
  - @substrat-run/adapter-sqlite@0.47.0
  - @substrat-run/contracts@0.47.0
  - @substrat-run/engine-invoicing@0.5.3
  - @substrat-run/engine-protocol@0.5.5
  - @substrat-run/engine-workorder@0.3.45

## 0.0.46

### Patch Changes

- @substrat-run/contracts@0.46.0
- @substrat-run/kernel@0.46.0
- @substrat-run/adapter-sqlite@0.46.0
- @substrat-run/engine-invoicing@0.5.2
- @substrat-run/engine-protocol@0.5.4
- @substrat-run/engine-workorder@0.3.44

## 0.0.45

### Patch Changes

- Updated dependencies [846af24]
  - @substrat-run/contracts@0.45.0
  - @substrat-run/adapter-sqlite@0.45.0
  - @substrat-run/engine-invoicing@0.5.1
  - @substrat-run/engine-protocol@0.5.3
  - @substrat-run/engine-workorder@0.3.43
  - @substrat-run/kernel@0.45.0

## 0.0.44

### Patch Changes

- Updated dependencies [3246681]
- Updated dependencies [2314d79]
  - @substrat-run/kernel@0.44.0
  - @substrat-run/adapter-sqlite@0.44.0
  - @substrat-run/engine-invoicing@0.5.0
  - @substrat-run/engine-protocol@0.5.2
  - @substrat-run/engine-workorder@0.3.42
  - @substrat-run/contracts@0.44.0

## 0.0.43

### Patch Changes

- @substrat-run/contracts@0.43.0
- @substrat-run/kernel@0.43.0
- @substrat-run/adapter-sqlite@0.43.0
- @substrat-run/engine-invoicing@0.4.3
- @substrat-run/engine-protocol@0.5.1
- @substrat-run/engine-workorder@0.3.41

## 0.0.42

### Patch Changes

- Updated dependencies [b0355b4]
- Updated dependencies [b0355b4]
  - @substrat-run/kernel@0.42.0
  - @substrat-run/adapter-sqlite@0.42.0
  - @substrat-run/engine-protocol@0.5.0
  - @substrat-run/engine-invoicing@0.4.2
  - @substrat-run/engine-workorder@0.3.40
  - @substrat-run/contracts@0.42.0

## 0.0.41

### Patch Changes

- Updated dependencies [e9c7bd0]
- Updated dependencies [d222905]
  - @substrat-run/adapter-sqlite@0.41.0
  - @substrat-run/contracts@0.41.0
  - @substrat-run/kernel@0.41.0
  - @substrat-run/engine-protocol@0.4.33
  - @substrat-run/engine-invoicing@0.4.1
  - @substrat-run/engine-workorder@0.3.39

## 0.0.40

### Patch Changes

- Updated dependencies [d96269e]
- Updated dependencies [3c77f64]
- Updated dependencies [5a9d7bd]
- Updated dependencies [d59a515]
  - @substrat-run/kernel@0.40.0
  - @substrat-run/adapter-sqlite@0.40.0
  - @substrat-run/contracts@0.40.0
  - @substrat-run/engine-invoicing@0.4.0
  - @substrat-run/engine-protocol@0.4.32
  - @substrat-run/engine-workorder@0.3.38

## 0.0.39

### Patch Changes

- Updated dependencies [3cf4e3b]
  - @substrat-run/contracts@0.39.0
  - @substrat-run/adapter-sqlite@0.39.0
  - @substrat-run/engine-invoicing@0.3.37
  - @substrat-run/engine-protocol@0.4.31
  - @substrat-run/engine-workorder@0.3.37
  - @substrat-run/kernel@0.39.0

## 0.0.38

### Patch Changes

- Updated dependencies [5afb162]
  - @substrat-run/contracts@0.38.0
  - @substrat-run/kernel@0.38.0
  - @substrat-run/adapter-sqlite@0.38.0
  - @substrat-run/engine-invoicing@0.3.36
  - @substrat-run/engine-protocol@0.4.30
  - @substrat-run/engine-workorder@0.3.36

## 0.0.37

### Patch Changes

- @substrat-run/contracts@0.37.0
- @substrat-run/kernel@0.37.0
- @substrat-run/adapter-sqlite@0.37.0
- @substrat-run/engine-invoicing@0.3.35
- @substrat-run/engine-protocol@0.4.29
- @substrat-run/engine-workorder@0.3.35

## 0.0.36

### Patch Changes

- @substrat-run/contracts@0.36.0
- @substrat-run/kernel@0.36.0
- @substrat-run/adapter-sqlite@0.36.0
- @substrat-run/engine-invoicing@0.3.34
- @substrat-run/engine-protocol@0.4.28
- @substrat-run/engine-workorder@0.3.34

## 0.0.35

### Patch Changes

- Updated dependencies [17eec41]
  - @substrat-run/contracts@0.35.0
  - @substrat-run/engine-invoicing@0.3.33
  - @substrat-run/engine-protocol@0.4.27
  - @substrat-run/engine-workorder@0.3.33
  - @substrat-run/adapter-sqlite@0.35.0
  - @substrat-run/kernel@0.35.0

## 0.0.34

### Patch Changes

- Updated dependencies [ab637f0]
  - @substrat-run/contracts@0.34.0
  - @substrat-run/kernel@0.34.0
  - @substrat-run/adapter-sqlite@0.34.0
  - @substrat-run/engine-invoicing@0.3.32
  - @substrat-run/engine-protocol@0.4.26
  - @substrat-run/engine-workorder@0.3.32

## 0.0.33

### Patch Changes

- Updated dependencies [6d3429e]
  - @substrat-run/contracts@0.33.0
  - @substrat-run/kernel@0.33.0
  - @substrat-run/adapter-sqlite@0.33.0
  - @substrat-run/engine-invoicing@0.3.31
  - @substrat-run/engine-protocol@0.4.25
  - @substrat-run/engine-workorder@0.3.31

## 0.0.32

### Patch Changes

- Updated dependencies [99af6b6]
- Updated dependencies [070f4dc]
  - @substrat-run/contracts@0.32.0
  - @substrat-run/kernel@0.32.0
  - @substrat-run/adapter-sqlite@0.32.0
  - @substrat-run/engine-invoicing@0.3.30
  - @substrat-run/engine-protocol@0.4.24
  - @substrat-run/engine-workorder@0.3.30

## 0.0.31

### Patch Changes

- Updated dependencies [fbf0704]
- Updated dependencies [41d01f6]
- Updated dependencies [50d9260]
- Updated dependencies [0e9eba7]
  - @substrat-run/contracts@0.31.0
  - @substrat-run/kernel@0.31.0
  - @substrat-run/adapter-sqlite@0.31.0
  - @substrat-run/engine-invoicing@0.3.29
  - @substrat-run/engine-protocol@0.4.23
  - @substrat-run/engine-workorder@0.3.29

## 0.0.30

### Patch Changes

- Updated dependencies [a698959]
- Updated dependencies [67be7c7]
- Updated dependencies [91a60e2]
  - @substrat-run/contracts@0.30.0
  - @substrat-run/kernel@0.30.0
  - @substrat-run/adapter-sqlite@0.30.0
  - @substrat-run/engine-invoicing@0.3.28
  - @substrat-run/engine-protocol@0.4.22
  - @substrat-run/engine-workorder@0.3.28

## 0.0.29

### Patch Changes

- @substrat-run/contracts@0.29.0
- @substrat-run/kernel@0.29.0
- @substrat-run/adapter-sqlite@0.29.0
- @substrat-run/engine-invoicing@0.3.27
- @substrat-run/engine-protocol@0.4.21
- @substrat-run/engine-workorder@0.3.27

## 0.0.28

### Patch Changes

- @substrat-run/contracts@0.28.0
- @substrat-run/kernel@0.28.0
- @substrat-run/adapter-sqlite@0.28.0
- @substrat-run/engine-invoicing@0.3.26
- @substrat-run/engine-protocol@0.4.20
- @substrat-run/engine-workorder@0.3.26

## 0.0.27

### Patch Changes

- Updated dependencies [6901c16]
  - @substrat-run/contracts@0.27.0
  - @substrat-run/kernel@0.27.0
  - @substrat-run/adapter-sqlite@0.27.0
  - @substrat-run/engine-invoicing@0.3.25
  - @substrat-run/engine-protocol@0.4.19
  - @substrat-run/engine-workorder@0.3.25

## 0.0.26

### Patch Changes

- Updated dependencies [2bdd22b]
  - @substrat-run/contracts@0.26.0
  - @substrat-run/kernel@0.26.0
  - @substrat-run/adapter-sqlite@0.26.0
  - @substrat-run/engine-invoicing@0.3.24
  - @substrat-run/engine-protocol@0.4.18
  - @substrat-run/engine-workorder@0.3.24

## 0.0.25

### Patch Changes

- Updated dependencies [e612b98]
- Updated dependencies [caedb1c]
- Updated dependencies [f0df69a]
  - @substrat-run/contracts@0.25.0
  - @substrat-run/kernel@0.25.0
  - @substrat-run/adapter-sqlite@0.25.0
  - @substrat-run/engine-invoicing@0.3.23
  - @substrat-run/engine-protocol@0.4.17
  - @substrat-run/engine-workorder@0.3.23

## 0.0.24

### Patch Changes

- Updated dependencies [72b1128]
- Updated dependencies [1cfce31]
- Updated dependencies [aa503c2]
- Updated dependencies [5a3ef82]
- Updated dependencies [4c275df]
- Updated dependencies [d4bf108]
  - @substrat-run/contracts@0.24.0
  - @substrat-run/kernel@0.24.0
  - @substrat-run/adapter-sqlite@0.24.0
  - @substrat-run/engine-invoicing@0.3.22
  - @substrat-run/engine-protocol@0.4.16
  - @substrat-run/engine-workorder@0.3.22

## 0.0.23

### Patch Changes

- Updated dependencies [6a86837]
  - @substrat-run/contracts@0.23.0
  - @substrat-run/engine-invoicing@0.3.21
  - @substrat-run/engine-protocol@0.4.15
  - @substrat-run/engine-workorder@0.3.21
  - @substrat-run/adapter-sqlite@0.23.0
  - @substrat-run/kernel@0.23.0

## 0.0.22

### Patch Changes

- Updated dependencies [bc6d0fa]
  - @substrat-run/contracts@0.22.0
  - @substrat-run/kernel@0.22.0
  - @substrat-run/adapter-sqlite@0.22.0
  - @substrat-run/engine-invoicing@0.3.20
  - @substrat-run/engine-protocol@0.4.14
  - @substrat-run/engine-workorder@0.3.20

## 0.0.21

### Patch Changes

- @substrat-run/contracts@0.21.0
- @substrat-run/kernel@0.21.0
- @substrat-run/adapter-sqlite@0.21.0
- @substrat-run/engine-invoicing@0.3.19
- @substrat-run/engine-protocol@0.4.13
- @substrat-run/engine-workorder@0.3.19

## 0.0.20

### Patch Changes

- Updated dependencies [d18d788]
- Updated dependencies [a39a024]
  - @substrat-run/contracts@0.20.0
  - @substrat-run/kernel@0.20.0
  - @substrat-run/adapter-sqlite@0.20.0
  - @substrat-run/engine-invoicing@0.3.18
  - @substrat-run/engine-protocol@0.4.12
  - @substrat-run/engine-workorder@0.3.18

## 0.0.19

### Patch Changes

- Updated dependencies [b4a6bee]
  - @substrat-run/contracts@0.19.0
  - @substrat-run/kernel@0.19.0
  - @substrat-run/adapter-sqlite@0.19.0
  - @substrat-run/engine-invoicing@0.3.17
  - @substrat-run/engine-protocol@0.4.11
  - @substrat-run/engine-workorder@0.3.17

## 0.0.18

### Patch Changes

- Updated dependencies [d18a247]
  - @substrat-run/contracts@0.18.0
  - @substrat-run/kernel@0.18.0
  - @substrat-run/adapter-sqlite@0.18.0
  - @substrat-run/engine-invoicing@0.3.16
  - @substrat-run/engine-protocol@0.4.10
  - @substrat-run/engine-workorder@0.3.16

## 0.0.17

### Patch Changes

- @substrat-run/contracts@0.17.0
- @substrat-run/kernel@0.17.0
- @substrat-run/adapter-sqlite@0.17.0
- @substrat-run/engine-invoicing@0.3.15
- @substrat-run/engine-protocol@0.4.9
- @substrat-run/engine-workorder@0.3.15

## 0.0.16

### Patch Changes

- Updated dependencies [b23c0a7]
- Updated dependencies [81e9408]
  - @substrat-run/contracts@0.16.0
  - @substrat-run/kernel@0.16.0
  - @substrat-run/adapter-sqlite@0.16.0
  - @substrat-run/engine-invoicing@0.3.14
  - @substrat-run/engine-protocol@0.4.8
  - @substrat-run/engine-workorder@0.3.14

## 0.0.15

### Patch Changes

- Updated dependencies [cd32011]
- Updated dependencies [ec89a88]
  - @substrat-run/adapter-sqlite@0.15.0
  - @substrat-run/contracts@0.15.0
  - @substrat-run/kernel@0.15.0
  - @substrat-run/engine-protocol@0.4.7
  - @substrat-run/engine-invoicing@0.3.13
  - @substrat-run/engine-workorder@0.3.13

## 0.0.14

### Patch Changes

- Updated dependencies [6a7768a]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
  - @substrat-run/contracts@0.14.0
  - @substrat-run/adapter-sqlite@0.14.0
  - @substrat-run/engine-invoicing@0.3.11
  - @substrat-run/engine-protocol@0.4.5
  - @substrat-run/engine-workorder@0.3.11
  - @substrat-run/kernel@0.14.0

## 0.0.13

### Patch Changes

- Updated dependencies [74c9d7b]
  - @substrat-run/kernel@0.13.0
  - @substrat-run/adapter-sqlite@0.13.0
  - @substrat-run/contracts@0.13.0
  - @substrat-run/engine-invoicing@0.3.10
  - @substrat-run/engine-protocol@0.4.4
  - @substrat-run/engine-workorder@0.3.10

## 0.0.12

### Patch Changes

- Updated dependencies [73c0cdb]
- Updated dependencies [1dff2bd]
- Updated dependencies [66e752b]
- Updated dependencies [0572a3b]
  - @substrat-run/contracts@0.12.0
  - @substrat-run/adapter-sqlite@0.12.0
  - @substrat-run/kernel@0.12.0
  - @substrat-run/engine-protocol@0.4.3
  - @substrat-run/engine-workorder@0.3.9
  - @substrat-run/engine-invoicing@0.3.9

## 0.0.11

### Patch Changes

- Updated dependencies [7e17b16]
- Updated dependencies [858912e]
- Updated dependencies [e4db6ed]
- Updated dependencies [e4db6ed]
  - @substrat-run/kernel@0.11.0
  - @substrat-run/adapter-sqlite@0.11.0
  - @substrat-run/contracts@0.11.0
  - @substrat-run/engine-invoicing@0.3.8
  - @substrat-run/engine-protocol@0.4.2
  - @substrat-run/engine-workorder@0.3.8

## 0.0.10

### Patch Changes

- Updated dependencies [9c1f0bb]
- Updated dependencies [113160a]
- Updated dependencies [3fb38da]
- Updated dependencies [2becfd5]
- Updated dependencies [d881f75]
  - @substrat-run/contracts@0.10.0
  - @substrat-run/kernel@0.10.0
  - @substrat-run/adapter-sqlite@0.10.0
  - @substrat-run/engine-invoicing@0.3.7
  - @substrat-run/engine-protocol@0.4.1
  - @substrat-run/engine-workorder@0.3.7

## 0.0.9

### Patch Changes

- Updated dependencies [3336a17]
- Updated dependencies [27872cc]
  - @substrat-run/engine-protocol@0.4.0
  - @substrat-run/kernel@0.9.0
  - @substrat-run/adapter-sqlite@0.9.0
  - @substrat-run/engine-invoicing@0.3.6
  - @substrat-run/engine-workorder@0.3.6
  - @substrat-run/contracts@0.9.0

## 0.0.8

### Patch Changes

- @substrat-run/contracts@0.8.0
- @substrat-run/kernel@0.8.0
- @substrat-run/adapter-sqlite@0.8.0
- @substrat-run/engine-invoicing@0.3.5
- @substrat-run/engine-protocol@0.3.6
- @substrat-run/engine-workorder@0.3.5

## 0.0.7

### Patch Changes

- Updated dependencies [c54637b]
- Updated dependencies [8c48c93]
- Updated dependencies [33fb5dd]
  - @substrat-run/contracts@0.7.0
  - @substrat-run/kernel@0.7.0
  - @substrat-run/adapter-sqlite@0.7.0
  - @substrat-run/engine-invoicing@0.3.4
  - @substrat-run/engine-protocol@0.3.5
  - @substrat-run/engine-workorder@0.3.4

## 0.0.6

### Patch Changes

- @substrat-run/contracts@0.6.0
- @substrat-run/kernel@0.6.0
- @substrat-run/adapter-sqlite@0.6.0
- @substrat-run/engine-invoicing@0.3.2
- @substrat-run/engine-protocol@0.3.3
- @substrat-run/engine-workorder@0.3.3

## 0.0.5

### Patch Changes

- @substrat-run/contracts@0.5.0
- @substrat-run/kernel@0.5.0
- @substrat-run/adapter-sqlite@0.5.0
- @substrat-run/engine-invoicing@0.3.1
- @substrat-run/engine-protocol@0.3.2
- @substrat-run/engine-workorder@0.3.2

## 0.0.4

### Patch Changes

- Updated dependencies [6900431]
- Updated dependencies [7e9fad6]
  - @substrat-run/contracts@0.4.0
  - @substrat-run/kernel@0.4.0
  - @substrat-run/adapter-sqlite@0.4.0
  - @substrat-run/engine-invoicing@0.3.0
  - @substrat-run/engine-protocol@0.3.1
  - @substrat-run/engine-workorder@0.3.1

## 0.0.3

### Patch Changes

- Updated dependencies [5dd4085]
  - @substrat-run/contracts@0.3.0
  - @substrat-run/kernel@0.3.0
  - @substrat-run/adapter-sqlite@0.3.0
  - @substrat-run/engine-workorder@0.3.0
  - @substrat-run/engine-invoicing@0.2.0
  - @substrat-run/engine-protocol@0.3.0

## 0.0.2

### Patch Changes

- Updated dependencies [604883b]
  - @substrat-run/contracts@0.2.0
  - @substrat-run/kernel@0.2.0
  - @substrat-run/adapter-sqlite@0.2.0
  - @substrat-run/engine-workorder@0.2.0
  - @substrat-run/engine-protocol@0.2.0
  - @substrat-run/engine-invoicing@0.1.1
