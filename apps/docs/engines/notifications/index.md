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
| **Owns** | the topics a scope has used, where each person's notifications go, which topics they muted, and what became of every delivery |
| **Emits** | `notifications.delivery-recorded`, `delivery-settled`, `preference-set`, `recipient-updated`, `topic-recorded` |
| **Consumes** | `email.sent`, `email.refused`, `email.dead-lettered`, which settle its deliveries |
| **Permissions** | 2 (`notifications:self`, `notifications:read`) |
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

## What it guarantees

- **Nobody is mailed twice for one occasion.** A delivery is unique on (dedupe key, topic,
  person, channel), and a redelivered event finds its row.
- **A mail is never sent blank.** A placeholder with no variable makes `notify` throw, which
  rolls back your transaction. From a consumer, the event dead-letters with the reason.
- **A value cannot be turned against the reader.** Variables are HTML-escaped in the HTML part
  and kept to one line in the subject.
- **A mute holds, except where it must not.** A topic passed as `required` cannot be switched off.
- **An address never rides an event.** It lives on the engine's recipient row, which a subject
  erasure deletes. The same erasure cancels a send that is still held.

## What it will not do

- It does not talk to a mail provider. It writes the kernel's send intent, and the platform
  delivers it.
- It has no digests, and no channels other than email yet.
- A topic appears on a person's preferences screen only once it has been used.
