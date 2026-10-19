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
| **Emits** | `notifications.delivery-recorded`, `delivery-settled`, `preference-set`, `recipient-updated`, `topic-recorded`, `digest-sent` |
| **Consumes** | `email.sent`, `email.refused`, `email.dead-lettered`, which settle its deliveries |
| **Schedules** | `notifications/send-digests`, once a day |
| **Permissions** | 3 (`notifications:self`, `notifications:read`, and `notifications:send-digests`, which only the daily schedule holds) |
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
  held. Once a day they get one mail of everything held for them, tracked as one delivery. A
  mute still wins over a digest, and a required topic always goes out at once. The digest adds
  no wording of its own: one held message goes out as it is, and several go out under the first
  one's subject with `(+N)`, each under its own subject.
- **An address never rides an event.** It lives on the engine's recipient row, which a subject
  erasure deletes. The same erasure cancels a send that is still held.

## What it will not do

- It does not talk to a mail provider. It writes the kernel's send intent, and the platform
  delivers it.
- It has no channels other than email yet. Digests are daily only, and go out at the time of
  day the scope's schedule first ran.
- A topic appears on a person's preferences screen only once it has been used.
