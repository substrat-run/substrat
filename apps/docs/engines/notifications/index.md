# Notifications engine

`@substrat-run/engine-notifications` turns an occasion your vertical names into email to the
people it concerns. It applies per-person preferences, renders escaped templates, and tracks
one delivery per occasion, topic and person.

## At a glance

| | |
|---|---|
| **Package** | `@substrat-run/engine-notifications` (not yet published to npm) |
| **Entitlement key** | `notifications` |
| **Composed** | by call: `notify(ctx, …)` inside your own transaction |
| **Owns** | the topics a scope has used, where each person's notifications go, which topics they muted or take as a digest, what is held for each digest, and what became of every delivery |
| **Emits** | `notifications.delivery-recorded`, `delivery-settled`, `preference-set`, `recipient-updated`, `topic-recorded`, `digest-sent`, `digest-failed`, `digest-quarantined`, `digest-released`, `digest-withdrawn` |
| **Consumes** | `email.sent`, `email.refused`, `email.dead-lettered`, which settle its deliveries |
| **Schedules** | `notifications/send-digests`, every 15 minutes, sending each person whose digest is due |
| **Permissions** | 3 (`notifications:self`, `notifications:read`, and `notifications:send-digests`, which only the digest schedule holds) |
| **Status** | product seed, used by the Handlebar demo |

## Calling it

```ts
import { notificationsModule, notify } from '@substrat-run/engine-notifications';

host.registerModule(notificationsModule);

// Your own consumer of a domain event:
'workorder.assigned': async (ctx, event) => {
  const { orderId, technician } = assignedPayload.parse(event.payload);
  notify(ctx, {
    topic: 'repair-assigned',
    description: 'A repair was assigned to you',
    dedupeKey: event.id,
    recipients: [technician],
    vars: { orderId },
    about: event.entity,
    template: { subject: 'New repair: {{orderId}}', text: 'You have repair {{orderId}}.' },
  });
},
```

The template is your vocabulary, so it stays in your code. `dedupeKey` names the occasion: from a
consumer, pass the event's id. The engine registers as one frozen constant, like every engine.

**Prerequisite: the vertical's `emailSender` grant.** `notify` writes its sends with the kernel's `requestEmail`, and the platform delivers those only for a vertical that staff have granted the email-sender capability (the console's `setVerticalEmailSender`). Without it, nothing fails at the call: every delivery is written `requested`, and then settles `refused` with reason `permission_denied` when the platform's outcome comes back.

**One topic, one declaration.** A topic's `description` and `required` are recorded from the call that uses it, and follow the latest caller, so a deploy that changes them updates the scope. Every call site for a topic must pass the same pair: two that disagree make the topic flip with whichever ran last, and a mute be refused or allowed accordingly. Keep each topic in one constant that its call sites spread, and change it there.

## What it guarantees

<CommunicationFlow kind="notifications" />

- **One delivery record per occasion and recipient.** A delivery is unique on (dedupe key,
  topic, person, channel), and a redelivered event finds its row instead of creating another
  send intent. Provider delivery is still at-least-once: if the provider accepts a message
  but recording the outcome fails, a retry can send the message again.
- **A mail is never sent blank.** A placeholder with no variable makes `notify` throw, which
  rolls back your transaction. From a consumer, the event dead-letters with the reason.
- **A value cannot be turned against the reader.** Variables are HTML-escaped in the HTML part
  and kept to one line in the subject.
- **A mute holds, except where it must not.** A topic passed as `required` cannot be switched off.
- **A digest is the person's choice, per topic.** A topic someone takes as `daily-digest` is
  held. Once their oldest held message is a day old, they get one mail of up to 50 held
  messages, tracked as one delivery. Nothing waits much longer than a day, and unless more than
  50 are held, that is one digest a day. A
  mute still wins over a digest, and a required topic always goes out at once. The digest adds
  no wording of its own: one held message goes out as it is, and several go out under the first
  one's subject with `(+N)`, each under its own subject, as one document.
- **A digest never crowds out mail that must not wait.** A scope holds a limited number of
  sends waiting for the platform. A digest pass takes at most the room left, less a reserve for
  immediate mail, and the rest goes out on the next passes.
- **A digest is bounded.** It carries at most 50 messages, oldest first. Any more follow in a
  later digest, once the oldest of them is a day old.
- **One person's trouble stays theirs.** A digest that cannot be written stays held and is
  reported, and never stops anyone else's. A held message that no longer reads is set aside
  and reported, so it never holds up the rest of that person's digest. It is read again daily
  and goes out once it reads, unless its topic has been switched off since.
- **A mute is checked again at send time.** A held message whose topic is switched off is
  withdrawn, never mailed, however it came to be held.
- **A person reads their own history, and only theirs.** `notifications/my-deliveries`, under
  `notifications:self`, pages the caller's deliveries, newest first. It takes no principal, so
  holding the key never reaches anyone else's rows. Its rows leave out the idempotency key and
  the platform's send-intent id, and show a `reason` only for a skipped delivery (muted, no
  address, held for a digest). The platform's outcome code on a refused or dead-lettered send is
  left to whoever reads the whole log.
- **An address never rides an event.** It lives on the engine's recipient row, which a subject
  erasure deletes. The same erasure cancels a send that is still held.

## What it will not do

- It does not talk to a mail provider. It writes the kernel's send intent, and the platform
  delivers it.
- It has no channels other than email yet. Digests are daily only. When one goes out depends
  on when that person's oldest message arrived, not on a chosen time of day.
- It sends no digest where nothing runs schedules, or where nothing drains the sends. On the
  hosted platform the scope sweeper runs the schedule and the control plane drains the sends.
  A self-hosted server must run `startPlatformSweeper` (or `runDueSchedules`) and drain its
  platform intents, or held messages wait.
- A topic appears on a person's preferences screen only once it has been used.
