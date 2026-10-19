# @substrat-run/engine-notifications

Notifications engine for [Substrat](https://github.com/substrat-run/substrat). It turns an
occasion a vertical names into email to the people it concerns, with per-person
preferences, escaped templates and tracked deliveries.

**Not published yet** (`private: true`). The Handlebar demo uses it in-repo until its first
release is set up.

## How a vertical uses it

The engine is composed **by call**. Register the module, then call `notify` inside your own
transaction wherever something is worth telling someone, usually your own consumer of a
domain event:

```ts
import { notificationsModule, notify } from '@substrat-run/engine-notifications';

host.registerModule(notificationsModule);

// In your module's `consumers`:
'workorder.assigned': async (ctx, event) => {
  const { orderId, technician } = assignedPayload.parse(event.payload); // your own parse
  notify(ctx, {
    topic: 'repair-assigned',
    description: 'A repair was assigned to you', // shown beside the switch
    dedupeKey: event.id, // a redelivered event mails nobody twice
    recipients: [technician], // principal ids, never addresses
    vars: { orderId },
    about: event.entity,
    template: { subject: 'New repair: {{orderId}}', text: 'You have repair {{orderId}}.' },
  });
},
```

`notify` checks no permission, like every by-call engine function: the caller checks first.

**Prerequisite: the vertical's `emailSender` grant.** `notify` writes its sends with the kernel's `requestEmail`, and the platform delivers those only for a vertical that staff have granted the email-sender capability (the console's `setVerticalEmailSender`). Without it, nothing fails at the call: every delivery is written `requested`, and then settles `refused` with reason `permission_denied` when the platform's outcome comes back.

## What it owns

- **Dispatch.** For each person, it writes one send intent with the kernel's `requestEmail`
  in the caller's transaction. The platform's drain delivers it through `adapter-email`.
  Nothing here talks to a provider.
- **Templates, rendered safely.** `{{name}}` placeholders are filled from `vars`. A value is
  HTML-escaped in the HTML part and kept to one line in the subject. A placeholder with no
  variable makes `notify` throw `validation_failed`, which rolls back the caller: from a
  consumer, the event dead-letters with the reason; from an operation, the operation fails.
  A blank mail is never sent.
- **Preferences.** Each person sets where their notifications go
  (`notifications/set-my-address`) and switches topics off (`notifications/set-my-preference`).
  A topic passed as `required` cannot be switched off. A topic is recorded the first time it
  is used, and that record is what a preferences screen lists.
- **Delivery tracking.** There is one row per (dedupe key, topic, person, channel), unique on
  those four. It moves from `requested` to `sent`, `refused` or `dead_lettered` when the
  platform's outcome event arrives. A delivery that was not sent on its own says why: `muted`,
  `no_address`, or `digest`.
- **Daily digests.** A person can take any topic that is not required as a daily digest
  (`notifications/set-my-preference` with `cadence: 'daily-digest'`). `notify` then records the
  occasion as `skipped` with reason `digest` and holds the rendered message.

  The engine's own schedule, `notifications/send-digests`, runs every 15 minutes
  (`DIGEST_TICK_MINUTES`) under the engine's system principal. A person is due once their oldest
  held message is a day old, so nothing waits much longer than a day, and a person with no more
  than 50 held gets one digest a day. When a digest is due depends on that person's activity,
  not on a clock.

  Each due person gets one mail of what is held for them, up to 50 messages, oldest first. That
  mail is one more delivery,
  under the reserved topic `@digest` (`DIGEST_TOPIC`), and it settles like any other. The
  occasions it carried are settled into it: still `skipped`/`digest`, now with a `settled_at`.
  `notifications.digest-sent` lists them.

  **Backlog limit.** A scope holds at most 32 sends waiting for the platform's drain
  (`MAX_PENDING_PLATFORM_REQUESTS`). A pass therefore sends to at most the room left, less
  `DIGEST_RESERVE` (8) slots kept for mail that must not wait. Everyone else stays held for the
  next pass, oldest first, so a backlog drains over a few passes. The pass never meets the
  cap's refusal.

  **Item limit.** One digest carries at most 50 occasions (`DIGEST_MAX_ITEMS`), oldest first.
  The rest stay held and are due by the same rule: once the oldest of them is a day old. That is
  on the very next pass if it already is. It is the one case where a person gets more than one
  digest a day.

  **Contained failures.** Each person's digest is its own `ctx.atomic`. If writing it fails (a
  send or a write that throws), nothing of it happened for that person. Their messages stay held
  and everyone else's digest still goes out. `notifications.digest-failed` and an error line say
  so, and their next attempt waits a day.

  **Unreadable rows.** A held row that no longer reads, because it left the published shape, is
  set aside rather than allowed to block the rest. It is marked `quarantined_at` and not sent.
  It counts toward nothing: not who is due, not a switch-off's withdrawal, not the stale-hold
  warning. Its occasion's delivery settles `skipped`/`quarantined`, and
  `notifications.digest-quarantined` and an error line name the occasions, never their
  content. The person's readable messages go out as usual.

  The cause may pass, for instance a rollback to a version that rejects what a newer one
  stored. So a set-aside row is read again once a day. When it reads, it is released: held
  again, its delivery back to `skipped`/`digest`, and `notifications.digest-released` names it.
  It then goes out in the person's next digest. If its person has switched the topic off in the
  meantime, it is withdrawn instead: deleted unsent, its delivery settled `skipped`/`muted`, and
  `notifications.digest-withdrawn` names it. A row that still does not read waits another day,
  and nothing is said again. An erasure of the person deletes set-aside rows with the
  rest.

  **Mutes and required topics.** A mute still wins: switching a topic off withdraws what is
  held for it, and those occasions' deliveries then read `skipped`/`muted`. The digest checks
  again as it composes: a held message whose topic is switched off is withdrawn, never mailed,
  whatever path brought it there. A required topic always goes out at once, and overrides a
  mute written before it became required. Mutes are per topic and channel; there is no mute
  for a whole channel.

  A digest adds no words of its own. A digest of one message is that message. A digest of
  several uses the first one's subject with `(+N)` and puts each message under its own subject,
  so the mail stays in the vertical's language. The result is one document. A message whose
  html is a whole document (`<!doctype html><html>…`) cannot nest, so its text part stands in.

  **Something must run the schedule.** On the hosted platform the scope sweeper does, once a
  scope's provision has granted the schedule's key: an install provisioned before this engine
  declared the schedule gets it from the reconcile that follows a promote. A self-hosted server
  must run `runDueSchedules` or `startPlatformSweeper`, as Handlebar's dev server does.

  **Something must drain the sends.** Room only comes back as the platform drains the scope's
  pending sends. On the hosted platform the control plane's sweep does this every 15 minutes. A
  scheduled pass gets no immediate drain kick, unlike an operation a request ran. A server that
  drains nothing, as Handlebar's dev server does not, fills its backlog: from then on every
  pass defers everyone and logs that it did.

  Wherever the schedule does not run or the sends do not drain, messages are held and nothing
  fails. A hold that finds a person's oldest message (set-aside rows aside) two days old writes
  a warning line, whatever the cause.

**One topic, one declaration.** A topic's `description` and `required` are recorded from the call that uses it, and follow the latest caller, so a deploy that changes them updates the scope. Every call site for a topic must pass the same pair: two that disagree make the topic flip with whichever ran last, and a mute be refused or allowed accordingly. Keep each topic in one constant that its call sites spread, and change it there.

## Personal data

Events carry principals, never addresses. The address lives on the engine's recipient row,
which a subject erasure deletes (K-46). The send intent carries the recipient as its
`subjectId`, so the same erasure cancels a send that is still waiting. A message held for a
digest is rendered mail addressed to the person, so the same erasure deletes it too. Its
occasion's delivery keeps reason `digest` with no `settled_at`, the way a cancelled send's keeps
`requested`: an erasure writes no event the engine could settle it from.

## Not yet

Channels other than email (SMS, push, in-app), tenant-edited or per-locale templates
(including a digest's own wording), quiet hours and a digest's time of day, digest cadences
other than daily, and a person's own delivery history. See K-47 for where this engine sits and
why it is not kernel code.

## Permissions

| Key | What it allows |
| --- | --- |
| `notifications:self` | Set where your own notifications go and which topics reach you |
| `notifications:read` | Read what became of every notification in the scope |
| `notifications:send-digests` | The digest schedule's key. The engine's system principal holds it. The manifest declares it `holder: 'system'`, so `lint:permissions` refuses a role or entity grant shape that grants it to a person |

## Licence

AGPL-3.0-only, or a commercial licence.
